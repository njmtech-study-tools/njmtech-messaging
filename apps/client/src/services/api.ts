import { API_URL } from "../config";

export class ApiError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

let token: string | null = null;
let onUnauthorized: (() => void) | null = null;

export const setToken = (t: string | null) => (token = t);
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`${API_URL}/api${path}`, { ...init, headers, body });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `http_${res.status}` }));
    if (res.status === 401 && token && path !== "/auth/verify") onUnauthorized?.();
    throw new ApiError(res.status, err.error ?? `http_${res.status}`);
  }
  const ct = res.headers.get("Content-Type") ?? "";
  return (ct.includes("json") ? res.json() : res.arrayBuffer()) as Promise<T>;
}
