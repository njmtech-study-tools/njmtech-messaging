/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: any };

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

self.addEventListener("install", () => void self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// Push messages are content-free: message text never travels through push services. The
// server sends an encrypted { title, body, tag, url?, always? } (see apps/server/src/push/webpush.ts);
// older payload-less pushes fall back to the generic "new message" notification.
interface PushNotification { title?: string; body?: string; tag?: string; url?: string; always?: boolean }
const NEW_MESSAGE = { title: "New message", body: "Open Ephemeral to read it", tag: "new-message" };
/** Tags the server uses for its own notifications (not chat peers). */
const SYSTEM_TAGS = new Set(["new-message", "push-test"]);

self.addEventListener("push", (event) => {
  let data: PushNotification = {};
  try {
    data = event.data ? (event.data.json() as PushNotification) : {};
  } catch {
    data = {};
  }
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // App is open: it shows its own UI. Test notifications always show.
      if (!data.always && windows.some((c) => c.visibilityState === "visible")) return;
      await self.registration.showNotification(data.title || NEW_MESSAGE.title, {
        body: data.body || NEW_MESSAGE.body,
        tag: data.tag || NEW_MESSAGE.tag,
        icon: "pwa-192x192.png",
        badge: "pwa-64x64.png",
        data: { url: data.url || "./" },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const tag = event.notification.tag;
  const isPeer = Boolean(tag) && !SYSTEM_TAGS.has(tag);
  const target = isPeer ? `./#/chat/${tag}` : (event.notification.data?.url as string | undefined) || "./";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows[0] as WindowClient | undefined;
      if (existing) {
        await existing.focus();
        if (isPeer) existing.postMessage({ type: "open-chat", peer: tag });
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
