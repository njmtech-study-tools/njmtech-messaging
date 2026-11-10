import { fromB64Url, toB64Url, utf8, fromUtf8, randomBytes } from "@njm/shared/encoding";

export const now = () => Date.now();
export const newId = (bytes = 12) => toB64Url(randomBytes(bytes));

export async function sha256Hex(s: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(s)));
  return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* ------------------------------ Minimal HS256 JWT ------------------------------ */

async function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

const b64json = (v: unknown) => toB64Url(utf8(JSON.stringify(v)));

export async function signJwt(payload: Record<string, unknown>, secret: string, ttlSeconds: number): Promise<string> {
  const iat = Math.floor(now() / 1000);
  const body = `${b64json({ alg: "HS256", typ: "JWT" })}.${b64json({ ...payload, iat, exp: iat + ttlSeconds })}`;
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), utf8(body)));
  return `${body}.${toB64Url(sig)}`;
}

export async function verifyJwt<T>(token: string, secret: string): Promise<T | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  try {
    const header = JSON.parse(fromUtf8(fromB64Url(h)));
    if (header.alg !== "HS256") return null;
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64Url(s), utf8(`${h}.${p}`));
    if (!ok) return null;
    const payload = JSON.parse(fromUtf8(fromB64Url(p)));
    if (typeof payload.exp !== "number" || payload.exp * 1000 < now()) return null;
    return payload as T;
  } catch {
    return null;
  }
}

/** Uniform 6-digit numeric code. */
export function generateOtp(): string {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0xffffffff / 1_000_000) * 1_000_000;
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return (buf[0] % 1_000_000).toString().padStart(6, "0");
}
