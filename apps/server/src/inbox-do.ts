/**
 * UserInbox — one Durable Object per user.
 *
 * - Holds the user's live WebSocket connections (one per device, hibernatable).
 * - Relays end-to-end encrypted envelopes. Envelopes for offline devices sit in a
 *   transient queue (ciphertext only) and are deleted as soon as the device acks
 *   them, or when their TTL expires (alarm). Nothing is kept after delivery.
 * - Sends content-free push wake-ups to offline devices.
 */
import { DurableObject } from "cloudflare:workers";
import { ClientFrameSchema, MAX_QUEUE_TTL_SECONDS, type Envelope, type ServerFrame } from "@njm/shared/protocol";
import type { Env } from "./env";
import { pushDevice, type PushTarget } from "./push";

type EnvelopeBody = Omit<Envelope, "device">;

interface QueuedEnvelope extends EnvelopeBody {
  id: string;
  from: string;
  fromDevice: string;
  ts: number;
  exp: number;
}

export interface DeliverRequest {
  id: string;
  from: string;
  fromDevice: string;
  ttl: number;
  items: Envelope[];
}

interface SocketAttachment {
  userId: string;
  deviceId: string;
}

const PUSH_DEBOUNCE_MS = 15_000;
const qkey = (device: string, id: string) => `q:${device}:${id}`;

export class UserInbox extends DurableObject<Env> {
  private lastPush = new Map<string, number>();

