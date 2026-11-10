import { z } from "zod";

export const MAX_QUEUE_TTL_SECONDS = 7 * 24 * 3600;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const HANDLE_RE = /^[a-z0-9_]{3,24}$/;

const id = z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);

/* ----------------------------- WebSocket frames ---------------------------- */

const b64 = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9_-]+$/);

export const EnvelopeSchema = z.object({
  device: id, // recipient device id
  kid: z.number().int().positive(), // recipient prekey id
  epk: b64(64), // ephemeral X25519 public key
  nonce: b64(64),
  ct: b64(64 * 1024),
  sig: b64(128), // Ed25519 signature by the sender's identity key
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

export const ClientFrameSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("send"),
    id,
    to: id, // recipient user id
    envelopes: z.array(EnvelopeSchema).min(1).max(32),
    ttl: z.number().int().positive().max(MAX_QUEUE_TTL_SECONDS).optional(),
  }),
  z.object({ t: z.literal("ack"), ids: z.array(id).min(1).max(500) }),
  z.object({ t: z.literal("ping") }),
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

export type ServerFrame =
  | { t: "msg"; id: string; from: string; fromDevice: string; ts: number; kid: number; epk: string; nonce: string; ct: string; sig: string }
  | { t: "sent"; id: string }
  | { t: "error"; id?: string; code: string; message: string }
  | { t: "pong" };

/* --------------------------- Decrypted payloads ---------------------------- */

export interface FileRef {
  id: string;
  key: string;
  nonce: string;
  name: string;
  mime: string;
  size: number;
}

export type Payload =
  | { v: 1; kind: "text"; id: string; to: string; text: string; ttl: number; sentAt: number }
  | { v: 1; kind: "file"; id: string; to: string; file: FileRef; text?: string; ttl: number; sentAt: number }
  | { v: 1; kind: "timer"; id: string; to: string; ttl: number; sentAt: number }
  /** Own-devices only: shares account recovery material with newly linked devices. */
  | {
      v: 1; kind: "sync"; id: string; to: string; ttl: 0; sentAt: number;
      mailbox: { address: string; password: string } | null;
      recoveryCode: string | null;
    };

/* -------------------------------- HTTP API -------------------------------- */

export const AuthStartSchema = z.object({ email: z.string().email().max(254) });

export const SignedPrekeySchema = z.object({
  id: z.number().int().positive(),
  publicKey: b64(64),
  signature: b64(128),
});

export const DeviceRegistrationSchema = z.object({
  identityKey: b64(64), // Ed25519 public key
  prekey: SignedPrekeySchema,
  name: z.string().max(64),
  platform: z.enum(["web", "android", "desktop"]),
});
export type DeviceRegistration = z.infer<typeof DeviceRegistrationSchema>;

export const AuthVerifySchema = z.object({
  email: z.string().email().max(254),
  code: z.string().regex(/^\d{6}$/),
  handle: z.string().regex(HANDLE_RE).optional(),
  device: DeviceRegistrationSchema,
});
export type AuthVerifyRequest = z.infer<typeof AuthVerifySchema>;

/** Account recovery without the email inbox (e.g. the temp inbox was deleted). */
export const AuthRecoverSchema = z.object({
  handle: z.string().regex(HANDLE_RE),
  recoveryCode: z.string().min(16).max(40),
  device: DeviceRegistrationSchema,
});

/** Sign in a new device with a short-lived code shown on an already signed-in device. */
export const AuthLinkSchema = z.object({
  code: z.string().min(8).max(16),
  device: DeviceRegistrationSchema,
});

export const EmailRebindStartSchema = z.object({ email: z.string().email().max(254) });
export const EmailRebindVerifySchema = z.object({ email: z.string().email().max(254), code: z.string().regex(/^\d{6}$/) });

export interface AuthVerifyResponse {
  token: string;
  user: PublicUser;
  deviceId: string;
  /** Returned when an account is created or recovered (recovery codes are single-use). */
  recoveryCode?: string;
}

export interface PublicUser {
  id: string;
  handle: string;
}

export interface PublicDevice {
  id: string;
  identityKey: string;
  prekey: { id: number; publicKey: string; signature: string };
}

export const PushRegisterSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fcm"), token: z.string().min(10).max(4096) }),
  z.object({
    kind: z.literal("webpush"),
    subscription: z.object({
      endpoint: z.string().url().max(2048),
      keys: z.object({ p256dh: z.string().max(256), auth: z.string().max(64) }).optional(),
    }),
  }),
  z.object({ kind: z.literal("none") }),
]);
export type PushRegister = z.infer<typeof PushRegisterSchema>;
