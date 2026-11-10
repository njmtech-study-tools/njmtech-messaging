/**
 * Disposable inbox provisioning (mail.tm-compatible API, proxied through our Worker
 * because the upstream API has no CORS for third-party origins).
 */
import { API_URL } from "../config";
import type { MailboxCreds } from "./storage";

const BASE = () => `${API_URL}/api/tempmail`;

export class TempMailError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}, mailToken?: string): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  if (mailToken) headers.set("X-Mail-Authorization", `Bearer ${mailToken}`);
  let res = await fetch(`${BASE()}${path}`, { ...init, headers });
  // mail.tm rate-limits per IP (429) and occasionally blips (5xx): back off and retry.
  const transient = (r: Response) => r.status === 429 || r.status === 502 || r.status === 503 || r.status === 504;
  for (let attempt = 0; transient(res) && attempt < 5; attempt++) {
    const retryAfter = Number(res.headers.get("Retry-After"));
    const wait = (retryAfter > 0 ? retryAfter * 1000 : 1500 * 2 ** attempt) + Math.random() * 500;
    await new Promise((r) => setTimeout(r, Math.min(wait, 20_000)));
    res = await fetch(`${BASE()}${path}`, { ...init, headers });
  }
  if (res.status === 429) throw new TempMailError(429, "Temp-mail service is rate limiting. Try again in a moment.");
  if (!res.ok) throw new TempMailError(res.status, `Temp-mail error (${res.status})`);
  return res.status === 204 ? (undefined as T) : res.json();
}

const members = <T>(j: any): T[] => (Array.isArray(j) ? j : (j["hydra:member"] ?? []));

function randomLocalPart() {
  const a = new Uint8Array(10);
  crypto.getRandomValues(a);
  return "e" + Array.from(a, (b) => (b % 36).toString(36)).join("");
}

function randomPassword() {
  const a = new Uint8Array(24);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/[^A-Za-z0-9]/g, "").slice(0, 24) + "A1!";
}

export interface Mailbox extends MailboxCreds {
  token: string;
}

export async function createMailbox(): Promise<Mailbox> {
  const domains = members<{ domain: string; isActive: boolean }>(await call("/domains")).filter((d) => d.isActive);
  if (!domains.length) throw new Error("No temp-mail domains available right now.");
  for (let attempt = 0; ; attempt++) {
    const domain = domains[Math.floor(Math.random() * domains.length)].domain;
    const creds = { address: `${randomLocalPart()}@${domain}`, password: randomPassword() };
    try {
      await call("/accounts", { method: "POST", body: JSON.stringify(creds) });
    } catch (e) {
      // 422 "already used": a rate-limited attempt may still have created *our* account
      // upstream before the retry. We generated the password, so try logging in first.
      if (!(e instanceof TempMailError && e.status === 422) || attempt >= 2) throw e;
      try {
        return await login(creds);
      } catch {
        continue; // genuinely taken by someone else: new random address
      }
    }
    return login(creds);
  }
}

export async function login(creds: MailboxCreds): Promise<Mailbox> {
  const { token } = await call<{ token: string }>("/token", { method: "POST", body: JSON.stringify(creds) });
  return { ...creds, token };
}

interface MailSummary {
  id: string;
  subject: string;
  intro?: string;
  createdAt: string;
}

/** Polls the inbox until a 6-digit code arrives that was sent after `since`. */
export async function waitForOtp(box: Mailbox, since: number, signal: AbortSignal, timeoutMs = 120_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const msgs = members<MailSummary>(await call("/messages", {}, box.token));
    for (const m of msgs) {
      if (new Date(m.createdAt).getTime() < since - 30_000) continue;
      const code = extractOtp(`${m.subject} ${m.intro ?? ""}`);
      if (code) return code;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("Timed out waiting for the verification email.");
}

export function extractOtp(text: string): string | null {
  return text.match(/\b(\d{6})\b/)?.[1] ?? null;
}
