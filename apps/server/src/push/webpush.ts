/**
 * Payload-less Web Push (RFC 8030 + VAPID RFC 8292).
 * We never send message content through push services, so no RFC 8291 payload
 * encryption is required: the service worker shows a generic notification.
 */
import { fromB64Url, toB64Url, utf8 } from "@njm/shared/encoding";

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

export async function sendWebPush(endpoint: string, keys: VapidKeys): Promise<PushResult> {
  const jwt = await vapidJwt(new URL(endpoint).origin, keys);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
      TTL: "86400",
      Urgency: "high",
      Topic: "new-message", // collapses multiple pending pushes into one
      "Content-Length": "0",
    },
  });
  if (res.status === 404 || res.status === 410) return "gone";
  if (!res.ok) {
    console.warn("webpush failed", res.status, await res.text());
    return "error";
  }
  return "ok";
}
