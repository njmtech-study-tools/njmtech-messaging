import { platform } from "../config";
import { navigate } from "../nav";

/** Local notification raised by the running app (decrypted on-device, never sent through push services). */
export async function notifyLocal(title: string, body: string, tag: string) {
  if (platform === "android") return; // foreground Android uses in-app toasts; background uses FCM
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
  if (reg) {
    await reg.showNotification(title, { body, tag, icon: "pwa-192x192.png" });
  } else {
    const n = new Notification(title, { body, tag });
    n.onclick = () => {
      window.ephemeralDesktop?.focus();
      window.focus();
      navigate(`/chat/${tag}`);
    };
  }
}
