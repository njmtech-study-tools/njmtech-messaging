/**
 * Self-hosted disposable inboxes with a mail.tm-compatible API, so the client's
 * temp-mail code works unchanged. mail.tm blocks requests from Cloudflare Workers,
 * so we host the inboxes ourselves:
 *
 *   Resend → inbox+<tag>@njmtech.co.za → Cloudflare Email Routing (subaddressing, rule
 *   for inbox@) → mail-relay Worker (apps/mail-relay) → POST /api/inbound-email → D1.
 *
 * Inboxes are password-protected (the client generates a random password), keep only
 * subject + a short text preview, and messages are deleted after 24 hours.
 */
import { Hono } from "hono";
import PostalMime from "postal-mime";
import type { Env } from "./env";
import { newId, now, rateLimit, sha256Hex, signJwt, timingSafeEqual, verifyJwt } from "./util";

export const MESSAGE_TTL_MS = 24 * 3600 * 1000;
/** Unused inboxes (not an account's email) are removed after this long. */
export const ORPHAN_TTL_MS = 24 * 3600 * 1000;
const TOKEN_TTL = 7 * 24 * 3600;
const MAX_RAW_BYTES = 512 * 1024;
const MAX_MESSAGES = 20;

const domain = (env: Env) => (env.INBOX_DOMAIN ?? "njmtech.co.za").toLowerCase();
const localBase = (env: Env) => (env.INBOX_LOCAL ?? "inbox").toLowerCase();
/** Addresses we host: inbox+<tag>@domain, with a client-generated random tag. */
export function isInboxAddress(env: Env, address: string): boolean {
  const re = new RegExp(`^${localBase(env)}\\+[a-z0-9]{6,40}@${domain(env).replace(/\./g, "\\.")}$`);
  return re.test(address);
}

const hashPassword = (pw: string) => sha256Hex(`mailbox:${pw}`);

interface MailToken {
  typ: "mail";
  mbx: string;
}

async function mailboxFromToken(env: Env, header: string | undefined): Promise<{ id: string; address: string } | null> {
  const token = header?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const claims = await verifyJwt<MailToken>(token, env.JWT_SECRET);
  if (!claims || claims.typ !== "mail") return null;
  return env.DB.prepare("SELECT id, address FROM mailboxes WHERE id = ?").bind(claims.mbx).first<{ id: string; address: string }>();
}

const hydra = <T>(items: T[]) => ({ "hydra:member": items, "hydra:totalItems": items.length });

export const tempmail = new Hono<{ Bindings: Env }>();

tempmail.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

tempmail.get("/domains", (c) =>
  // `prefix` tells current clients to build inbox+<tag>@domain. Older clients ignore it,
  // build <tag>@domain and get 422 from /accounts.
  c.json(hydra([{ id: "1", domain: domain(c.env), isActive: true, prefix: `${localBase(c.env)}+` }])),
);

