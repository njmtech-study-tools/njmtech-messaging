import { createContext, useContext } from "react";
import type { Messenger } from "./services/messenger";
import type { Identity, Prefs } from "./services/storage";

export interface Session {
  identity: Identity;
  messenger: Messenger;
  prefs: Prefs;
  updatePrefs(p: Partial<Prefs>): Promise<void>;
  signOut(opts?: { remote?: boolean }): Promise<void>;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("no session");
  return s;
}
