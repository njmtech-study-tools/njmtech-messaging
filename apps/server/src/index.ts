import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  AuthLinkSchema, AuthRecoverSchema, AuthStartSchema, AuthVerifySchema, EmailRebindStartSchema,
  EmailRebindVerifySchema, HANDLE_RE, MAX_FILE_BYTES, PushRegisterSchema, SignedPrekeySchema,
  type AuthVerifyResponse, type DeviceRegistration, type PublicDevice, type PublicUser,
} from "@njm/shared/protocol";
import { normalizeCode, randomCode, verifyPrekey } from "@njm/shared/crypto";
import type { Env, Session } from "./env";
import { checkOtp, consumeOtp, issueOtp } from "./otp";
import { sendOtpEmail } from "./email";
import { inboundEmail, sweepMailboxes, tempmail } from "./mailbox";
import { pushDevice, type PushTarget } from "./push";
import { newId, now, rateLimit, sha256Hex, signJwt, timingSafeEqual, verifyJwt } from "./util";

export { UserInbox } from "./inbox-do";

const SESSION_TTL = 180 * 24 * 3600;
const MAX_DEVICES = 10;
const FILE_MAX_AGE_MS = 24 * 3600 * 1000;

type Vars = { session: Session };
const app = new Hono<{ Bindings: Env; Variables: Vars }>().basePath("/api");

// Bearer tokens only (no cookies) so a wildcard origin is safe and covers web, Capacitor and Electron.
app.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type", "X-File-Targets", "X-Mail-Authorization"], exposeHeaders: ["Retry-After"], maxAge: 86400 }));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal_error" }, 500);
});

app.get("/health", (c) => c.json({ ok: true }));

/* ---------------------------- Disposable inboxes ---------------------------- */
// Self-hosted, mail.tm-compatible (see mailbox.ts). mail.tm blocks Cloudflare Workers.
app.route("/tempmail", tempmail);
app.route("/inbound-email", inboundEmail);

/* ---------------------------------- Auth ---------------------------------- */

app.post("/auth/start", async (c) => {
  const parsed = AuthStartSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_email" }, 400);
  const email = parsed.data.email.toLowerCase();
  const r = await issueOtp(c.env, email);
  if ("error" in r) return c.json({ error: "cooldown" }, 429);
  const exists = await c.env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first();
  if (c.env.DEV_OTP_ECHO === "1") {
    console.log(`[dev] OTP for ${email}: ${r.code}`);
    if (c.env.RESEND_API_KEY) await sendOtpEmail(c.env, email, r.code);
    return c.json({ ok: true, existing: !!exists, devCode: r.code });
  }
  const sent = await sendOtpEmail(c.env, email, r.code);
  if (!sent.sent && sent.reason === "api_error") {
    console.error("OTP email failed", sent.message);
    return c.json({ error: "email_failed" }, 502);
  }
  return c.json({ ok: true, existing: !!exists });
});

app.get("/handles/:handle", async (c) => {
  const handle = c.req.param("handle").toLowerCase();
  if (!HANDLE_RE.test(handle)) return c.json({ available: false, reason: "invalid" });
  const row = await c.env.DB.prepare("SELECT 1 FROM users WHERE handle = ?").bind(handle).first();
  return c.json({ available: !row });
});

/* ------------------------------ Device helpers ------------------------------ */

const LINK_TTL = 600;

const hashCode = (code: string) => sha256Hex(`recovery:${normalizeCode(code)}`);

async function issueRecoveryCode(env: Env, userId: string): Promise<string> {
  const code = randomCode(4);
  await env.DB.prepare("UPDATE users SET recovery_hash = ? WHERE id = ?").bind(await hashCode(code), userId).run();
  return code;
}

type DeviceResult = { deviceId: string; token: string } | { error: string; status: 400 | 403 };