tempmail.post("/accounts", async (c) => {
  const body = await c.req.json<{ address?: string; password?: string }>().catch(() => null);
  const address = body?.address?.trim().toLowerCase() ?? "";
  const password = body?.password ?? "";
  if (!isInboxAddress(c.env, address)) return c.json({ error: "invalid_address", detail: "address must be inbox+<tag>@domain" }, 422);
  if (password.length < 12 || password.length > 128) return c.json({ error: "invalid_password" }, 422);
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  if (!(await rateLimit(c.env, `mbx:${ip}`, 20, 3600))) return c.json({ error: "rate_limited" }, 429);
  const id = newId();
  const res = await c.env.DB.prepare("INSERT OR IGNORE INTO mailboxes (id, address, pw_hash, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, address, await hashPassword(password), now())
    .run();
  if (!res.meta.changes) return c.json({ error: "address_taken" }, 422);
  return c.json({ id, address }, 201);
});

tempmail.post("/token", async (c) => {
  const body = await c.req.json<{ address?: string; password?: string }>().catch(() => null);
  const address = body?.address?.trim().toLowerCase() ?? "";
  const box = await c.env.DB.prepare("SELECT id, pw_hash FROM mailboxes WHERE address = ?").bind(address).first<{ id: string; pw_hash: string }>();
  // Unknown addresses (including old mail.tm ones) → 401, which makes the app replace the inbox.
  if (!box || !timingSafeEqual(box.pw_hash, await hashPassword(body?.password ?? ""))) return c.json({ error: "invalid_credentials" }, 401);
  return c.json({ id: box.id, token: await signJwt({ typ: "mail", mbx: box.id }, c.env.JWT_SECRET, TOKEN_TTL) });
});

tempmail.get("/messages", async (c) => {
  const box = await mailboxFromToken(c.env, c.req.header("X-Mail-Authorization"));
  if (!box) return c.json({ error: "unauthorized" }, 401);
  const { results } = await c.env.DB.prepare(
    "SELECT id, from_addr, subject, intro, created_at FROM mailbox_messages WHERE mailbox_id = ? ORDER BY created_at DESC LIMIT ?",
  )
    .bind(box.id, MAX_MESSAGES)
    .all<{ id: string; from_addr: string | null; subject: string; intro: string; created_at: number }>();
  return c.json(
    hydra(
      results.map((m) => ({
        id: m.id,
        from: { address: m.from_addr ?? "" },
        to: [{ address: box.address }],
        subject: m.subject,
        intro: m.intro,
        seen: false,
        createdAt: new Date(m.created_at).toISOString(),
      })),
    ),
  );
});

tempmail.delete("/accounts/:id", async (c) => {
  const box = await mailboxFromToken(c.env, c.req.header("X-Mail-Authorization"));
  if (!box || box.id !== c.req.param("id")) return c.json({ error: "unauthorized" }, 401);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM mailbox_messages WHERE mailbox_id = ?").bind(box.id),
    c.env.DB.prepare("DELETE FROM mailboxes WHERE id = ?").bind(box.id),
  ]);
  return c.body(null, 204);
});

/** First ~200 characters of the plain-text body, whitespace collapsed. */
export function preview(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Receives raw mail from the mail-relay Worker (same pattern as the wealth-board brand-email relay). */
export const inboundEmail = new Hono<{ Bindings: Env }>();

inboundEmail.post("/", async (c) => {
  const secret = c.env.INBOUND_EMAIL_SECRET;
  if (!secret || !timingSafeEqual(c.req.header("X-Inbound-Secret") ?? "", secret)) return c.json({ error: "unauthorized" }, 401);
  const to = c.req.header("X-Envelope-To")?.trim().toLowerCase() ?? "";
  if (!isInboxAddress(c.env, to)) return c.json({ error: "no_mailbox" }, 404);
  const box = await c.env.DB.prepare("SELECT id FROM mailboxes WHERE address = ?").bind(to).first<{ id: string }>();
  if (!box) return c.json({ error: "no_mailbox" }, 404);

  const raw = await c.req.arrayBuffer();
  if (raw.byteLength > MAX_RAW_BYTES) return c.json({ error: "too_large" }, 413);
  const parsed = await PostalMime.parse(raw);
  const from = parsed.from?.address ?? c.req.header("X-Envelope-From") ?? null;

  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO mailbox_messages (id, mailbox_id, from_addr, subject, intro, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(
      newId(),
      box.id,
      from,
      (parsed.subject ?? "").slice(0, 300),
      preview(parsed.text),
      now(),
    ),
    // Keep only the newest MAX_MESSAGES per inbox.
    c.env.DB.prepare(
      "DELETE FROM mailbox_messages WHERE mailbox_id = ?1 AND id NOT IN (SELECT id FROM mailbox_messages WHERE mailbox_id = ?1 ORDER BY created_at DESC LIMIT ?2)",
    ).bind(box.id, MAX_MESSAGES),
  ]);
  return c.json({ ok: true });
});

/** Cron: drop messages older than 24h and inboxes nobody's account uses. */
export async function sweepMailboxes(env: Env): Promise<void> {
  const t = now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM mailbox_messages WHERE created_at < ?").bind(t - MESSAGE_TTL_MS),
    env.DB.prepare(
      "DELETE FROM mailbox_messages WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE created_at < ? AND address NOT IN (SELECT email FROM users))",
    ).bind(t - ORPHAN_TTL_MS),
    env.DB.prepare("DELETE FROM mailboxes WHERE created_at < ? AND address NOT IN (SELECT email FROM users)").bind(t - ORPHAN_TTL_MS),
  ]);
}
