import {
  currentPrekey, generateDeviceKeys, publicPrekey,
  type AuthVerifyResponse, type DeviceKeys, type DeviceRegistration,
} from "@njm/shared";
import { platform } from "../config";
import { api, ApiError } from "./api";
import { saveIdentity, type Identity, type MailboxCreds } from "./storage";
import { createMailbox, login, waitForOtp, type Mailbox } from "./tempmail";

export type Step = "inbox" | "request" | "waiting" | "verify" | "done";

/** v2 kits carry a recovery code that works even if the temp inbox is gone. */
export interface RecoveryKit {
  app: "ephemeral";
  v: 1 | 2;
  handle: string;
  recoveryCode?: string | null;
  mailbox?: MailboxCreds | null;
}

function deviceName() {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "Device";
  return `${os} · ${platform}`;
}

function registration(keys: DeviceKeys): DeviceRegistration {
  return { identityKey: keys.identity.publicKey, prekey: publicPrekey(currentPrekey(keys)), name: deviceName(), platform };
}

async function finish(res: AuthVerifyResponse, keys: DeviceKeys, extra: Partial<Identity>): Promise<Identity> {
  const identity: Identity = {
    token: res.token,
    user: res.user,
    deviceId: res.deviceId,
    keys,
    mailbox: null,
    recoveryCode: res.recoveryCode ?? null,
    ...extra,
  };
  if (res.recoveryCode) identity.recoveryCode = res.recoveryCode;
  await saveIdentity(identity);
  return identity;
}

/**
 * Anonymous onboarding: disposable inbox → OTP sent there → read automatically → verify.
 * Pass `mailbox` to sign in again with an existing inbox.
 */
export async function authenticate(opts: {
  handle?: string;
  mailbox?: MailboxCreds;
  onStep: (s: Step) => void;
  signal: AbortSignal;
  /** Fallback when the code can't be read automatically. */
  askCode?: () => Promise<string>;
}): Promise<Identity> {
  opts.onStep("inbox");
  const box: Mailbox = opts.mailbox ? await login(opts.mailbox) : await createMailbox();

  opts.onStep("request");
  const since = Date.now();
  let start: { existing: boolean; devCode?: string };
  try {
    start = await api<{ existing: boolean; devCode?: string }>("/auth/start", { method: "POST", json: { email: box.address } });
  } catch (e) {
    if (e instanceof ApiError && e.code === "email_failed") throw new Error("Couldn't send the verification email. Try again in a minute.");
    if (e instanceof ApiError && e.code === "cooldown") throw new Error("A code was just sent. Wait a minute before asking again.");
    throw e;
  }
  if (!start.existing && !opts.handle) throw new Error("No account exists for this inbox.");

  opts.onStep("waiting");
  let code = start.devCode;
  if (!code) {
    try {
      code = await waitForOtp(box, since, opts.signal);
    } catch (e) {
      if (!opts.askCode || (e as Error).name === "AbortError") throw e;
      code = await opts.askCode();
    }
  }

  opts.onStep("verify");
  const keys = generateDeviceKeys();
  let res: AuthVerifyResponse;
  try {
    res = await api<AuthVerifyResponse>("/auth/verify", {
      method: "POST",
      json: { email: box.address, code, handle: start.existing ? undefined : opts.handle, device: registration(keys) },
    });
  } catch (e) {
    if (e instanceof ApiError && e.code === "handle_taken") throw new Error("That handle was just taken. Pick another.");
    if (e instanceof ApiError && e.code === "invalid_code") throw new Error("Verification code was rejected.");
    if (e instanceof ApiError && e.code === "too_many_devices") throw new Error("This account already has 10 devices. Remove one first.");
    throw e;
  }
  const id = await finish(res, keys, { mailbox: { address: box.address, password: box.password } });
  opts.onStep("done");
  return id;
}

/** Recover with handle + recovery code. No inbox needed; a new inbox is attached afterwards if required. */
export async function recover(handle: string, recoveryCode: string, mailbox: MailboxCreds | null = null): Promise<Identity> {
  const keys = generateDeviceKeys();
  try {
    const res = await api<AuthVerifyResponse>("/auth/recover", {
      method: "POST",
      json: { handle: handle.trim().replace(/^@/, "").toLowerCase(), recoveryCode, device: registration(keys) },
    });
    return finish(res, keys, { mailbox });
  } catch (e) {
    if (e instanceof ApiError && e.code === "invalid_recovery_code") throw new Error("Handle or recovery code is wrong (codes are single-use).");
    if (e instanceof ApiError && e.code === "rate_limited") throw new Error("Too many attempts. Try again in an hour.");
    throw e;
  }
}

/** Sign in with a code displayed on one of your signed-in devices. */
export async function linkDevice(code: string): Promise<Identity> {
  const keys = generateDeviceKeys();
  try {
    const res = await api<AuthVerifyResponse>("/auth/link", { method: "POST", json: { code, device: registration(keys) } });
    return finish(res, keys, {});
  } catch (e) {
    if (e instanceof ApiError && e.code === "invalid_link_code") throw new Error("That code is invalid or expired.");
    if (e instanceof ApiError && e.code === "rate_limited") throw new Error("Too many attempts. Wait a few minutes.");
    throw e;
  }
}

export function recoveryKit(id: Identity): RecoveryKit {
  return { app: "ephemeral", v: 2, handle: id.user.handle, recoveryCode: id.recoveryCode, mailbox: id.mailbox };
}

export function parseRecoveryKit(text: string): RecoveryKit {
  const kit = JSON.parse(text);
  if (kit?.app !== "ephemeral" || !(kit.recoveryCode || (kit.mailbox?.address && kit.mailbox?.password))) {
    throw new Error("Not a valid recovery kit.");
  }
  return kit as RecoveryKit;
}

export async function checkHandle(handle: string): Promise<boolean> {
  const r = await api<{ available: boolean }>(`/handles/${encodeURIComponent(handle)}`);
  return r.available;
}
