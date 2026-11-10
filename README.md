# Ephemeral

Private, anonymous messaging for **Android (Ionic/Capacitor APK)**, **desktop (Electron)** and **web (PWA)** — one React codebase.

- **No message storage on servers.** Messages are end-to-end encrypted on the device. The relay (a Cloudflare Durable Object per user) only holds ciphertext for offline devices and deletes it the moment the device acks, or after 7 days at most. Messages live only in each device's IndexedDB.
- **Anonymous accounts via temp mail.** On sign-up the app creates a disposable inbox (mail.tm), the server emails a one-time code to it, and the app reads the code from the inbox automatically. No phone number or real email.
- **Notifications on every installed device.** FCM on Android, Web Push on the PWA, and a tray-resident Electron app with native notifications. Push payloads never contain message content; they're just a "new message" wake-up.
- **Features:** 1:1 chats, encrypted images/files, disappearing-message timers, multi-device (each device has its own keys, and your other devices get a copy), weekly key rotation with signed envelopes, recovery codes, device linking, automatic temp-inbox replacement, device management, account deletion.

## Layout

```
packages/shared   protocol schemas (zod) + E2E crypto (X25519 → HKDF → XChaCha20-Poly1305, @noble/*)
apps/server       Cloudflare Worker (Hono) + UserInbox Durable Object, D1, KV, R2
apps/client       Ionic React + Vite: PWA (service worker) and Capacitor Android project (apps/client/android)
apps/desktop      Electron shell: serves the client build from app://, tray, badge, launch at login
```

## How it works

| Concern | Where | What is stored |
|---|---|---|
| Accounts | D1 `users` | id, handle, temp-mail address |
| Devices | D1 `devices` | Ed25519 identity key, current signed X25519 prekey, push token/subscription |
| Recovery | D1 `users.recovery_hash` | SHA-256 of the single-use recovery code |
| Link codes | KV | 10-min, single-use device-link codes |
| OTP | KV | SHA-256 of code, 10 min TTL, 5 attempts |
| Offline messages | Durable Object storage | ciphertext only; deleted on ack, or by an alarm at TTL |
| Attachments | R2 | ciphertext only; deleted once every target device acks, swept by cron after 24 h |
| Message history | **device IndexedDB only** | plaintext, deleted by disappearing timers |

Sending: the client fetches the recipient's device keys (plus your own other devices), encrypts one envelope per device, and sends them over a WebSocket to its own inbox DO. That DO checks every envelope targets a device of the recipient (or of the sender), then forwards the envelopes to the recipient's inbox DO. That DO pushes live sockets, queues for offline devices and sends a content-free push.

### Encryption & key rotation

Each device has:

- an **Ed25519 identity key**. It never leaves the device and never changes. Its fingerprint is the device's *safety number* (Settings).
- a **signed X25519 prekey**. The identity key signs it, and it **rotates every 7 days** (or with *Settings › Rotate now*). The retired private key is kept for 8 days, so messages already queued on the relay (max 7 days) can still be read. After that it is destroyed.

Every message is encrypted separately for each recipient device. It uses a **fresh ephemeral X25519 key** combined with the recipient's current prekey (HKDF-SHA256 → XChaCha20-Poly1305), and the envelope is **signed with the sender's identity key**. As a result:

- the relay only sees ciphertext and can't forge or alter messages, because signatures are checked against pinned identity keys;
- a sender keeps no key that can decrypt what it sent;
- if a device is compromised, ciphertext captured more than ~15 days earlier (rotation interval + grace) can't be decrypted. This is bounded forward secrecy, not per-message ratcheting.
- clients **pin identity keys on first use**. A device whose identity key changes is blocked and the chat shows a warning. A contact signing in on a new device also shows a note.

The relay still sees metadata (who talks to whom, when).

### When mail.tm deletes the inbox

Temp inboxes are disposable, so the account never depends on one:

1. **Recovery code.** A 100-bit code is issued at sign-up and shown in the recovery kit. *Welcome › Restore with recovery code* (handle + code) signs in **without any email**. Codes are single-use, so a new one is issued each time one is used. You can also regenerate it in Settings.
2. **Automatic inbox replacement.** Once a day a signed-in device checks that its inbox still exists. If mail.tm has deleted it, the device creates a new inbox, rebinds the account to it (OTP-verified via `/api/me/email/*`) and shares the new credentials with your other devices over E2E sync. If two devices replace it at the same moment, they converge on the address the server last verified. *Settings › Check* does the same on demand.
3. **Device linking.** *Settings › Link a new device* shows a 10-minute, single-use code. On the new device, *Welcome › Link to my other device* signs in with that code, and the existing device sends it the inbox credentials and recovery code end-to-end encrypted.

The only unrecoverable case is losing **every** device **and** the recovery code.

## Local development

Requires Node 22+ and pnpm 10.

