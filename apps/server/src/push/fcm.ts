/** Firebase Cloud Messaging HTTP v1 for the Android (Capacitor) app. */
import { toB64Url, utf8 } from "@njm/shared/encoding";
import type { PushResult } from "./webpush";

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

let tokenCache: { email: string; token: string; exp: number } | null = null;

function pemToPkcs8(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function accessToken(sa: ServiceAccount): Promise<string> {
  if (tokenCache && tokenCache.email === sa.client_email && tokenCache.exp > Date.now() + 60_000) return tokenCache.token;
  const iat = Math.floor(Date.now() / 1000);
  const enc = (v: unknown) => toB64Url(utf8(JSON.stringify(v)));
  const body = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat,
    exp: iat + 3600,
  })}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, utf8(body)));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${body}.${toB64Url(sig)}`,
    }),
  });
  if (!res.ok) throw new Error(`FCM oauth failed: ${res.status}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = { email: sa.client_email, token: json.access_token, exp: Date.now() + json.expires_in * 1000 };
  return json.access_token;
}

export async function sendFcm(serviceAccountJson: string, token: string): Promise<PushResult> {
  const sa = JSON.parse(serviceAccountJson) as ServiceAccount;
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken(sa)}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        token,
        // No message content ever leaves the relay — this is only a wake-up.
        notification: { title: "New message", body: "Open Ephemeral to read it" },
        data: { type: "msg" },
        android: {
          priority: "HIGH",
          collapse_key: "new-message",
          notification: { channel_id: "messages", tag: "new-message" },
        },
      },
    }),
  });
  if (res.ok) return "ok";
  const text = await res.text();
  if (res.status === 404 || text.includes("UNREGISTERED")) return "gone";
  console.warn("fcm failed", res.status, text);
  return "error";
}
