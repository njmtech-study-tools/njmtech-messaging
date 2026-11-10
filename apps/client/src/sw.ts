/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: any };

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

self.addEventListener("install", () => void self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// Push messages are content-free wake-ups: message text never travels through push services.
self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (windows.some((c) => c.visibilityState === "visible")) return; // app is open; it shows its own UI
      await self.registration.showNotification("New message", {
        body: "Open Ephemeral to read it",
        tag: "new-message",
        icon: "pwa-192x192.png",
        badge: "pwa-64x64.png",
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const tag = event.notification.tag;
  const target = tag && tag !== "new-message" ? `./#/chat/${tag}` : "./";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows[0] as WindowClient | undefined;
      if (existing) {
        await existing.focus();
        if (tag !== "new-message") existing.postMessage({ type: "open-chat", peer: tag });
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
