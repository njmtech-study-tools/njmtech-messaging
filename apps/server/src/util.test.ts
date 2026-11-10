import { describe, expect, it } from "vitest";
import { generateOtp, signJwt, verifyJwt, timingSafeEqual } from "./util";
import { vapidJwt } from "./push/webpush";
import { fromB64Url, fromUtf8 } from "@njm/shared/encoding";

describe("jwt", () => {
  it("signs and verifies", async () => {
    const t = await signJwt({ sub: "u1", did: "d1" }, "secret", 60);
    expect(await verifyJwt<{ sub: string }>(t, "secret")).toMatchObject({ sub: "u1", did: "d1" });
    expect(await verifyJwt(t, "other")).toBeNull();
    expect(await verifyJwt(t.slice(0, -2) + "xx", "secret")).toBeNull();
  });
  it("rejects expired tokens", async () => {
    const t = await signJwt({ sub: "u1" }, "secret", -10);
    expect(await verifyJwt(t, "secret")).toBeNull();
  });
});

describe("otp", () => {
  it("is 6 digits", () => {
    for (let i = 0; i < 100; i++) expect(generateOtp()).toMatch(/^\d{6}$/);
  });
  it("compares safely", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
  });
});

describe("vapid", () => {
  it("produces an ES256 JWT verifiable with the public key", async () => {
    const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
    const raw = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
    const pub = Buffer.from(raw).toString("base64url");
    const jwt = await vapidJwt("https://fcm.googleapis.com", { publicKey: pub, privateKey: jwk.d!, subject: "mailto:a@b.c" });
    const [h, p, s] = jwt.split(".");
    expect(JSON.parse(fromUtf8(fromB64Url(p))).aud).toBe("https://fcm.googleapis.com");
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, kp.publicKey, fromB64Url(s), new TextEncoder().encode(`${h}.${p}`),
    );
    expect(ok).toBe(true);
  });
});
