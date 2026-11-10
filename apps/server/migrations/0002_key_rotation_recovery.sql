-- Key rotation: each device has a stable Ed25519 identity key and a rotating,
-- identity-signed X25519 prekey. devices.public_key now holds the CURRENT prekey.
ALTER TABLE devices ADD COLUMN identity_key TEXT;
ALTER TABLE devices ADD COLUMN prekey_id INTEGER;
ALTER TABLE devices ADD COLUMN prekey_sig TEXT;
ALTER TABLE devices ADD COLUMN prekey_at INTEGER;

-- Devices registered with the v1 (unsigned, non-rotating) scheme can't take part in v2.
DELETE FROM devices WHERE identity_key IS NULL;

-- Account recovery that doesn't depend on the disposable inbox.
-- Stored as SHA-256 of a 100-bit random code; codes are single-use (rotated on use).
ALTER TABLE users ADD COLUMN recovery_hash TEXT;
