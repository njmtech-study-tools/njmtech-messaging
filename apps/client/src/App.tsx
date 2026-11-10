import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { IonApp, IonRouterOutlet, IonSpinner, useIonRouter, useIonToast } from "@ionic/react";
import { IonReactHashRouter } from "@ionic/react-router";
import { Redirect, Route } from "react-router-dom";
import { App as CapApp } from "@capacitor/app";
import { useLiveQuery } from "dexie-react-hooks";

import { db } from "./db";
import { platform } from "./config";
import { api, setToken, setUnauthorizedHandler } from "./services/api";
import { Messenger, preview } from "./services/messenger";
import { clearAll, loadIdentity, loadPrefs, savePrefs, type Identity, type Prefs } from "./services/storage";
import { enablePush } from "./services/push";
import { notifyLocal } from "./services/notify";
import { checkInbox, replaceInbox } from "./services/inbox";
import { SessionContext, type Session } from "./session";
import { navigate, setNavigator } from "./nav";
import Onboarding from "./pages/Onboarding";
import Chats from "./pages/Chats";
import Chat from "./pages/Chat";
import NewChat from "./pages/NewChat";
import Settings from "./pages/Settings";

export default function App() {
  const [ready, setReady] = useState(false);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [prefs, setPrefs] = useState<Prefs>({ defaultTimer: 0, notifications: true, kitSaved: false, lastInboxCheck: 0 });

  useEffect(() => {
    void (async () => {
      const [id, p] = await Promise.all([loadIdentity(), loadPrefs()]);
      setPrefs(p);
      setIdentity(id);
      setReady(true);
    })();
  }, []);

  const signOut = useCallback(async (opts: { remote?: boolean } = {}) => {
    if (opts.remote && identity) await api(`/devices/${identity.deviceId}`, { method: "DELETE" }).catch(() => {});
    await db.delete();
    await db.open();
    await clearAll();
    setToken(null);
    setIdentity(null);
  }, [identity]);

  if (!ready) {
    return (
      <IonApp>
        <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
          <IonSpinner />
        </div>
      </IonApp>
    );
  }

  if (!identity) {
    return (
      <IonApp>
        <Onboarding onDone={setIdentity} />
      </IonApp>
    );
  }

  return (
    <SignedIn
      key={identity.deviceId}
      identity={identity}
      prefs={prefs}
      setPrefs={setPrefs}
      signOut={signOut}
    />
  );
}

