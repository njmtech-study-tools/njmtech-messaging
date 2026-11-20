import type { FileBlob } from "./file-do";
import type { UserInbox } from "./inbox-do";

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  /** Encrypted attachments, one object per file (see file-do.ts). */
  FILES: DurableObjectNamespace<FileBlob>;
  INBOX: DurableObjectNamespace<UserInbox>;
  JWT_SECRET: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM: string;
  DEV_OTP_ECHO?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT: string;
  FCM_SERVICE_ACCOUNT?: string;
  /** Disposable inboxes: inbox+<tag>@INBOX_DOMAIN (see mailbox.ts). */
  INBOX_DOMAIN?: string;
  INBOX_LOCAL?: string;
  /** Shared with the mail-relay Worker that posts incoming mail to /api/inbound-email. */
  INBOUND_EMAIL_SECRET?: string;
}

export interface Session {
  sub: string; // user id
  did: string; // device id
}