async function registerDevice(env: Env, userId: string, device: DeviceRegistration): Promise<DeviceResult> {
  if (!verifyPrekey(device.identityKey, device.prekey)) return { error: "bad_prekey_signature", status: 400 };
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE user_id = ?").bind(userId).first<number>("n");
  if ((count ?? 0) >= MAX_DEVICES) return { error: "too_many_devices", status: 403 };
  const deviceId = newId();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO devices (id, user_id, public_key, identity_key, prekey_id, prekey_sig, prekey_at, name, platform, created_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(deviceId, userId, device.prekey.publicKey, device.identityKey, device.prekey.id, device.prekey.signature, ts,
      device.name, device.platform, ts, ts)
    .run();
  return { deviceId, token: await signJwt({ sub: userId, did: deviceId }, env.JWT_SECRET, SESSION_TTL) };
}

/* ----------------------------- Email OTP sign-in ----------------------------- */

app.post("/auth/verify", async (c) => {
  const parsed = AuthVerifySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const { code, device } = parsed.data;
  const email = parsed.data.email.toLowerCase();
  const db = c.env.DB;
  if (!verifyPrekey(device.identityKey, device.prekey)) return c.json({ error: "bad_prekey_signature" }, 400);

  let user = await db.prepare("SELECT id, handle FROM users WHERE email = ?").bind(email).first<PublicUser>();
  const handle = parsed.data.handle?.toLowerCase();
  if (!user) {
    if (!handle) return c.json({ error: "handle_required" }, 400);
    if (await db.prepare("SELECT 1 FROM users WHERE handle = ?").bind(handle).first()) {
      return c.json({ error: "handle_taken" }, 409);
    }
  }

  if (!(await checkOtp(c.env, email, code))) return c.json({ error: "invalid_code" }, 401);
  await consumeOtp(c.env, email);

  let recoveryCode: string | undefined;
  if (!user) {
    user = { id: newId(), handle: handle! };
    await db.prepare("INSERT INTO users (id, handle, email, created_at) VALUES (?, ?, ?, ?)")
      .bind(user.id, user.handle, email, now())
      .run();
    recoveryCode = await issueRecoveryCode(c.env, user.id);
  }

  const r = await registerDevice(c.env, user.id, device);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  return c.json({ token: r.token, user, deviceId: r.deviceId, recoveryCode } satisfies AuthVerifyResponse);
});

/* ------------------- Recovery without the inbox (handle + code) ------------------- */

app.post("/auth/recover", async (c) => {
  const parsed = AuthRecoverSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const handle = parsed.data.handle.toLowerCase();
  if (!(await rateLimit(c.env, `recover:${handle}`, 5, 3600))) return c.json({ error: "rate_limited" }, 429);

  const row = await c.env.DB.prepare("SELECT id, handle, recovery_hash FROM users WHERE handle = ?")
    .bind(handle)
    .first<PublicUser & { recovery_hash: string | null }>();
  const supplied = await hashCode(parsed.data.recoveryCode);
  if (!row?.recovery_hash || !timingSafeEqual(row.recovery_hash, supplied)) return c.json({ error: "invalid_recovery_code" }, 401);

  const r = await registerDevice(c.env, row.id, parsed.data.device);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  // Single-use: the code that was just used is replaced.
  const recoveryCode = await issueRecoveryCode(c.env, row.id);
  return c.json({ token: r.token, user: { id: row.id, handle: row.handle }, deviceId: r.deviceId, recoveryCode } satisfies AuthVerifyResponse);
});

/* ---------------- Link a new device from an already signed-in one ---------------- */

app.post("/auth/link", async (c) => {
  const parsed = AuthLinkSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const ip = c.req.header("CF-Connecting-IP") ?? "local";
  if (!(await rateLimit(c.env, `link:${ip}`, 10, LINK_TTL))) return c.json({ error: "rate_limited" }, 429);

  const key = `link:${normalizeCode(parsed.data.code)}`;
  const userId = await c.env.KV.get(key);
  if (!userId) return c.json({ error: "invalid_link_code" }, 401);
  await c.env.KV.delete(key); // single use

  const user = await c.env.DB.prepare("SELECT id, handle FROM users WHERE id = ?").bind(userId).first<PublicUser>();
  if (!user) return c.json({ error: "invalid_link_code" }, 401);
  const r = await registerDevice(c.env, user.id, parsed.data.device);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  return c.json({ token: r.token, user, deviceId: r.deviceId } satisfies AuthVerifyResponse);
});

/* ----------------------------- Authenticated API ---------------------------- */

async function authenticate(env: Env, token: string | undefined | null): Promise<Session | null> {
  if (!token) return null;
  const s = await verifyJwt<Session>(token, env.JWT_SECRET);
  if (!s) return null;
  // Device must still exist (removed devices lose access immediately).
  const ok = await env.DB.prepare("SELECT 1 FROM devices WHERE id = ? AND user_id = ?").bind(s.did, s.sub).first();
  return ok ? s : null;
}

const authed = new Hono<{ Bindings: Env; Variables: Vars }>();
authed.use("*", async (c, next) => {
  const h = c.req.header("Authorization");
  const s = await authenticate(c.env, h?.startsWith("Bearer ") ? h.slice(7) : null);
  if (!s) return c.json({ error: "unauthorized" }, 401);
  c.set("session", s);
  await next();
});

authed.get("/me", async (c) => {
  const { sub } = c.get("session");
  const row = await c.env.DB.prepare("SELECT id, handle, email FROM users WHERE id = ?")
    .bind(sub)
    .first<PublicUser & { email: string }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  // email is the user's own bound inbox; devices use it to converge after an inbox swap.
  return c.json({ user: { id: row.id, handle: row.handle }, email: row.email });
});

/** New single-use recovery code; the previous one stops working. */
authed.post("/me/recovery-code", async (c) => {
  return c.json({ recoveryCode: await issueRecoveryCode(c.env, c.get("session").sub) });
});

/** Rebind the account to a new inbox (e.g. the temp inbox was deleted). Verified by OTP to the new address. */
authed.post("/me/email/start", async (c) => {
  const parsed = EmailRebindStartSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_email" }, 400);
  const email = parsed.data.email.toLowerCase();
  const taken = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
  if (taken && taken.id !== c.get("session").sub) return c.json({ error: "email_in_use" }, 409);
  const r = await issueOtp(c.env, email);
  if ("error" in r) return c.json({ error: "cooldown" }, 429);
  if (c.env.DEV_OTP_ECHO === "1") return c.json({ ok: true, devCode: r.code });
  const sent = await sendOtpEmail(c.env, email, r.code);
  if (!sent.sent && sent.reason === "api_error") {
    console.error("OTP email failed", sent.message);
    return c.json({ error: "email_failed" }, 502);
  }
  return c.json({ ok: true });
});

authed.post("/me/email/verify", async (c) => {
  const parsed = EmailRebindVerifySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const email = parsed.data.email.toLowerCase();
  if (!(await checkOtp(c.env, email, parsed.data.code))) return c.json({ error: "invalid_code" }, 401);
  await consumeOtp(c.env, email);
  try {
    await c.env.DB.prepare("UPDATE users SET email = ? WHERE id = ?").bind(email, c.get("session").sub).run();
  } catch {
    return c.json({ error: "email_in_use" }, 409);
  }
  return c.json({ ok: true });
});

/** Short-lived, single-use code that signs a new device into this account. */
authed.post("/devices/link-code", async (c) => {
  const code = randomCode(2, 4); // e.g. ABCD-EFGH (40 bits), 10 min, rate-limited
  await c.env.KV.put(`link:${normalizeCode(code)}`, c.get("session").sub, { expirationTtl: LINK_TTL });
  return c.json({ code, expiresIn: LINK_TTL });
});

/** Publish a rotated, identity-signed prekey for the calling device. */
authed.put("/devices/current/prekey", async (c) => {
  const { did } = c.get("session");
  const parsed = SignedPrekeySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const dev = await c.env.DB.prepare("SELECT identity_key, prekey_id FROM devices WHERE id = ?")
    .bind(did)
    .first<{ identity_key: string; prekey_id: number }>();
  if (!dev) return c.json({ error: "not_found" }, 404);
  if (!verifyPrekey(dev.identity_key, parsed.data)) return c.json({ error: "bad_prekey_signature" }, 400);
  if (parsed.data.id <= dev.prekey_id) return c.json({ error: "stale_prekey" }, 409);
  await c.env.DB.prepare("UPDATE devices SET public_key = ?, prekey_id = ?, prekey_sig = ?, prekey_at = ? WHERE id = ?")
    .bind(parsed.data.publicKey, parsed.data.id, parsed.data.signature, now(), did)
    .run();
  return c.json({ ok: true });
});

authed.delete("/me", async (c) => {
  const { sub } = c.get("session");
  const db = c.env.DB;
  await c.env.INBOX.get(c.env.INBOX.idFromName(sub)).purge();
  const { results: files } = await db.prepare("SELECT DISTINCT file_id FROM file_targets WHERE owner_id = ?").bind(sub).all<{ file_id: string }>();
  if (files.length && c.env.FILES) await c.env.FILES.delete(files.map((f) => `files/${f.file_id}`));
  await db.batch([
    db.prepare("DELETE FROM file_targets WHERE owner_id = ?").bind(sub),
    db.prepare("DELETE FROM devices WHERE user_id = ?").bind(sub),
    db.prepare("DELETE FROM users WHERE id = ?").bind(sub),
  ]);
  return c.json({ ok: true });
});

authed.get("/devices", async (c) => {
  const { sub, did } = c.get("session");
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, platform, created_at AS createdAt, last_seen AS lastSeen, push_kind AS push,
            identity_key AS identityKey, prekey_id AS prekeyId, prekey_at AS prekeyAt
     FROM devices WHERE user_id = ? ORDER BY created_at`,
  )
    .bind(sub)
    .all();
  return c.json({ devices: results, current: did });
});

authed.delete("/devices/:id", async (c) => {
  const { sub } = c.get("session");
  const id = c.req.param("id");
  const r = await c.env.DB.prepare("DELETE FROM devices WHERE id = ? AND user_id = ?").bind(id, sub).run();
  if (!r.meta.changes) return c.json({ error: "not_found" }, 404);
  await c.env.INBOX.get(c.env.INBOX.idFromName(sub)).removeDevice(id);
  return c.json({ ok: true });
});

authed.get("/users/by-handle/:handle", async (c) => {
  const user = await c.env.DB.prepare("SELECT id, handle FROM users WHERE handle = ?")
    .bind(c.req.param("handle").toLowerCase())
    .first<PublicUser>();
  return user ? c.json({ user }) : c.json({ error: "not_found" }, 404);
});

authed.get("/users/:id", async (c) => {
  const user = await c.env.DB.prepare("SELECT id, handle FROM users WHERE id = ?").bind(c.req.param("id")).first<PublicUser>();
  return user ? c.json({ user }) : c.json({ error: "not_found" }, 404);
});

authed.get("/users/:id/devices", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, identity_key, public_key, prekey_id, prekey_sig FROM devices WHERE user_id = ? AND identity_key IS NOT NULL",
  )
    .bind(c.req.param("id"))
    .all<{ id: string; identity_key: string; public_key: string; prekey_id: number; prekey_sig: string }>();
  const devices: PublicDevice[] = results.map((d) => ({
    id: d.id,
    identityKey: d.identity_key,
    prekey: { id: d.prekey_id, publicKey: d.public_key, signature: d.prekey_sig },
  }));
  return c.json({ devices });
});

/* ---------------------------------- Push ---------------------------------- */

app.get("/push/vapid", (c) => c.json({ publicKey: c.env.VAPID_PUBLIC_KEY ?? null }));

authed.post("/push/register", async (c) => {
  const { did } = c.get("session");
  const parsed = PushRegisterSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const p = parsed.data;
  const [kind, data] =
    p.kind === "fcm" ? ["fcm", p.token] : p.kind === "webpush" ? ["webpush", JSON.stringify(p.subscription)] : [null, null];
  await c.env.DB.prepare("UPDATE devices SET push_kind = ?, push_data = ?, last_seen = ? WHERE id = ?")
    .bind(kind, data, now(), did)
    .run();
  return c.json({ ok: true });
});

/** Sends a test notification to this device, so the user sees push working right after enabling it. */
authed.post("/push/test", async (c) => {
  const { did } = c.get("session");
  const d = await c.env.DB.prepare("SELECT id, push_kind, push_data FROM devices WHERE id = ?").bind(did).first<PushTarget>();
  if (!d?.push_kind) return c.json({ error: "not_registered" }, 409);
  const result = await pushDevice(c.env, d, {
    title: "Notifications are on",
    body: "You'll get a notification here when a new message arrives.",
    tag: "push-test",
    always: true,
  });
  return c.json({ ok: result === "ok", result });
});

/* ------------------------- Encrypted attachments (R2) ------------------------ */

authed.use("/files/*", async (c, next) => {
  if (!c.env.FILES) return c.json({ error: "attachments_unavailable" }, 503);
  await next();
});
authed.use("/files", async (c, next) => {
  if (!c.env.FILES) return c.json({ error: "attachments_unavailable" }, 503);
  await next();
});

authed.post("/files", async (c) => {
  const { sub } = c.get("session");
  const targets = (c.req.header("X-File-Targets") ?? "").split(",").filter(Boolean).slice(0, 32);
  if (!targets.length) return c.json({ error: "no_targets" }, 400);
  const len = Number(c.req.header("Content-Length") ?? "0");
  if (!len || len > MAX_FILE_BYTES + 64) return c.json({ error: "too_large" }, 413);
  const id = newId(16);
  await c.env.FILES!.put(`files/${id}`, c.req.raw.body!, { customMetadata: { owner: sub } });
  const ts = now();
  await c.env.DB.batch(
    targets.map((d) =>
      c.env.DB.prepare("INSERT INTO file_targets (file_id, device_id, owner_id, created_at) VALUES (?, ?, ?, ?)").bind(id, d, sub, ts),
    ),
  );
  return c.json({ id });
});

authed.get("/files/:id", async (c) => {
  const { did } = c.get("session");
  const id = c.req.param("id");
  const t = await c.env.DB.prepare("SELECT 1 FROM file_targets WHERE file_id = ? AND device_id = ?").bind(id, did).first();
  if (!t) return c.json({ error: "not_found" }, 404);
  const obj = await c.env.FILES!.get(`files/${id}`);
  if (!obj) return c.json({ error: "expired" }, 410);
  return new Response(obj.body, { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" } });
});

/** Called after a device has downloaded + decrypted a blob. Deleted once every target device is done. */
authed.post("/files/:id/ack", async (c) => {
  const { did } = c.get("session");
  const id = c.req.param("id");
  const db = c.env.DB;
  await db.prepare("UPDATE file_targets SET done = 1 WHERE file_id = ? AND device_id = ?").bind(id, did).run();
  const pending = await db.prepare("SELECT COUNT(*) AS n FROM file_targets WHERE file_id = ? AND done = 0").bind(id).first<number>("n");
  if (!pending) {
    await c.env.FILES!.delete(`files/${id}`);
    await db.prepare("DELETE FROM file_targets WHERE file_id = ?").bind(id).run();
  }
  return c.json({ ok: true });
});

app.route("/", authed);

/* -------------------------------- WebSocket -------------------------------- */

async function handleWebSocket(req: Request, env: Env): Promise<Response> {
  if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
  // Token travels as a WebSocket subprotocol ("njm", <jwt>) so it never appears in URLs/logs.
  const protocols = (req.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((s) => s.trim());
  const token = protocols.find((p) => p.split(".").length === 3) ?? new URL(req.url).searchParams.get("token");
  const s = await authenticate(env, token);
  if (!s) return new Response("unauthorized", { status: 401 });
  await env.DB.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").bind(now(), s.did).run();
  const headers = new Headers(req.headers);
  headers.set("X-User-Id", s.sub);
  headers.set("X-Device-Id", s.did);
  return env.INBOX.get(env.INBOX.idFromName(s.sub)).fetch(new Request(req.url, { headers }));
}

/* ------------------------------ Scheduled sweep ----------------------------- */

async function sweepFiles(env: Env) {
  if (!env.FILES) return;
  const cutoff = now() - FILE_MAX_AGE_MS;
  const { results } = await env.DB.prepare("SELECT DISTINCT file_id FROM file_targets WHERE created_at < ? LIMIT 500")
    .bind(cutoff)
    .all<{ file_id: string }>();
  if (!results.length) return;
  await env.FILES.delete(results.map((r) => `files/${r.file_id}`));
  await env.DB.batch(results.map((r) => env.DB.prepare("DELETE FROM file_targets WHERE file_id = ?").bind(r.file_id)));
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/api/ws") return handleWebSocket(req, env);
    return app.fetch(req, env, ctx);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(sweepFiles(env));
    ctx.waitUntil(sweepMailboxes(env));
  },
} satisfies ExportedHandler<Env>;