```bash
pnpm install
cp apps/server/.dev.vars.example apps/server/.dev.vars   # then set JWT_SECRET; DEV_OTP_ECHO=1
pnpm --filter @njm/server gen:vapid >> apps/server/.dev.vars   # Web Push keys
pnpm --filter @njm/server db:migrate:local
pnpm dev:server          # http://localhost:8787
pnpm dev:client          # http://localhost:5173  (uses apps/client/.env.local → VITE_API_URL)
pnpm dev:desktop         # Electron pointed at the Vite dev server
```

With `DEV_OTP_ECHO=1` and no `RESEND_API_KEY`, `/api/auth/start` returns the code in its response, so local sign-up works without sending email. The disposable inbox is still created for real.

Tests:

```bash
pnpm test                                   # crypto, protocol, JWT/OTP/VAPID, local DB + timers
pnpm --filter @njm/server test:e2e          # against a running `pnpm dev:server`: auth, relay, offline queue,
                                            # ack-deletion, key rotation, recovery codes, device linking, inbox rebind, files
```

## Deploy the backend (Cloudflare)

```bash
cd apps/server
npx wrangler d1 create njm-messaging            # put database_id in wrangler.jsonc
npx wrangler kv namespace create KV             # put id in wrangler.jsonc
npx wrangler r2 bucket create njm-messaging-files
npx wrangler r2 bucket lifecycle add njm-messaging-files expire-files files/ --expire-days 1
pnpm db:migrate:remote

npx wrangler secret put JWT_SECRET              # long random string
npx wrangler secret put RESEND_API_KEY          # https://resend.com, with a verified sending domain
npx wrangler secret put VAPID_PUBLIC_KEY        # from `pnpm gen:vapid`
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put FCM_SERVICE_ACCOUNT     # Firebase service-account JSON (one line)
# edit vars in wrangler.jsonc: EMAIL_FROM (on your Resend domain), VAPID_SUBJECT
pnpm deploy
```

## Releases (GitHub Actions)

Push a tag to build and publish a GitHub Release:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

`.github/workflows/release.yml` runs the tests, then builds in parallel:

| Artifact | Runner | Notes |
|---|---|---|
| `Ephemeral-X.Y.Z.apk` + `.aab` | ubuntu | signed with your release key. The build fails rather than ship an unsigned APK, and `apksigner verify` checks it. |
| `Ephemeral-X.Y.Z-linux-x86_64.AppImage`, `…-linux-amd64.deb` | ubuntu | |
| `Ephemeral-X.Y.Z-windows-x64-setup.exe` | windows | NSIS installer. Unsigned unless you add a code-signing cert. |

It then attaches all of them, plus `SHA256SUMS.txt`, to the release. Android `versionCode` is derived from the tag (`MAJOR*1e6 + MINOR*1e3 + PATCH`), so every release must use a higher tag. You can also run the workflow manually ("Run workflow" with a version) to build artifacts without publishing.

One-time setup (repo **Settings › Secrets and variables › Actions**):

| Name | Kind | Value |
|---|---|---|
| `API_URL` | variable | deployed Worker origin, e.g. `https://njm-messaging.<you>.workers.dev` |
| `ANDROID_KEYSTORE_BASE64` | secret | `base64 -w0 ephemeral-release.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | secret | keystore password |
| `ANDROID_KEY_ALIAS` | secret | `ephemeral` (default) |
| `ANDROID_KEY_PASSWORD` | secret | key password (same as keystore by default) |
| `GOOGLE_SERVICES_JSON` | secret | contents of Firebase `google-services.json` (for push) |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | secret, optional | Windows code-signing certificate (base64 .pfx) + password |

Create the release keystore once with `scripts/gen-android-keystore.sh`. **Back up the `.jks` file and password.** Android only accepts updates signed with the same key.

## Build the apps

Set `VITE_API_URL` to the deployed Worker origin (for example `https://njm-messaging.<you>.workers.dev`) in `apps/client/.env.production`.

**Web / PWA.** Run `pnpm --filter @njm/client build`, then host `apps/client/dist` on any static host (Cloudflare Pages: `npx wrangler pages deploy apps/client/dist`). It installs as a PWA and receives Web Push.

**Android APK.** You need the Android SDK (Android Studio) and a Firebase project:
1. In Firebase, add an Android app with package `tech.njm.ephemeral` and download `google-services.json` to `apps/client/android/app/`. It is gitignored.
2. Run `pnpm --filter @njm/client android:apk`. The output is `apps/client/android/app/build/outputs/apk/debug/app-debug.apk`.
   For a release build, run `pnpm --filter @njm/client android:open` and use *Build › Generate Signed Bundle/APK*.
3. Debug builds allow cleartext HTTP, so an emulator can reach a local Worker at `VITE_API_URL=http://10.0.2.2:8787`.

**Desktop.** Run `pnpm --filter @njm/desktop dist:linux` (AppImage) or `dist:win` (NSIS, on Windows). Output goes to `apps/desktop/release/`. Closing the window hides it to the tray, so messages and notifications keep arriving. "Launch at login" is in the tray menu.
