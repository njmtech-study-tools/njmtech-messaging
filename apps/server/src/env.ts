import type { UserInbox } from "./inbox-do";

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  /** Optional until R2 is enabled on the account; attachment routes return 503 without it. */
  FILES?: R2Bucket;
  INBOX: DurableObjectNamespace<UserInbox>;
  JWT_SECRET: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM: string;
  DEV_OTP_ECHO?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT: string;
  FCM_SERVICE_ACCOUNT?: string;
  TEMPMAIL_API?: string;
}

export interface Session {
  sub: string; // user id
  did: string; // device id
}
