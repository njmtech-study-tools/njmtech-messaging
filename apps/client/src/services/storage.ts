import { Preferences } from "@capacitor/preferences";
import type { DeviceKeys, Prekey, PublicUser } from "@njm/shared";

/** Locally held prekey; `published: false` means the server hasn't accepted it yet. */
export type LocalPrekey = Prekey & { published?: boolean };

/** Everything that identifies this device. Lives only on the device. */
export interface Identity {
  token: string;
  user: PublicUser;
  deviceId: string;
  keys: DeviceKeys & { prekeys: LocalPrekey[] };
  /** Disposable inbox bound to the account. Null on a freshly linked device until synced. */
  mailbox: MailboxCreds | null;
  /** Single-use account recovery code (works without the inbox). */
  recoveryCode: string | null;
}

export interface MailboxCreds {
  address: string;
  password: string;
}

export interface Prefs {
  defaultTimer: number; // seconds, 0 = off
  notifications: boolean;
  kitSaved: boolean;
  lastInboxCheck: number;
}

const ID_KEY = "identity.v2";
const PREFS_KEY = "prefs.v1";

export async function loadIdentity(): Promise<Identity | null> {
  const { value } = await Preferences.get({ key: ID_KEY });
  if (value) return JSON.parse(value) as Identity;
  // v1 identities (static keys, no identity key) can't take part in the rotating-key protocol.
  await Preferences.remove({ key: "identity.v1" });
  return null;
}

export async function saveIdentity(id: Identity) {
  await Preferences.set({ key: ID_KEY, value: JSON.stringify(id) });
}

export async function loadPrefs(): Promise<Prefs> {
  const { value } = await Preferences.get({ key: PREFS_KEY });
  return { defaultTimer: 0, notifications: true, kitSaved: false, lastInboxCheck: 0, ...(value ? JSON.parse(value) : {}) };
}

export async function savePrefs(p: Prefs) {
  await Preferences.set({ key: PREFS_KEY, value: JSON.stringify(p) });
}

export async function clearAll() {
  await Preferences.clear();
}
