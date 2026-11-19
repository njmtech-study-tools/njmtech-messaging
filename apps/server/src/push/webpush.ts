/**
 * Web Push (RFC 8030 + VAPID RFC 8292), with an RFC 8291-encrypted payload when the
 * subscription has keys. The payload is a PushNotification (title/body/tag/url) and
 * never carries message content: it is the same generic "new message" text every time.
 */
import { buildPushPayload } from "@block65/webcrypto-web-push";
import { fromB64Url, toB64Url, utf8 } from "@njm/shared/encoding";

/** What the service worker (apps/client/src/sw.ts) turns into a notification. Content-free. */
export interface PushNotification {
  title: string;
  body: string;
  /** Same tag replaces instead of stacking. */
  tag: string;
  /** Hash route to open on click, e.g. "#/". */
  url?: string;
  /** Show even when the app is open in the foreground (test notifications). */
  always?: boolean;
}

export const NEW_MESSAGE: PushNotification = { title: "New message", body: "Open Ephemeral to read it", tag: "new-message" };

export interface WebPushSubscription {
  endpoint: string;
  keys?: { p256dh: string; auth: string };
}

export interface VapidKeys {
  publicKey: string; // base64url uncompressed P-256 point (65 bytes)
  privateKey: string; // base64url scalar d
  subject: string; // mailto: or https:
}

let cachedKey: { d: string; key: CryptoKey } | null = null;

async function importVapidKey(keys: VapidKeys): Promise<CryptoKey> {
  if (cachedKey?.d === keys.privateKey) return cachedKey.key;
  const pub = fromB64Url(keys.publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("invalid VAPID public key");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: keys.privateKey, x: toB64Url(pub.slice(1, 33)), y: toB64Url(pub.slice(33, 65)), ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  cachedKey = { d: keys.privateKey, key };
  return key;
}

export async function vapidJwt(audience: string, keys: VapidKeys, ttlSeconds = 12 * 3600): Promise<string> {
  const enc = (v: unknown) => toB64Url(utf8(JSON.stringify(v)));
  const body = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    sub: keys.subject,
  })}`;
  // WebCrypto ECDSA returns raw r||s (IEEE P1363) which is exactly the JWS ES256 format.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await importVapidKey(keys), utf8(body));
  return `${body}.${toB64Url(new Uint8Array(sig))}`;
}

export type PushResult = "ok" | "gone" | "error";

export async function sendWebPush(
  sub: WebPushSubscription,
  keys: VapidKeys,
  notification: PushNotification = NEW_MESSAGE,
): Promise<PushResult> {
  let init: RequestInit;
  if (sub.keys?.p256dh && sub.keys.auth) {
    // Encrypted payload (same approach as the wealth-board worker's push sender).
    const payload = await buildPushPayload(
      { data: JSON.stringify(notification), options: { ttl: 86400, urgency: "high", topic: notification.tag } },
      { endpoint: sub.endpoint, expirationTime: null, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
      keys,
    );
    init = payload as RequestInit;
  } else {
    // Old subscriptions saved without keys: payload-less wake-up, the service worker shows NEW_MESSAGE.
    const jwt = await vapidJwt(new URL(sub.endpoint).origin, keys);
    init = {
      method: "POST",
      headers: {
        Authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
        TTL: "86400",
        Urgency: "high",
        Topic: notification.tag, // collapses multiple pending pushes into one
        "Content-Length": "0",
      },
    };
  }
  const res = await fetch(sub.endpoint, init);
  if (res.status === 404 || res.status === 410) return "gone";
  if (!res.ok) {
    console.warn("webpush failed", res.status, await res.text());
    return "error";
  }
  return "ok";
}
