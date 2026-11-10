/**
 * Messaging engine. Owns the relay socket, end-to-end encryption (signed envelopes to
 * rotating prekeys), identity-key pinning, key rotation, local persistence (IndexedDB
 * only), delivery acks, attachments, disappearing timers and own-device sync.
 */
import {
  decryptBlob, encryptBlob, EnvelopeError, MAX_FILE_BYTES, openEnvelopeJson, publicPrekey, rotateKeys,
  sealEnvelopeJson, verifyPrekey,
  type Envelope, type FileRef, type Payload, type PublicDevice, type PublicUser, type ServerFrame,
} from "@njm/shared";
import { db, preview, sweepExpired, type Contact, type Message } from "../db";
import { wsUrl } from "../config";
import { api, ApiError } from "./api";
import { saveIdentity, type Identity, type LocalPrekey } from "./storage";

export { preview };

type IncomingListener = (msg: Message, contact: Contact) => void;
type StatusListener = (s: ConnectionStatus) => void;
type IdentityListener = (id: Identity) => void;
export type ConnectionStatus = "connecting" | "online" | "offline";

const DEVICE_CACHE_MS = 60_000;
const MAINTENANCE_MS = 6 * 3600 * 1000;

class NoTrustedDevices extends Error {}

const newId = () => {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export function timerLabel(s: number): string {
  if (!s) return "off";
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

export class Messenger {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private stopped = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private sweeper?: ReturnType<typeof setInterval>;
  private maintenance?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private devices = new Map<string, { list: PublicDevice[]; at: number }>();
  private incoming = new Set<IncomingListener>();
  private statusListeners = new Set<StatusListener>();
  private identityListeners = new Set<IdentityListener>();
  private rotating: Promise<void> | null = null;
  status: ConnectionStatus = "offline";
  /** Conversation currently on screen (no unread bump / notification). */
  activePeer: string | null = null;

  constructor(public id: Identity) {}

  /* ------------------------------- lifecycle ------------------------------- */

  start() {
    this.stopped = false;
    this.connect();
    this.sweeper = setInterval(() => void sweepExpired(), 1000);
    void sweepExpired();
    this.maintenance = setInterval(() => void this.maintain(), MAINTENANCE_MS);
    void this.maintain();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.heartbeat);
    clearInterval(this.sweeper);
    clearInterval(this.maintenance);
    clearTimeout(this.reconnectTimer);
    this.ws?.close(1000);
    this.ws = null;
    this.setStatus("offline");
  }

  /** Reconnect immediately (app resumed / network back). */
  kick() {
    if (this.stopped) return;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    clearTimeout(this.reconnectTimer);
    this.attempts = 0;
    this.connect();
  }

  onIncoming(fn: IncomingListener) {
    this.incoming.add(fn);
    return () => this.incoming.delete(fn);
  }

  onStatus(fn: StatusListener) {
    this.statusListeners.add(fn);
    fn(this.status);
    return () => this.statusListeners.delete(fn);
  }

  /** Fires when keys, inbox or recovery code change (Settings re-renders from this). */
  onIdentity(fn: IdentityListener) {
    this.identityListeners.add(fn);
    return () => this.identityListeners.delete(fn);
  }

  async updateIdentity(patch: Partial<Identity>, opts: { sync?: boolean } = {}) {
    Object.assign(this.id, patch);
    await saveIdentity(this.id);
    this.identityListeners.forEach((fn) => fn(this.id));
    if (opts.sync) await this.syncOwnDevices({ all: true });
  }

  private setStatus(s: ConnectionStatus) {
    this.status = s;
    this.statusListeners.forEach((fn) => fn(s));
  }

  private connect() {
    this.setStatus("connecting");
    const ws = new WebSocket(wsUrl(), ["njm", this.id.token]);
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.setStatus("online");
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('{"t":"ping"}'), 25_000);
      void this.resendPending();
      void this.syncOwnDevices().catch(() => {});
    };
    ws.onmessage = (e) => {
      try {
        void this.onFrame(JSON.parse(e.data as string) as ServerFrame).catch((err) => console.warn("frame handling failed", err));
      } catch (err) {
        console.warn("bad frame", err);
      }
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      clearInterval(this.heartbeat);
      this.ws = null;
      this.setStatus("offline");
      if (this.stopped || e.code === 4001 || e.code === 4002) return;
      const delay = Math.min(30_000, 500 * 2 ** this.attempts++) + Math.random() * 500;
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
  }

  private sendFrame(frame: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  /* ----------------------------- key maintenance ----------------------------- */

  /** Periodic: rotate the prekey when due, destroy expired ones, share recovery data with new own devices. */
  async maintain() {
    try {
      await this.rotateKeys();
    } catch (e) {
      console.warn("key rotation deferred", e);
    }
    await this.syncOwnDevices().catch(() => {});
  }

  /**
   * Rotates this device's signed prekey (when due, or `force`) and publishes it.
   * The new key is persisted *before* publishing, so a crash can never leave the server
   * advertising a key we don't hold. Unpublished keys are retried on the next run.
   */
  rotateKeys(force = false): Promise<void> {
    if (this.rotating) return this.rotating;
    this.rotating = (async () => {
      const { keys, rotated, pruned } = rotateKeys(this.id.keys, { force });
      if (rotated) (rotated as LocalPrekey).published = false;
      if (rotated || pruned) await this.updateIdentity({ keys });
      const current = this.id.keys.prekeys[this.id.keys.prekeys.length - 1];
      if (current.published === false) {
        try {
          await api("/devices/current/prekey", { method: "PUT", json: publicPrekey(current) });
        } catch (e) {
          if (!(e instanceof ApiError && e.code === "stale_prekey")) throw e;
        }
        current.published = true;
        await this.updateIdentity({ keys: this.id.keys });
      }
    })().finally(() => (this.rotating = null));
    return this.rotating;
  }

  /* ---------------------------- devices & pinning ---------------------------- */

  /**
   * Fetches a user's devices, keeping only those whose prekey is signed by their identity
   * key AND whose identity key matches what we pinned the first time we saw the device.
   */
  private async getDevices(userId: string, force = false): Promise<PublicDevice[]> {
    const cached = this.devices.get(userId);
    if (!force && cached && Date.now() - cached.at < DEVICE_CACHE_MS) return cached.list;
    const { devices } = await api<{ devices: PublicDevice[] }>(`/users/${userId}/devices`);
    const trusted: PublicDevice[] = [];
    for (const d of devices) {
      if (!verifyPrekey(d.identityKey, d.prekey)) {
        console.warn("dropping device with invalid prekey signature", d.id);
        continue;
      }
      const pin = await db.pins.get(d.id);
      if (!pin) {
        const hadDevices = (await db.pins.where("userId").equals(userId).count()) > 0;
        await db.pins.put({ id: d.id, userId, identityKey: d.identityKey, firstSeen: Date.now() });
        const contact = userId !== this.id.user.id ? await db.contacts.get(userId) : undefined;
        if (hadDevices && contact) await this.systemNote(userId, `@${contact.handle} signed in on a new device`);
      } else if (pin.identityKey !== d.identityKey) {
        if (!pin.blocked) {
          await db.pins.update(d.id, { blocked: true });
          await this.systemNote(userId, "⚠️ A device presented a different identity key and was blocked");
        }
        continue;
      } else if (pin.blocked) {
        continue;
      }
      trusted.push(d);
    }
    this.devices.set(userId, { list: trusted, at: Date.now() });
    return trusted;
  }

  /** Every device that must receive a message to `peer`: theirs + my other devices. */
  private async targets(peer: string): Promise<PublicDevice[]> {
    const [theirs, mine] = await Promise.all([this.getDevices(peer, true), this.getDevices(this.id.user.id, true)]);
    if (!theirs.length) throw new NoTrustedDevices("recipient has no trusted devices");
    return [...theirs, ...mine.filter((d) => d.id !== this.id.deviceId)];
  }

  private seal(devices: PublicDevice[], payload: Payload): Envelope[] {
    return devices.map((d) => ({
      device: d.id,
      ...sealEnvelopeJson({
        senderIdentity: this.id.keys.identity,
        senderDevice: this.id.deviceId,
        recipientDevice: d.id,
        recipientPrekey: d.prekey,
        value: payload,
      }),
    }));
  }

  /** Shares inbox credentials + recovery code with own devices that don't have them yet. */
  async syncOwnDevices(opts: { all?: boolean } = {}) {
    if (!this.id.mailbox && !this.id.recoveryCode) return;
    const mine = (await this.getDevices(this.id.user.id, true)).filter((d) => d.id !== this.id.deviceId);
    const pending: PublicDevice[] = [];
    for (const d of mine) if (opts.all || !(await db.pins.get(d.id))?.synced) pending.push(d);
    if (!pending.length) return;
    const payload: Payload = {
      v: 1, kind: "sync", id: newId(), to: this.id.user.id, ttl: 0, sentAt: Date.now(),
      mailbox: this.id.mailbox, recoveryCode: this.id.recoveryCode,
    };
    if (this.sendFrame({ t: "send", id: payload.id, to: this.id.user.id, envelopes: this.seal(pending, payload) })) {
      await Promise.all(pending.map((d) => db.pins.update(d.id, { synced: true })));
    }
  }

  /** Polls own devices while a link code is displayed; syncs to the new device as soon as it appears. */
  async watchForNewDevice(signal: AbortSignal): Promise<boolean> {
    const known = new Set((await this.getDevices(this.id.user.id, true)).map((d) => d.id));
    while (!signal.aborted) {
      await new Promise((r) => setTimeout(r, 3000));
      if (signal.aborted) break;
      const now = await this.getDevices(this.id.user.id, true);
      if (now.some((d) => !known.has(d.id))) {
        await this.syncOwnDevices();
        return true;
      }
    }
    return false;
  }

  /* ------------------------------- outgoing ------------------------------- */

  async ensureContact(user: PublicUser, timer = 0): Promise<Contact> {
    const existing = await db.contacts.get(user.id);
    if (existing) return existing;
    const c: Contact = { id: user.id, handle: user.handle, timer, lastAt: Date.now(), lastText: "", unread: 0 };
    await db.contacts.put(c);
    await this.getDevices(user.id, true).catch(() => {}); // pin their identity keys now
    return c;
  }

  private async systemNote(peer: string, text: string) {
    if (!(await db.contacts.get(peer))) return;
    await db.messages.put({ id: newId(), peer, dir: "system", kind: "timer", text, sentAt: Date.now(), status: "received" });
  }

  private async dispatch(msg: Message) {
    await db.messages.put(msg);
    await db.contacts.update(msg.peer, { lastAt: msg.sentAt, lastText: preview(msg) });
    await this.transmit(msg);
  }

  private async transmit(msg: Message) {
    if (!msg.payload) return;
    try {
      const devices = await this.targets(msg.peer);
      if (!this.sendFrame({ t: "send", id: msg.id, to: msg.peer, envelopes: this.seal(devices, msg.payload) })) return; // stays pending
    } catch (e) {
      console.warn("send failed", e);
      if ((e instanceof ApiError && e.status === 404) || e instanceof NoTrustedDevices) {
        await db.messages.update(msg.id, { status: "failed" });
      }
    }
  }

  private async resendPending() {
    const pending = await db.messages.where("status").equals("pending").toArray();
    for (const m of pending.sort((a, b) => a.sentAt - b.sentAt)) await this.transmit(m);
  }

  async sendText(peer: string, text: string) {
    const contact = await db.contacts.get(peer);
    const ttl = contact?.timer ?? 0;
    const sentAt = Date.now();
    const id = newId();
    const payload: Payload = { v: 1, kind: "text", id, to: peer, text, ttl, sentAt };
    await this.dispatch({
      id, peer, dir: "out", kind: "text", text, sentAt, status: "pending", payload,
      expiresAt: ttl ? sentAt + ttl * 1000 : undefined,
    });
  }

  async sendFile(peer: string, file: File) {
    if (file.size > MAX_FILE_BYTES) throw new Error(`Files are limited to ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    const contact = await db.contacts.get(peer);
    const ttl = contact?.timer ?? 0;
    const sentAt = Date.now();
    const id = newId();
    const local: Message = {
      id, peer, dir: "out", kind: "file", sentAt, status: "pending",
      file: { name: file.name, mime: file.type || "application/octet-stream", size: file.size, blob: file, state: "uploading" },
      expiresAt: ttl ? sentAt + ttl * 1000 : undefined,
    };
    await db.messages.put(local);
    await db.contacts.update(peer, { lastAt: sentAt, lastText: preview(local) });
    try {
      const { key, nonce, ct } = encryptBlob(new Uint8Array(await file.arrayBuffer()));
      const targets = await this.targets(peer);
      const { id: fileId } = await api<{ id: string }>("/files", {
        method: "POST",
        body: ct as BodyInit,
        headers: { "Content-Type": "application/octet-stream", "X-File-Targets": targets.map((d) => d.id).join(",") },
      });
      const ref: FileRef = { id: fileId, key, nonce, name: file.name, mime: local.file!.mime, size: file.size };
      const payload: Payload = { v: 1, kind: "file", id, to: peer, file: ref, ttl, sentAt };
      await db.messages.update(id, { payload, file: { ...local.file!, state: "ready" } });
      await this.transmit({ ...local, payload });
    } catch (e) {
      console.warn("upload failed", e);
      await db.messages.update(id, { status: "failed", file: { ...local.file!, state: "error" } });
      throw e;
    }
  }

  async setTimer(peer: string, ttl: number) {
    await db.contacts.update(peer, { timer: ttl });
    const sentAt = Date.now();
    const id = newId();
    const payload: Payload = { v: 1, kind: "timer", id, to: peer, ttl, sentAt };
    await this.dispatch({
      id, peer, dir: "system", kind: "timer", sentAt, status: "pending", payload,
      text: `You set disappearing messages to ${timerLabel(ttl)}`,
    });
  }

  async resend(id: string) {
    const m = await db.messages.get(id);
    if (!m?.payload) return;
    await db.messages.update(id, { status: "pending" });
    await this.transmit(m);
  }

  /* ------------------------------- incoming ------------------------------- */

  private async onFrame(f: ServerFrame) {
    switch (f.t) {
      case "sent":
        await db.messages.where("id").equals(f.id).modify((m) => {
          m.status = "sent";
          delete m.payload; // ciphertext was accepted by the relay; plaintext copy not needed for resend
        });
        return;
      case "error":
        if (f.id) await db.messages.update(f.id, { status: "failed" });
        console.warn("relay error", f);
        return;
      case "msg":
        await this.receive(f);
        return;
    }
  }

  private async receive(f: Extract<ServerFrame, { t: "msg" }>) {
    let payload: Payload;
    try {
      let dev = (await this.getDevices(f.from)).find((d) => d.id === f.fromDevice);
      if (!dev) dev = (await this.getDevices(f.from, true)).find((d) => d.id === f.fromDevice);
      if (!dev) throw new Error("unknown or untrusted sender device");
      payload = openEnvelopeJson<Payload>({
        envelope: f,
        senderIdentityKey: dev.identityKey,
        senderDevice: f.fromDevice,
        recipientDevice: this.id.deviceId,
        recipientKeys: this.id.keys,
      });
      if (payload.v !== 1 || payload.id !== f.id) throw new Error("payload mismatch");
    } catch (e) {
      console.warn("dropping undecryptable message", f.id, e);
      if (e instanceof EnvelopeError && e.reason === "unknown_prekey" && f.from !== this.id.user.id) {
        await this.systemNote(f.from, "A message arrived after its encryption key was retired and couldn't be read");
      }
      this.sendFrame({ t: "ack", ids: [f.id] });
      return;
    }

    if (await db.messages.get(f.id)) {
      this.sendFrame({ t: "ack", ids: [f.id] });
      return;
    }

    const fromMe = f.from === this.id.user.id;

    if (payload.kind === "sync") {
      // Recovery material is only accepted from my own pinned, signature-verified devices.
      if (fromMe) {
        const patch: Partial<Identity> = {};
        if (payload.mailbox && payload.mailbox.address !== this.id.mailbox?.address) {
          // If two devices replaced a dead inbox concurrently, the address bound on the
          // server (last verified rebind) wins, so every device converges on it.
          const { email } = await api<{ email: string }>("/me");
          if (email === payload.mailbox.address.toLowerCase()) patch.mailbox = payload.mailbox;
        }
        if (payload.recoveryCode && payload.recoveryCode !== this.id.recoveryCode) patch.recoveryCode = payload.recoveryCode;
        if (Object.keys(patch).length) await this.updateIdentity(patch);
      }
      this.sendFrame({ t: "ack", ids: [f.id] });
      return;
    }

    const peerId = fromMe ? payload.to : f.from;
    let contact = await db.contacts.get(peerId);
    if (!contact) {
      const { user } = await api<{ user: PublicUser }>(`/users/${peerId}`);
      contact = await this.ensureContact(user, payload.ttl);
    }

    const now = Date.now();
    const base = { id: f.id, peer: peerId, sentAt: payload.sentAt, status: fromMe ? ("sent" as const) : ("received" as const) };
    const expiresAt = payload.ttl ? (fromMe ? payload.sentAt : now) + payload.ttl * 1000 : undefined;
    let msg: Message;

    if (payload.kind === "timer") {
      await db.contacts.update(peerId, { timer: payload.ttl });
      msg = {
        ...base, dir: "system", kind: "timer",
        text: `${fromMe ? "You" : "@" + contact.handle} set disappearing messages to ${timerLabel(payload.ttl)}`,
      };
    } else if (payload.kind === "text") {
      msg = { ...base, dir: fromMe ? "out" : "in", kind: "text", text: payload.text, expiresAt };
    } else {
      const r = payload.file;
      msg = {
        ...base, dir: fromMe ? "out" : "in", kind: "file", text: payload.text, expiresAt,
        file: { name: r.name, mime: r.mime, size: r.size, state: "downloading", ref: r },
      };
    }

    const visible = this.activePeer === peerId && document.visibilityState === "visible";
    await db.transaction("rw", db.messages, db.contacts, async () => {
      await db.messages.put(msg);
      await db.contacts.update(peerId, {
        lastAt: msg.sentAt,
        lastText: preview(msg),
        unread: !fromMe && !visible && msg.dir === "in" ? contact!.unread + 1 : contact!.unread,
      });
    });
    // Stored locally — the relay can now forget it.
    this.sendFrame({ t: "ack", ids: [f.id] });

    if (msg.kind === "file") void this.download(msg.id);
    if (!fromMe && msg.dir === "in" && !visible) {
      const c = (await db.contacts.get(peerId))!;
      this.incoming.forEach((fn) => fn(msg, c));
    }
  }

  async download(messageId: string) {
    const m = await db.messages.get(messageId);
    const ref = m?.file?.ref;
    if (!m || !ref) return;
    try {
      const ct = await api<ArrayBuffer>(`/files/${ref.id}`);
      const plain = decryptBlob(new Uint8Array(ct), ref.key, ref.nonce);
      const blob = new Blob([plain as BlobPart], { type: ref.mime });
      await db.messages.update(messageId, { file: { name: ref.name, mime: ref.mime, size: ref.size, blob, state: "ready" } });
      await api(`/files/${ref.id}/ack`, { method: "POST" }).catch(() => {});
    } catch (e) {
      const gone = e instanceof ApiError && (e.status === 404 || e.status === 410);
      await db.messages.update(messageId, {
        file: { name: ref.name, mime: ref.mime, size: ref.size, state: gone ? "expired" : "error", ref: gone ? undefined : ref },
      });
    }
  }

  async markRead(peer: string) {
    await db.contacts.update(peer, { unread: 0 });
  }
}