function SignedIn(props: {
  identity: Identity;
  prefs: Prefs;
  setPrefs: (p: Prefs) => void;
  signOut: Session["signOut"];
}) {
  const { identity, prefs } = props;
  const messenger = useMemo(() => {
    setToken(identity.token);
    return new Messenger(identity);
  }, [identity]);

  useEffect(() => {
    setUnauthorizedHandler(() => void props.signOut());
    messenger.start();
    const kick = () => messenger.kick();
    window.addEventListener("online", kick);
    document.addEventListener("visibilitychange", kick);
    // Notification clicks handled by the service worker while a window is already open.
    const onSwMessage = (e: MessageEvent) => {
      if (e.data?.type === "open-chat" && typeof e.data.peer === "string") navigate(`/chat/${e.data.peer}`);
    };
    navigator.serviceWorker?.addEventListener("message", onSwMessage);
    const appState = CapApp.addListener("appStateChange", (s) => s.isActive && kick());
    if (prefs.notifications) void enablePush().catch((e) => console.warn("push", e));
    return () => {
      messenger.stop();
      window.removeEventListener("online", kick);
      document.removeEventListener("visibilitychange", kick);
      navigator.serviceWorker?.removeEventListener("message", onSwMessage);
      void appState.then((h) => h.remove());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messenger]);

  // Unread badge: window title, PWA app badge, Electron dock/taskbar.
  const unread = useLiveQuery(async () => (await db.contacts.toArray()).reduce((n, c) => n + c.unread, 0), [], 0);
  useEffect(() => {
    document.title = unread ? `(${unread}) Ephemeral` : "Ephemeral";
    window.ephemeralDesktop?.setBadge(unread);
    const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (platform === "web") void (unread ? nav.setAppBadge?.(unread) : nav.clearAppBadge?.())?.catch(() => {});
  }, [unread]);

  const latestPrefs = useRef(prefs);
  latestPrefs.current = prefs;

  const session: Session = {
    identity,
    messenger,
    prefs,
    updatePrefs: async (p) => {
      // Merge into the latest prefs (callers may hold an older render's session).
      const next = { ...latestPrefs.current, ...p };
      latestPrefs.current = next;
      props.setPrefs(next);
      await savePrefs(next);
    },
    signOut: props.signOut,
  };

  return (
    <SessionContext.Provider value={session}>
      <IonApp>
        <IonReactHashRouter>
          <NavBridge />
          <IncomingAlerts />
          <InboxGuard />
          <IonRouterOutlet>
            <Route exact path="/chats" component={Chats} />
            <Route exact path="/chat/:peer" component={Chat} />
            <Route exact path="/new" component={NewChat} />
            <Route exact path="/settings" component={Settings} />
            <Route exact path="/">
              <Redirect to="/chats" />
            </Route>
          </IonRouterOutlet>
        </IonReactHashRouter>
      </IonApp>
    </SessionContext.Provider>
  );
}

function NavBridge() {
  const router = useIonRouter();
  useEffect(() => {
    setNavigator((path) => router.push(path, "forward"));
    return () => void setNavigator(null);
  }, [router]);
  return null;
}

/** In-app toast when the app is visible; local system notification when it is in the background. */
function IncomingAlerts() {
  const { messenger, prefs } = useContext(SessionContext)!;
  const [presentToast] = useIonToast();
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  useEffect(() => {
    const off = messenger.onIncoming((msg, contact) => {
      const body = preview(msg);
      if (document.visibilityState === "hidden") {
        if (prefsRef.current.notifications) void notifyLocal(`@${contact.handle}`, body, contact.id);
        return;
      }
      void presentToast({
        message: `@${contact.handle}: ${body.slice(0, 80)}`,
        duration: 3500,
        position: "top",
        buttons: [{ text: "Open", handler: () => navigate(`/chat/${contact.id}`) }],
      });
    });
    return () => void off();
  }, [messenger, presentToast]);
  return null;
}

const INBOX_CHECK_MS = 24 * 3600 * 1000;

/**
 * Temp inboxes can be deleted by the provider at any time. Once a day, verify ours still
 * exists; if not, create a new one, rebind the account to it (OTP-verified) and share the
 * new credentials with the user's other devices. Recovery codes keep working regardless.
 */
function InboxGuard() {
  const { messenger, prefs, updatePrefs } = useContext(SessionContext)!;
  const [presentToast] = useIonToast();
  const lastCheck = useRef(prefs.lastInboxCheck);
  useEffect(() => {
    const ctrl = new AbortController();
    const run = async () => {
      if (Date.now() - lastCheck.current < INBOX_CHECK_MS) return;
      const id = messenger.id;
      if (!id.mailbox) {
        // A linked device receives the inbox from its siblings via E2E sync; only a lone
        // device (e.g. recovered with handle + code) provisions a fresh inbox itself.
        const { devices } = await api<{ devices: unknown[] }>("/devices");
        if (devices.length > 1) return;
      }
      const status = await checkInbox(id);
      if (status === "unknown" || ctrl.signal.aborted) return;
      if (status === "missing") {
        await replaceInbox(id, ctrl.signal);
        await messenger.updateIdentity({ mailbox: id.mailbox }, { sync: true });
        await updatePrefs({ kitSaved: false });
        void presentToast({
          message: "Your temp inbox was gone, so a new one was set up. Save your updated recovery kit in Settings.",
          duration: 6000,
          position: "top",
        });
      }
      lastCheck.current = Date.now();
      await updatePrefs({ lastInboxCheck: lastCheck.current });
    };
    const kickoff = setTimeout(() => void run().catch((e) => console.warn("inbox check", e)), 5000);
    const every = setInterval(() => void run().catch((e) => console.warn("inbox check", e)), 3600 * 1000);
    return () => {
      ctrl.abort();
      clearTimeout(kickoff);
      clearInterval(every);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messenger]);
  return null;
}
