import { PushNotifications } from "@capacitor/push-notifications";
import { fromB64Url } from "@njm/shared";
import { platform } from "../config";
import { api } from "./api";

/**
 * "ios-install": iPhone/iPad in a Safari tab. iOS only allows web push for apps added to the
 * Home Screen (iOS 16.4+). "ios-update": installed on the Home Screen, but iOS is older than 16.4.
 */
export type PushState = "enabled" | "denied" | "unavailable" | "disabled" | "ios-install" | "ios-update";

export function isIos(): boolean {
  // iPadOS reports itself as a Mac; touch support gives it away.
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/** Opened from the Home Screen (installed) rather than a browser tab. */
export function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** Sends a test notification to this device. Best effort. */
export async function sendTestPush(): Promise<void> {
  await api("/push/test", { method: "POST" }).catch(() => {});
}

/** Registers this device for content-free "new message" wake-ups. */
export async function enablePush(): Promise<PushState> {
  if (platform === "android") return enableAndroid();
  if (platform === "desktop") {
    // Electron keeps the socket alive from the tray; notifications are raised locally.
    const p = "Notification" in window ? await Notification.requestPermission() : "denied";
    await api("/push/register", { method: "POST", json: { kind: "none" } });
    return p === "granted" ? "enabled" : "denied";
  }
  return enableWeb();
}

export async function disablePush(): Promise<void> {
  if (platform === "web" && "serviceWorker" in navigator) {
    const reg = await navigator.serviceWorker.getRegistration();
    await (await reg?.pushManager.getSubscription())?.unsubscribe();
  }
  if (platform === "android") await PushNotifications.unregister().catch(() => {});
  await api("/push/register", { method: "POST", json: { kind: "none" } });
}

async function enableWeb(): Promise<PushState> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    if (isIos()) return isStandalone() ? "ios-update" : "ios-install";
    return "unavailable";
  }
  // Ask first, while still inside the tap: Safari (iOS) drops the prompt if anything
  // asynchronous runs before it.
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return "denied";
  const { publicKey } = await api<{ publicKey: string | null }>("/push/vapid");
  if (!publicKey) return "unavailable";
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64Url(publicKey) as BufferSource });
  }
  await api("/push/register", { method: "POST", json: { kind: "webpush", subscription: sub.toJSON() } });
  return "enabled";
}

let androidListeners = false;

async function enableAndroid(): Promise<PushState> {
  let perm = await PushNotifications.checkPermissions();
  if (perm.receive === "prompt" || perm.receive === "prompt-with-rationale") perm = await PushNotifications.requestPermissions();
  if (perm.receive !== "granted") return "denied";
  await PushNotifications.createChannel({
    id: "messages",
    name: "Messages",
    description: "New message alerts",
    importance: 5,
    visibility: 0, // private: hide details on the lock screen
    vibration: true,
  }).catch(() => {});
  if (!androidListeners) {
    androidListeners = true;
    await PushNotifications.addListener("registration", (t) => {
      void api("/push/register", { method: "POST", json: { kind: "fcm", token: t.value } });
    });
    await PushNotifications.addListener("registrationError", (e) => console.warn("FCM registration failed", e));
  }
  await PushNotifications.register();
  return "enabled";
}
