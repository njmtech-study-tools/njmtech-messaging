/** Lets non-React code (notifications, toasts, service-worker messages) navigate via Ionic's router. */
let push: ((path: string) => void) | null = null;

export const setNavigator = (fn: ((path: string) => void) | null) => (push = fn);

export function navigate(path: string) {
  if (push) push(path);
  else location.hash = `#${path}`;
}
