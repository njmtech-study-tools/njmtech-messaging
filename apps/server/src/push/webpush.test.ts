import { afterEach, describe, expect, it, vi } from "vitest";
import { toB64Url } from "@njm/shared/encoding";
import { sendWebPush } from "./webpush";

async function vapid() {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { publicKey: toB64Url(raw), privateKey: jwk.d!, subject: "mailto:test@example.com" };
}

async function browserKeys() {
  const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { p256dh: toB64Url(raw), auth: toB64Url(crypto.getRandomValues(new Uint8Array(16))) };
}

afterEach(() => vi.unstubAllGlobals());

describe("sendWebPush", () => {
  it("encrypts a payload when the subscription has keys", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const sub = { endpoint: "https://push.example.com/abc", keys: await browserKeys() };
    expect(await sendWebPush(sub, await vapid())).toBe("ok");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(url).toBe(sub.endpoint);
    expect(headers.get("content-encoding")).toBe("aes128gcm");
    expect(headers.get("authorization")).toMatch(/^vapid t=/);
    // Ciphertext, not the plaintext JSON.
    const body = new Uint8Array(init.body as ArrayBuffer);
    expect(body.length).toBeGreaterThan(86);
    expect(new TextDecoder().decode(body)).not.toContain("New message");
  });

  it("falls back to a payload-less wake-up without keys, and reports gone subscriptions", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 410 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await sendWebPush({ endpoint: "https://push.example.com/old" }, await vapid())).toBe("gone");
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).get("content-length")).toBe("0");
  });
});
