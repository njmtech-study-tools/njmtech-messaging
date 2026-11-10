/**
 * Keeps the account reachable by email even though temp inboxes are disposable.
 *
 * If the provider deletes the inbox (login → 401), a signed-in device silently creates
 * a new one and rebinds the account to it (OTP-verified), then shares the new
 * credentials with the user's other devices over E2E sync.
 */
import { api } from "./api";
import { saveIdentity, type Identity, type MailboxCreds } from "./storage";
import { createMailbox, login, TempMailError, waitForOtp } from "./tempmail";

export type InboxStatus = "ok" | "missing" | "unknown";

export async function checkInbox(id: Identity): Promise<InboxStatus> {
  if (!id.mailbox) return "missing";
  try {
    await login(id.mailbox);
    return "ok";
  } catch (e) {
    // 401 = credentials no longer valid → the provider deleted the inbox.
    return e instanceof TempMailError && e.status === 401 ? "missing" : "unknown";
  }
}

export async function replaceInbox(id: Identity, signal = new AbortController().signal): Promise<MailboxCreds> {
  const box = await createMailbox();
  const since = Date.now();
  const start = await api<{ devCode?: string }>("/me/email/start", { method: "POST", json: { email: box.address } });
  const code = start.devCode ?? (await waitForOtp(box, since, signal));
  await api("/me/email/verify", { method: "POST", json: { email: box.address, code } });
  id.mailbox = { address: box.address, password: box.password };
  await saveIdentity(id);
  return id.mailbox;
}