  /** WebSocket upgrade. The Worker has already authenticated the device. */
  async fetch(request: Request): Promise<Response> {
    const userId = request.headers.get("X-User-Id");
    const deviceId = request.headers.get("X-Device-Id");
    if (!userId || !deviceId) return new Response("bad request", { status: 400 });

    // A device has at most one live socket; close stale ones.
    for (const old of this.ctx.getWebSockets(deviceId)) old.close(4000, "replaced");

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [deviceId]);
    server.serializeAttachment({ userId, deviceId } satisfies SocketAttachment);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));

    await this.flush(deviceId, server);
    return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": "njm" } });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const att = ws.deserializeAttachment() as SocketAttachment;
    let frame;
    try {
      frame = ClientFrameSchema.parse(JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)));
    } catch {
      return send(ws, { t: "error", code: "bad_frame", message: "invalid frame" });
    }

    switch (frame.t) {
      case "ping":
        return send(ws, { t: "pong" });
      case "ack":
        await this.ctx.storage.delete(frame.ids.map((id) => qkey(att.deviceId, id)));
        return;
      case "send": {
        const err = await this.route(att, frame);
        return send(ws, err ? { t: "error", id: frame.id, code: err, message: err } : { t: "sent", id: frame.id });
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code, "closed");
    } catch {}
  }

  /** Validates recipients and forwards envelopes to the right inboxes. */
  private async route(
    att: SocketAttachment,
    frame: { id: string; to: string; envelopes: Envelope[]; ttl?: number },
  ): Promise<string | null> {
    const deviceIds = [...new Set(frame.envelopes.map((e) => e.device))];
    const placeholders = deviceIds.map(() => "?").join(",");
    const { results } = await this.env.DB.prepare(`SELECT id, user_id FROM devices WHERE id IN (${placeholders})`)
      .bind(...deviceIds)
      .all<{ id: string; user_id: string }>();
    const owner = new Map(results.map((r) => [r.id, r.user_id]));

    const byUser = new Map<string, DeliverRequest["items"]>();
    for (const e of frame.envelopes) {
      const u = owner.get(e.device);
      // Only the recipient's devices, or the sender's *other* devices (multi-device sync).
      if (!u || (u !== frame.to && u !== att.userId) || e.device === att.deviceId) continue;
      if (!byUser.has(u)) byUser.set(u, []);
      byUser.get(u)!.push(e);
    }
    if (!byUser.has(frame.to)) return "no_recipient_devices";

    const ttl = Math.min(frame.ttl ?? MAX_QUEUE_TTL_SECONDS, MAX_QUEUE_TTL_SECONDS);
    await Promise.all(
      [...byUser].map(([userId, items]) => {
        const req: DeliverRequest = { id: frame.id, from: att.userId, fromDevice: att.deviceId, ttl, items };
        return userId === att.userId
          ? this.deliver(req)
          : this.env.INBOX.get(this.env.INBOX.idFromName(userId)).deliver(req);
      }),
    );
    return null;
  }

  /** RPC: enqueue envelopes for this user's devices and push to the live ones. */
  async deliver(req: DeliverRequest): Promise<void> {
    const ts = Date.now();
    const exp = ts + req.ttl * 1000;
    const entries: Record<string, QueuedEnvelope> = {};
    const offline: string[] = [];

    for (const item of req.items) {
      const { device, ...body } = item;
      const q: QueuedEnvelope = { ...body, id: req.id, from: req.from, fromDevice: req.fromDevice, ts, exp };
      entries[qkey(device, req.id)] = q;
      const sockets = this.ctx.getWebSockets(device);
      if (sockets.length) sockets.forEach((ws) => send(ws, { t: "msg", ...pick(q) }));
      else offline.push(device);
    }
    await this.ctx.storage.put(entries);

    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > exp) await this.ctx.storage.setAlarm(exp);

    if (offline.length) this.ctx.waitUntil(this.pushOffline(offline));
  }

  private async pushOffline(deviceIds: string[]) {
    const due = deviceIds.filter((d) => (this.lastPush.get(d) ?? 0) + PUSH_DEBOUNCE_MS < Date.now());
    if (!due.length) return;
    due.forEach((d) => this.lastPush.set(d, Date.now()));
    const { results } = await this.env.DB.prepare(
      `SELECT id, push_kind, push_data FROM devices WHERE id IN (${due.map(() => "?").join(",")})`,
    )
      .bind(...due)
      .all<PushTarget>();
    await Promise.all(results.map((d) => pushDevice(this.env, d)));
  }

  private async flush(deviceId: string, ws: WebSocket) {
    this.lastPush.delete(deviceId);
    const items = await this.ctx.storage.list<QueuedEnvelope>({ prefix: `q:${deviceId}:` });
    const nowMs = Date.now();
    const live = [...items.values()].filter((q) => q.exp > nowMs).sort((a, b) => a.ts - b.ts);
    for (const q of live) send(ws, { t: "msg", ...pick(q) });
  }

  /** Purges expired, never-acked envelopes. */
  async alarm() {
    const nowMs = Date.now();
    const all = await this.ctx.storage.list<QueuedEnvelope>({ prefix: "q:" });
    const expired: string[] = [];
    let next = Infinity;
    for (const [k, v] of all) {
      if (v.exp <= nowMs) expired.push(k);
      else next = Math.min(next, v.exp);
    }
    for (let i = 0; i < expired.length; i += 128) await this.ctx.storage.delete(expired.slice(i, i + 128));
    if (next !== Infinity) await this.ctx.storage.setAlarm(next);
  }

  /** RPC: wipe everything (account deletion). */
  async purge(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) ws.close(4001, "account deleted");
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** RPC: drop a removed device's queue and socket. */
  async removeDevice(deviceId: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets(deviceId)) ws.close(4002, "device removed");
    const items = await this.ctx.storage.list({ prefix: `q:${deviceId}:` });
    const keys = [...items.keys()];
    for (let i = 0; i < keys.length; i += 128) await this.ctx.storage.delete(keys.slice(i, i + 128));
  }
}

function pick(q: QueuedEnvelope) {
  return { id: q.id, from: q.from, fromDevice: q.fromDevice, ts: q.ts, kid: q.kid, epk: q.epk, nonce: q.nonce, ct: q.ct, sig: q.sig };
}

function send(ws: WebSocket, frame: ServerFrame) {
  try {
    ws.send(JSON.stringify(frame));
  } catch {}
}
