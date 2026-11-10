/**
 * End-to-end tests against a running worker:
 *   pnpm dev   (with DEV_OTP_ECHO=1)   then   pnpm test:e2e
 */
import { describe, expect, it } from "vitest";
import {
  currentPrekey, generateDeviceKeys, openEnvelopeJson, publicPrekey, rotateKeys, sealEnvelopeJson,
  type DeviceKeys,
} from "@njm/shared/crypto";
import type { PublicDevice, ServerFrame } from "@njm/shared/protocol";

const BASE = process.env.E2E_URL;
const api = (p: string) => `${BASE}/api${p}`;
const rand = () => Math.random().toString(36).slice(2, 10);
const json = { "content-type": "application/json" };
type Msg = Extract<ServerFrame, { t: "msg" }>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const registration = (keys: DeviceKeys, name = "e2e") => ({
  identityKey: keys.identity.publicKey,
  prekey: publicPrekey(currentPrekey(keys)),
  name,
  platform: "web" as const,
});

interface Account {
  token: string;
  deviceId: string;
  user: { id: string; handle: string };
  keys: DeviceKeys;
  email: string;
  recoveryCode?: string;
}

const post = (path: string, body: unknown, token?: string) =>
  fetch(api(path), {
    method: "POST",
    headers: { ...json, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

async function signup(handle: string): Promise<Account> {
  const email = `${handle}@example.test`;
  const start = await (await post("/auth/start", { email })).json();
  expect(start.devCode).toMatch(/^\d{6}$/);
  const keys = generateDeviceKeys();
  const res = await post("/auth/verify", { email, code: start.devCode, handle, device: registration(keys) });
  expect(res.status).toBe(200);
  return { ...(await res.json()), keys, email };
}

function connect(token: string) {
  const ws = new WebSocket(`${BASE!.replace(/^http/, "ws")}/api/ws`, ["njm", token]);
  const frames: ServerFrame[] = [];
  let waiters: ((f: ServerFrame) => void)[] = [];
  ws.onmessage = (e) => {
    const f = JSON.parse(e.data as string) as ServerFrame;
    frames.push(f);
    const w = waiters;
    waiters = [];
    w.forEach((fn) => fn(f));
  };
  const next = (pred: (f: ServerFrame) => boolean, ms = 5000) =>
    new Promise<ServerFrame>((resolve, reject) => {
      const hit = frames.find(pred);
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error("timeout")), ms);
      const check = (f: ServerFrame) => {
        if (pred(f)) {
          clearTimeout(t);
          resolve(f);
        } else waiters.push(check);
      };
      waiters.push(check);
    });
  const opened = new Promise<void>((r, j) => {
    ws.onopen = () => r();
    ws.onerror = () => j(new Error("ws error"));
  });
  return { ws, next, opened, frames };
}

async function devicesOf(userId: string, token: string): Promise<PublicDevice[]> {
  return (await (await fetch(api(`/users/${userId}/devices`), { headers: { Authorization: `Bearer ${token}` } })).json()).devices;
}

function sealFor(from: Account, to: Account, dev: PublicDevice, value: unknown) {
  return {
    device: dev.id,
    ...sealEnvelopeJson({ senderIdentity: from.keys.identity, senderDevice: from.deviceId, recipientDevice: dev.id, recipientPrekey: dev.prekey, value }),
  };
}

function openFrom(m: Msg, me: Account, sender: Account) {
  return openEnvelopeJson({ envelope: m, senderIdentityKey: sender.keys.identity.publicKey, senderDevice: m.fromDevice, recipientDevice: me.deviceId, recipientKeys: me.keys });
}

describe.skipIf(!BASE)("relay e2e", () => {
  it("auth rejects bad codes, duplicate handles, forged prekeys and missing tokens", async () => {
    const h = `u_${rand()}`;
    const first = await signup(h);
    expect(first.recoveryCode).toMatch(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
    const email = `other_${rand()}@example.test`;
    const s = await (await post("/auth/start", { email })).json();
    const keys = generateDeviceKeys();
    expect((await post("/auth/verify", { email, code: s.devCode, handle: h, device: registration(keys) })).status).toBe(409);
    const wrong = s.devCode === "000000" ? "111111" : "000000";
    expect((await post("/auth/verify", { email, code: wrong, handle: `n_${rand()}`, device: registration(keys) })).status).toBe(401);
    // Prekey not signed by the presented identity key.
    const forged = { ...registration(keys), identityKey: generateDeviceKeys().identity.publicKey };
    expect((await post("/auth/verify", { email, code: s.devCode, handle: `n_${rand()}`, device: forged })).status).toBe(400);
    expect((await fetch(api("/me"))).status).toBe(401);
  });

  it("relays signed envelopes live and offline, deletes on ack", async () => {
    const alice = await signup(`a_${rand()}`);
    const bob = await signup(`b_${rand()}`);
    const [bobDev] = await devicesOf(bob.user.id, alice.token);
    expect(bobDev).toMatchObject({ id: bob.deviceId, identityKey: bob.keys.identity.publicKey, prekey: { id: 1 } });

    const a = connect(alice.token);
    await a.opened;
    a.ws.send(JSON.stringify({ t: "send", id: `m1_${rand()}`, to: bob.user.id, envelopes: [sealFor(alice, bob, bobDev, "hello offline")] }));
    await a.next((f) => f.t === "sent");

    let b = connect(bob.token);
    await b.opened;
    const m1 = (await b.next((f) => f.t === "msg")) as Msg;
    expect(openFrom(m1, bob, alice)).toBe("hello offline");

    const id2 = `m2_${rand()}`;
    a.ws.send(JSON.stringify({ t: "send", id: id2, to: bob.user.id, envelopes: [sealFor(alice, bob, bobDev, "hello live")] }));
    const m2 = (await b.next((f) => f.t === "msg" && f.id === id2)) as Msg;
    expect(openFrom(m2, bob, alice)).toBe("hello live");

    b.ws.send(JSON.stringify({ t: "ack", ids: [m1.id, id2] }));
    await sleep(300);
    b.ws.close();
    b = connect(bob.token);
    await b.opened;
    await sleep(500);
    expect(b.frames.filter((f) => f.t === "msg")).toHaveLength(0);

    a.ws.send(JSON.stringify({ t: "send", id: `m3_${rand()}`, to: bob.user.id, envelopes: [{ ...sealFor(alice, bob, bobDev, "x"), device: alice.deviceId }] }));
    expect(await a.next((f) => f.t === "error")).toMatchObject({ code: "no_recipient_devices" });
    a.ws.close();
    b.ws.close();
  });

  it("rotates prekeys: publishes signed key, rejects stale/forged, old in-flight messages still decrypt", async () => {
    const alice = await signup(`a_${rand()}`);
    const bob = await signup(`b_${rand()}`);
    const [oldDev] = await devicesOf(bob.user.id, alice.token);

    // Alice sends to Bob's prekey #1 while Bob is offline.
    const a = connect(alice.token);
    await a.opened;
    a.ws.send(JSON.stringify({ t: "send", id: `r1_${rand()}`, to: bob.user.id, envelopes: [sealFor(alice, bob, oldDev, "before rotation")] }));
    await a.next((f) => f.t === "sent");

    // Bob rotates.
    const { keys, rotated } = rotateKeys(bob.keys, { force: true });
    const put = (body: unknown) =>
      fetch(api("/devices/current/prekey"), { method: "PUT", headers: { ...json, Authorization: `Bearer ${bob.token}` }, body: JSON.stringify(body) });
    expect((await put({ ...publicPrekey(rotated!), signature: currentPrekey(generateDeviceKeys()).signature })).status).toBe(400);
    expect((await put(publicPrekey(rotated!))).status).toBe(200);
    expect((await put(publicPrekey(rotated!))).status).toBe(409); // ids must increase
    bob.keys = keys;

    const [newDev] = await devicesOf(bob.user.id, alice.token);
    expect(newDev.prekey.id).toBe(2);
    const id2 = `r2_${rand()}`;
    a.ws.send(JSON.stringify({ t: "send", id: id2, to: bob.user.id, envelopes: [sealFor(alice, bob, newDev, "after rotation")] }));
    await a.next((f) => f.t === "sent" && f.id === id2);

    const b = connect(bob.token);
    await b.opened;
    await b.next((f) => f.t === "msg" && f.id === id2);
    const msgs = b.frames.filter((f): f is Msg => f.t === "msg");
    expect(msgs.map((m) => m.kid).sort()).toEqual([1, 2]);
    expect(msgs.map((m) => openFrom(m, bob, alice)).sort()).toEqual(["after rotation", "before rotation"]);
    a.ws.close();
    b.ws.close();
  });

  it("recovers an account with handle + single-use recovery code (no inbox needed)", async () => {
    const acct = await signup(`r_${rand()}`);
    const keys = generateDeviceKeys();
    const bad = await post("/auth/recover", { handle: acct.user.handle, recoveryCode: "AAAAA-AAAAA-AAAAA-AAAAA", device: registration(keys) });
    expect(bad.status).toBe(401);
    const ok = await post("/auth/recover", { handle: acct.user.handle, recoveryCode: acct.recoveryCode, device: registration(keys, "recovered") });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.user.id).toBe(acct.user.id);
    expect(body.recoveryCode).not.toBe(acct.recoveryCode);
    // Used code no longer works; the new one does.
    expect((await post("/auth/recover", { handle: acct.user.handle, recoveryCode: acct.recoveryCode, device: registration(generateDeviceKeys()) })).status).toBe(401);
    expect((await post("/auth/recover", { handle: acct.user.handle, recoveryCode: body.recoveryCode.toLowerCase().replace(/-/g, " "), device: registration(generateDeviceKeys()) })).status).toBe(200);
  });

  it("links a new device with a single-use code from a signed-in device", async () => {
    const acct = await signup(`l_${rand()}`);
    const { code } = await (await post("/devices/link-code", {}, acct.token)).json();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const res = await post("/auth/link", { code, device: registration(generateDeviceKeys(), "linked") });
    expect(res.status).toBe(200);
    expect((await res.json()).user.id).toBe(acct.user.id);
    expect((await post("/auth/link", { code, device: registration(generateDeviceKeys()) })).status).toBe(401);
  });

  it("rebinds the account to a new inbox after OTP verification", async () => {
    const acct = await signup(`e_${rand()}`);
    const other = await signup(`o_${rand()}`);
    expect((await post("/me/email/start", { email: other.email }, acct.token)).status).toBe(409);
    const newEmail = `new_${rand()}@example.test`;
    const start = await (await post("/me/email/start", { email: newEmail }, acct.token)).json();
    expect((await post("/me/email/verify", { email: newEmail, code: start.devCode }, acct.token)).status).toBe(200);
    // The new address now belongs to this account (another account can't claim it)…
    expect((await post("/me/email/start", { email: newEmail }, other.token)).status).toBe(409);
    // …and the old address was released (not "in use"; it may still be in OTP cooldown).
    expect((await post("/me/email/start", { email: acct.email }, other.token)).status).not.toBe(409);
  });

  it("keeps encrypted files only until every target device acks", async () => {
    const alice = await signup(`a_${rand()}`);
    const bob = await signup(`b_${rand()}`);
    const blob = new Uint8Array([1, 2, 3, 4, 5]);
    const up = await (
      await fetch(api("/files"), {
        method: "POST",
        body: blob,
        headers: { Authorization: `Bearer ${alice.token}`, "X-File-Targets": bob.deviceId, "Content-Type": "application/octet-stream" },
      })
    ).json();
    expect((await fetch(api(`/files/${up.id}`), { headers: { Authorization: `Bearer ${alice.token}` } })).status).toBe(404);
    const got = await fetch(api(`/files/${up.id}`), { headers: { Authorization: `Bearer ${bob.token}` } });
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(blob);
    await fetch(api(`/files/${up.id}/ack`), { method: "POST", headers: { Authorization: `Bearer ${bob.token}` } });
    expect((await fetch(api(`/files/${up.id}`), { headers: { Authorization: `Bearer ${bob.token}` } })).status).toBe(404);
  });
});
