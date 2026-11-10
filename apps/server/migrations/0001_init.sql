-- Accounts, device public keys and push targets only. No message content is ever stored here.
CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  handle      TEXT NOT NULL UNIQUE,
  email       TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);

CREATE TABLE devices (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key  TEXT NOT NULL,
  name        TEXT NOT NULL,
  platform    TEXT NOT NULL,
  push_kind   TEXT,          -- 'fcm' | 'webpush' | NULL
  push_data   TEXT,          -- FCM token or JSON web-push subscription
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);
CREATE INDEX devices_user ON devices(user_id);

-- Encrypted attachment bookkeeping: which devices still have to download a blob.
CREATE TABLE file_targets (
  file_id     TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  owner_id    TEXT NOT NULL,
  done        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (file_id, device_id)
);
CREATE INDEX file_targets_created ON file_targets(created_at);
