import { describe, expect, it } from "vitest";
import {
  currentPrekey, decryptBlob, encryptBlob, fingerprint, generateDeviceKeys, normalizeCode, openEnvelopeJson,
  PREKEY_GRACE_MS, PREKEY_ROTATE_MS, publicPrekey, randomCode, rotateKeys, sealEnvelopeJson, verifyPrekey,
  EnvelopeError,
} from "./crypto";
import { ClientFrameSchema } from "./protocol";
import { fromB64Url, randomBytes, toB64Url } from "./encoding";

const A = "devA00001";
const B = "devB00001";

function exchange() {
  const alice = generateDeviceKeys();
  const bob = generateDeviceKeys();
  const seal = (value: unknown, to = bob) =>
    sealEnvelopeJson({ senderIdentity: alice.identity, senderDevice: A, recipientDevice: B, recipientPrekey: publicPrekey(currentPrekey(to)), value });
  const open = (envelope: ReturnType<typeof seal>, keys = bob) =>
    openEnvelopeJson({ envelope, senderIdentityKey: alice.identity.publicKey, senderDevice: A, recipientDevice: B, recipientKeys: keys });
  return { alice, bob, seal, open };
}

describe("envelopes", () => {
  it("round-trips and binds sender/recipient devices", () => {
    const { seal, open, alice, bob } = exchange();
    const env = seal({ hello: "world" });
    expect(open(env)).toEqual({ hello: "world" });
    // Wrong recipient device id in the signature/KDF context.
    expect(() =>
      openEnvelopeJson({ envelope: env, senderIdentityKey: alice.identity.publicKey, senderDevice: A, recipientDevice: "devX00001", recipientKeys: bob }),
    ).toThrow(EnvelopeError);
  });

  it("uses a fresh ephemeral key per message", () => {
    const { seal } = exchange();
    expect(seal("x").epk).not.toBe(seal("x").epk);
  });

  it("rejects forged or tampered envelopes", () => {
    const { seal, open, bob } = exchange();
    const env = seal({ x: 1 });
    const ct = fromB64Url(env.ct);
    ct[0] ^= 1;
    expect(() => open({ ...env, ct: toB64Url(ct) })).toThrow("bad_signature");
    // Mallory (e.g. the relay) encrypts to Bob but can't sign as Alice.
    const mallory = generateDeviceKeys();
    const forged = sealEnvelopeJson({ senderIdentity: mallory.identity, senderDevice: A, recipientDevice: B, recipientPrekey: publicPrekey(currentPrekey(bob)), value: "evil" });
    expect(() => open(forged)).toThrow("bad_signature");
  });
});

describe("prekey rotation", () => {
  it("signs prekeys with the identity key", () => {
    const k = generateDeviceKeys();
    expect(verifyPrekey(k.identity.publicKey, currentPrekey(k))).toBe(true);
    expect(verifyPrekey(generateDeviceKeys().identity.publicKey, currentPrekey(k))).toBe(false);
    expect(verifyPrekey(k.identity.publicKey, { ...currentPrekey(k), id: 99 })).toBe(false);
  });

  it("rotates on schedule, keeps retired keys through the grace period, then destroys them", () => {
    const { seal, open, bob } = exchange();
    const t0 = currentPrekey(bob).createdAt;
    expect(rotateKeys(bob, { now: t0 + 1000 }).rotated).toBeNull();

    const inFlight = seal("sent before rotation", bob);
    const r1 = rotateKeys(bob, { now: t0 + PREKEY_ROTATE_MS });
    expect(r1.rotated?.id).toBe(2);
    expect(verifyPrekey(bob.identity.publicKey, r1.rotated!)).toBe(true);
    // Old message still decrypts during grace.
    expect(open(inFlight, r1.keys)).toBe("sent before rotation");
    // New messages target the new key.
    expect(seal("after", r1.keys).kid).toBe(2);

    // After the grace period the retired private key is gone: captured ciphertext is unreadable.
    const r2 = rotateKeys(r1.keys, { now: t0 + PREKEY_ROTATE_MS + PREKEY_GRACE_MS });
    expect(r2.pruned).toBe(1);
    expect(r2.keys.prekeys.map((p) => p.id)).not.toContain(1);
    expect(() => open(inFlight, r2.keys)).toThrow("unknown_prekey");
  });

  it("keeps the identity fingerprint stable across rotations", () => {
    const k = generateDeviceKeys();
    const r = rotateKeys(k, { force: true });
    expect(r.keys.identity.publicKey).toBe(k.identity.publicKey);
    expect(fingerprint(r.keys.identity.publicKey)).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){4}$/);
  });
});

describe("misc", () => {
  it("encrypts blobs larger than 64KB", () => {
    const data = randomBytes(100_000);
    const { key, nonce, ct } = encryptBlob(data);
    expect(decryptBlob(ct, key, nonce)).toEqual(data);
  });

  it("generates readable recovery codes", () => {
    const c = randomCode(4);
    expect(c).toMatch(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
    expect(normalizeCode(c.toLowerCase().replace(/-/g, " "))).toBe(c.replace(/-/g, ""));
  });

  it("validates frames", () => {
    expect(ClientFrameSchema.safeParse({ t: "ping" }).success).toBe(true);
    expect(ClientFrameSchema.safeParse({ t: "send", id: "abcdefgh", to: "abcdefgh", envelopes: [] }).success).toBe(false);
  });
});
