/**
 * End-to-end encryption with key rotation (protocol v2).
 *
 * Every device has:
 *  - an Ed25519 **identity key**: long-lived, never leaves the device. Its fingerprint is
 *    the device's safety number and stays stable across rotations.
 *  - a rotating X25519 **signed prekey**: signed by the identity key. It's replaced
 *    periodically, and the old private half is destroyed after a grace period.
 *
 * Each envelope is encrypted to the recipient device's current prekey using a fresh
 * **ephemeral** X25519 key (ECIES), so:
 *  - the sender keeps nothing that can decrypt what it sent (sender-side forward secrecy);
 *  - once a recipient deletes a retired prekey, ciphertext captured earlier can no
 *    longer be decrypted, even if the device is later compromised (bounded forward secrecy).
 * Envelopes are signed with the sender's identity key, so recipients can authenticate the
 * sender device. The relay can't forge messages and only ever sees ciphertext.
 */
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { fromB64Url, fromUtf8, randomBytes, toB64Url, utf8 } from "./encoding";

export interface KeyPair {
  publicKey: string; // base64url
  privateKey: string; // base64url
}

export interface SignedPrekey {
  id: number;
  publicKey: string;
  signature: string;
}

/** Locally held prekey (private half included). */
export interface Prekey extends SignedPrekey {
  privateKey: string;
  createdAt: number;
  retiredAt?: number;
}

export interface DeviceKeys {
  identity: KeyPair; // Ed25519
  prekeys: Prekey[]; // newest last; retired ones kept until the grace period ends
}

/** What travels on the wire for one recipient device. */
export interface SealedEnvelope {
  kid: number; // recipient prekey id
  epk: string; // ephemeral X25519 public key
  nonce: string;
  ct: string;
  sig: string; // Ed25519 signature by the sender's identity key
}

/** Prekeys rotate weekly; retired private keys are destroyed after the relay's max queue TTL (+1 day slack). */
export const PREKEY_ROTATE_MS = 7 * 24 * 3600 * 1000;
export const PREKEY_GRACE_MS = 8 * 24 * 3600 * 1000;

/* ------------------------------- key management ------------------------------- */

export function generateIdentity(): KeyPair {
  const priv = ed25519.utils.randomPrivateKey();
  return { privateKey: toB64Url(priv), publicKey: toB64Url(ed25519.getPublicKey(priv)) };
}

const prekeyMessage = (id: number, publicKey: string) => utf8(`njm-prekey-v2|${id}|${publicKey}`);

export function generatePrekey(identity: KeyPair, id: number, now = Date.now()): Prekey {
  const priv = x25519.utils.randomPrivateKey();
  const publicKey = toB64Url(x25519.getPublicKey(priv));
  const signature = toB64Url(ed25519.sign(prekeyMessage(id, publicKey), fromB64Url(identity.privateKey)));
  return { id, publicKey, signature, privateKey: toB64Url(priv), createdAt: now };
}

export function verifyPrekey(identityKey: string, p: SignedPrekey): boolean {
  try {
    return ed25519.verify(fromB64Url(p.signature), prekeyMessage(p.id, p.publicKey), fromB64Url(identityKey));
  } catch {
    return false;
  }
}

export function generateDeviceKeys(now = Date.now()): DeviceKeys {
  const identity = generateIdentity();
  return { identity, prekeys: [generatePrekey(identity, 1, now)] };
}

export function currentPrekey(keys: DeviceKeys): Prekey {
  return keys.prekeys[keys.prekeys.length - 1];
}

export const publicPrekey = ({ id, publicKey, signature }: SignedPrekey): SignedPrekey => ({ id, publicKey, signature });

/**
 * Returns a rotated copy of the keys if the current prekey is due (or `force`), with the
 * previous prekey marked retired. Retired keys past the grace period are always pruned.
 */
export function rotateKeys(
  keys: DeviceKeys,
  opts: { now?: number; force?: boolean } = {},
): { keys: DeviceKeys; rotated: Prekey | null; pruned: number } {
  const now = opts.now ?? Date.now();
  const current = currentPrekey(keys);
  const due = opts.force || now - current.createdAt >= PREKEY_ROTATE_MS;
  let prekeys = keys.prekeys.map((p) => (due && p.id === current.id ? { ...p, retiredAt: now } : p));
  let rotated: Prekey | null = null;
  if (due) {
    rotated = generatePrekey(keys.identity, current.id + 1, now);
    prekeys.push(rotated);
  }
  const before = prekeys.length;
  prekeys = prekeys.filter((p) => !p.retiredAt || now - p.retiredAt < PREKEY_GRACE_MS);
  return { keys: { ...keys, prekeys }, rotated, pruned: before - prekeys.length };
}

