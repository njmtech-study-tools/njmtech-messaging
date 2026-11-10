import { Capacitor } from "@capacitor/core";

declare global {
  interface Window {
    ephemeralDesktop?: { platform: "desktop"; setBadge(n: number): void; focus(): void };
  }
}

export type Platform = "web" | "android" | "desktop";

export const platform: Platform = typeof window !== "undefined" && window.ephemeralDesktop
  ? "desktop"
  : Capacitor.getPlatform() === "android"
    ? "android"
    : "web";

/** API origin. Empty = same origin (PWA served by the Worker). */
export const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";

export const wsUrl = () => {
  const base = API_URL || location.origin;
  return `${base.replace(/^http/, "ws")}/api/ws`;
};
