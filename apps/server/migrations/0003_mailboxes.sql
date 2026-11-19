-- Self-hosted disposable inboxes (replaces mail.tm, which blocks Cloudflare Workers).
-- Mail arrives via Cloudflare Email Routing → mail-relay Worker → POST /api/inbound-email.
-- Only the subject and a short text preview are kept, for at most 24 hours.
CREATE TABLE mailboxes (
  id          TEXT PRIMARY KEY,
  address     TEXT NOT NULL UNIQUE,   -- inbox+<tag>@<domain>, lowercase
  pw_hash     TEXT NOT NULL,          -- sha256 of the client-generated random password
  created_at  INTEGER NOT NULL
);

CREATE TABLE mailbox_messages (
  id          TEXT PRIMARY KEY,
  mailbox_id  TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  from_addr   TEXT,
  subject     TEXT NOT NULL,
  intro       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX mailbox_messages_box ON mailbox_messages(mailbox_id, created_at);
CREATE INDEX mailbox_messages_age ON mailbox_messages(created_at);
