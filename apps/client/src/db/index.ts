import Dexie, { type Table } from "dexie";
import type { FileRef, Payload } from "@njm/shared";

export interface Contact {
  id: string; // user id
  handle: string;
  timer: number; // disappearing timer seconds (0 = off)
  lastAt: number;
  lastText: string;
  unread: number;
}

export type MessageStatus = "pending" | "sent" | "failed" | "received";

export interface LocalFile {
  name: string;
  mime: string;
  size: number;
  blob?: Blob;
  state: "uploading" | "downloading" | "ready" | "expired" | "error";
  ref?: FileRef; // kept only until downloaded
}

export interface Message {
  id: string;
  peer: string; // conversation = other user's id
  dir: "in" | "out" | "system";
  kind: "text" | "file" | "timer";
  text?: string;
  file?: LocalFile;
  sentAt: number;
  expiresAt?: number;
  status: MessageStatus;
  payload?: Payload; // outgoing only, kept until delivered to relay (for resend)
}

/** Trust-on-first-use pin of a device's identity key (stable across prekey rotation). */
export interface PinnedDevice {
  id: string; // device id
  userId: string;
  identityKey: string;
  firstSeen: number;
  blocked?: boolean; // identity key changed for this device id → refuse it
  synced?: boolean; // own devices: recovery material has been shared with it
}

class LocalDB extends Dexie {
  contacts!: Table<Contact, string>;
  messages!: Table<Message, string>;
  pins!: Table<PinnedDevice, string>;

  constructor() {
    super("ephemeral");
    this.version(1).stores({
      contacts: "&id, handle, lastAt",
      messages: "&id, [peer+sentAt], expiresAt, status",
    });
    this.version(2).stores({ pins: "&id, userId" });
  }
}

export const db = new LocalDB();

export function preview(m: Message): string {
  if (m.kind === "file") return `📎 ${m.file?.name ?? "Attachment"}`;
  return m.text ?? "";
}

/**
 * Delete expired disappearing messages and refresh affected chat previews so
 * no expired text lingers in the chat list. Returns number removed.
 */
export async function sweepExpired(now = Date.now()): Promise<number> {
  const expired = await db.messages.where("expiresAt").below(now).toArray();
  if (!expired.length) return 0;
  await db.transaction("rw", db.messages, db.contacts, async () => {
    await db.messages.bulkDelete(expired.map((m) => m.id));
    for (const peer of new Set(expired.map((m) => m.peer))) {
      const last = await db.messages.where("[peer+sentAt]").between([peer, Dexie.minKey], [peer, Dexie.maxKey]).last();
      await db.contacts.update(peer, { lastText: last ? preview(last) : "" });
    }
  });
  return expired.length;
}