/* ---------------------------------- envelopes ---------------------------------- */

function envelopeKey(shared: Uint8Array, epk: string, senderDevice: string, recipientDevice: string, kid: number) {
  return hkdf(sha256, shared, fromB64Url(epk), utf8(`njm-msg-v2|${senderDevice}|${recipientDevice}|${kid}`), 32);
}

function signedBytes(senderDevice: string, recipientDevice: string, e: Omit<SealedEnvelope, "sig">) {
  return sha256(utf8(`njm-env-v2|${senderDevice}|${recipientDevice}|${e.kid}|${e.epk}|${e.nonce}|${e.ct}`));
}

export function sealEnvelope(args: {
  senderIdentity: KeyPair;
  senderDevice: string;
  recipientDevice: string;
  recipientPrekey: SignedPrekey;
  plaintext: Uint8Array;
}): SealedEnvelope {
  const eph = x25519.utils.randomPrivateKey();
  const epk = toB64Url(x25519.getPublicKey(eph));
  const kid = args.recipientPrekey.id;
  const key = envelopeKey(
    x25519.getSharedSecret(eph, fromB64Url(args.recipientPrekey.publicKey)),
    epk, args.senderDevice, args.recipientDevice, kid,
  );
  eph.fill(0);
  const nonce = randomBytes(24);
  const ct = toB64Url(xchacha20poly1305(key, nonce).encrypt(args.plaintext));
  const unsigned = { kid, epk, nonce: toB64Url(nonce), ct };
  const sig = toB64Url(
    ed25519.sign(signedBytes(args.senderDevice, args.recipientDevice, unsigned), fromB64Url(args.senderIdentity.privateKey)),
  );
  return { ...unsigned, sig };
}

export class EnvelopeError extends Error {
  constructor(public reason: "bad_signature" | "unknown_prekey" | "decrypt_failed") {
    super(reason);
  }
}

export function openEnvelope(args: {
  envelope: SealedEnvelope;
  senderIdentityKey: string;
  senderDevice: string;
  recipientDevice: string;
  recipientKeys: DeviceKeys;
}): Uint8Array {
  const e = args.envelope;
  let sigOk = false;
  try {
    sigOk = ed25519.verify(fromB64Url(e.sig), signedBytes(args.senderDevice, args.recipientDevice, e), fromB64Url(args.senderIdentityKey));
  } catch {}
  if (!sigOk) throw new EnvelopeError("bad_signature");
  const prekey = args.recipientKeys.prekeys.find((p) => p.id === e.kid);
  if (!prekey) throw new EnvelopeError("unknown_prekey");
  try {
    const key = envelopeKey(
      x25519.getSharedSecret(fromB64Url(prekey.privateKey), fromB64Url(e.epk)),
      e.epk, args.senderDevice, args.recipientDevice, e.kid,
    );
    return xchacha20poly1305(key, fromB64Url(e.nonce)).decrypt(fromB64Url(e.ct));
  } catch {
    throw new EnvelopeError("decrypt_failed");
  }
}

export const sealEnvelopeJson = (args: Omit<Parameters<typeof sealEnvelope>[0], "plaintext"> & { value: unknown }) =>
  sealEnvelope({ ...args, plaintext: utf8(JSON.stringify(args.value)) });

export const openEnvelopeJson = <T = unknown>(args: Parameters<typeof openEnvelope>[0]): T =>
  JSON.parse(fromUtf8(openEnvelope(args))) as T;

/* ---------------------------------- attachments ---------------------------------- */

/** Encrypt an attachment with a fresh random key. Key + nonce travel inside the E2E message. */
export function encryptBlob(data: Uint8Array): { key: string; nonce: string; ct: Uint8Array } {
  const key = randomBytes(32);
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(key, nonce).encrypt(data);
  return { key: toB64Url(key), nonce: toB64Url(nonce), ct };
}

export function decryptBlob(ct: Uint8Array, key: string, nonce: string): Uint8Array {
  return xchacha20poly1305(fromB64Url(key), fromB64Url(nonce)).decrypt(ct);
}

/** Human-comparable safety number for a device identity key. Stable across prekey rotation. */
export function fingerprint(identityKey: string): string {
  const h = sha256(fromB64Url(identityKey));
  return Array.from(h.subarray(0, 10), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .match(/.{4}/g)!
    .join(" ");
}

/* ------------------------------- recovery codes ------------------------------- */

const B32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

/** Random code in groups, e.g. 4×5 = 100 bits. */
export function randomCode(groups: number, size = 5): string {
  const out: string[] = [];
  for (let g = 0; g < groups; g++) {
    const bytes = randomBytes(size);
    out.push(Array.from(bytes, (b) => B32[b & 31]).join(""));
  }
  return out.join("-");
}

export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}
