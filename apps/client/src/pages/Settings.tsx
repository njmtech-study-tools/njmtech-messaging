import { useEffect, useRef, useState } from "react";
import {
  IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonItem, IonLabel, IonList, IonListHeader,
  IonNote, IonPage, IonSelect, IonSelectOption, IonSpinner, IonTitle, IonToggle, IonToolbar, useIonAlert, useIonToast,
} from "@ionic/react";
import { currentPrekey, fingerprint, PREKEY_ROTATE_MS } from "@njm/shared";
import { api } from "../services/api";
import { recoveryKit } from "../services/auth";
import { checkInbox, replaceInbox } from "../services/inbox";
import { disablePush, enablePush, sendTestPush } from "../services/push";
import type { Identity } from "../services/storage";
import { useSession } from "../session";
import { shortTime, TIMER_OPTIONS } from "../util";

interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  createdAt: number;
  lastSeen: number;
  push: string | null;
  identityKey: string;
  prekeyId: number;
  prekeyAt: number;
}

const ago = (ts: number) => {
  const d = Math.floor((Date.now() - ts) / 86400_000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
};

export default function Settings() {
  const { messenger, prefs, updatePrefs, signOut } = useSession();
  const [identity, setIdentity] = useState<Identity>({ ...messenger.id });
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [showKit, setShowKit] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [linkCode, setLinkCode] = useState<{ code: string; until: number } | null>(null);
  const linkWatch = useRef<AbortController | null>(null);
  const [alert] = useIonAlert();
  const [toast] = useIonToast();

  const kit = JSON.stringify(recoveryKit(identity));
  const prekey = currentPrekey(identity.keys);
  const retired = identity.keys.prekeys.length - 1;

  const loadDevices = () => api<{ devices: DeviceRow[] }>("/devices").then((r) => setDevices(r.devices)).catch(() => {});
  useEffect(() => {
    void loadDevices();
    const off = messenger.onIdentity((id) => setIdentity({ ...id, keys: { ...id.keys } }));
    return () => {
      off();
      linkWatch.current?.abort();
    };
  }, [messenger]);

  const task = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try {
      await fn();
    } catch (e) {
      void toast({ message: (e as Error).message || "Something went wrong", duration: 3500, color: "danger" });
    } finally {
      setBusy(null);
    }
  };

  const toggleNotifications = async (on: boolean) => {
    if (on) {
      const state = await enablePush().catch(() => "unavailable" as const);
      if (state !== "enabled") {
        const message = {
          denied: "Notifications are blocked in system settings.",
          "ios-install": "On iPhone, tap Share › Add to Home Screen, open Ephemeral from there, then turn notifications on.",
          "ios-update": "Notifications need iOS 16.4 or later.",
        }[state as string] ?? "Push isn't available on this device.";
        void toast({ message, duration: state.startsWith("ios") ? 6000 : 3000 });
      } else {
        // Like the wealth-board app: confirm with a real notification.
        void sendTestPush();
      }
      await updatePrefs({ notifications: state === "enabled" });
    } else {
      await disablePush().catch(() => {});
      await updatePrefs({ notifications: false });
    }
    void loadDevices();
  };

  const copyKit = async () => {
    await navigator.clipboard.writeText(kit);
    await updatePrefs({ kitSaved: true });
    void toast({ message: "Recovery kit copied. Store it somewhere safe.", duration: 2500 });
  };

  const downloadKit = async () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([kit], { type: "application/json" }));
    a.download = `ephemeral-${identity.user.handle}-recovery.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    await updatePrefs({ kitSaved: true });
  };

  const rotateNow = () =>
    task("rotate", async () => {
      await messenger.rotateKeys(true);
      void loadDevices();
      void toast({ message: "New message key published. The old one is destroyed after 8 days.", duration: 3000 });
    });

  const newRecoveryCode = () =>
    alert({
      header: "Generate a new recovery code?",
      message: "Your current code and any saved recovery kit stop working.",
      buttons: [
        "Cancel",
        {
          text: "Generate",
          handler: () =>
            void task("code", async () => {
              const { recoveryCode } = await api<{ recoveryCode: string }>("/me/recovery-code", { method: "POST" });
              await messenger.updateIdentity({ recoveryCode }, { sync: true });
              await updatePrefs({ kitSaved: false });
              setShowKit(true);
            }),
        },
      ],
    });

  const checkOrReplaceInbox = () =>
    task("inbox", async () => {
      const status = await checkInbox(messenger.id);
      if (status === "ok") {
        void toast({ message: "Your temp inbox is alive.", duration: 2500 });
        return;
      }
      if (status === "unknown") throw new Error("Couldn't reach the temp-mail service. Try again later.");
      await replaceInbox(messenger.id);
      await messenger.updateIdentity({ mailbox: messenger.id.mailbox }, { sync: true });
      await updatePrefs({ kitSaved: false, lastInboxCheck: Date.now() });
      void toast({ message: "New inbox attached. Save your updated recovery kit.", duration: 4000 });
    });

  const startLink = () =>
    task("link", async () => {
      const r = await api<{ code: string; expiresIn: number }>("/devices/link-code", { method: "POST" });
      setLinkCode({ code: r.code, until: Date.now() + r.expiresIn * 1000 });
      linkWatch.current?.abort();
      const ctrl = new AbortController();
      linkWatch.current = ctrl;
      setTimeout(() => ctrl.abort(), r.expiresIn * 1000);
      void messenger.watchForNewDevice(ctrl.signal).then((linked) => {
        setLinkCode(null);
        if (linked) {
          void loadDevices();
          void toast({ message: "New device linked. Your recovery details were sent to it, encrypted.", duration: 3500 });
        }
      });
    });

  const removeDevice = (d: DeviceRow) =>
    alert({
      header: `Remove ${d.name}?`,
      message: "It will be signed out and stop receiving messages.",
      buttons: [
        "Cancel",
        { text: "Remove", role: "destructive", handler: () => void api(`/devices/${d.id}`, { method: "DELETE" }).then(loadDevices) },
      ],
    });

  const logout = () =>
    alert({
      header: "Sign out of this device?",
      message: "All chats on this device are wiped. You can sign back in with your recovery code or from another device.",
      buttons: ["Cancel", { text: "Sign out", role: "destructive", handler: () => void signOut({ remote: true }) }],
    });

  const deleteAccount = () =>
    alert({
      header: "Delete account?",
      message: `@${identity.user.handle} is released, all devices are signed out and pending messages are destroyed. This cannot be undone.`,
      buttons: [
        "Cancel",
        { text: "Delete forever", role: "destructive", handler: () => void api("/me", { method: "DELETE" }).then(() => signOut()) },
      ],
    });

  const spin = (name: string, label: string) => (busy === name ? <IonSpinner name="dots" /> : label);

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton defaultHref="/chats" />
          </IonButtons>
          <IonTitle>Settings</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <div className="app-max">
          <IonList inset>
            <IonListHeader>Account</IonListHeader>
            <IonItem>
              <IonLabel>Handle</IonLabel>
              <IonNote slot="end">@{identity.user.handle}</IonNote>
            </IonItem>
            <IonItem>
              <IonLabel className="ion-text-wrap">
                Disposable inbox
                <p>{identity.mailbox?.address ?? "Waiting for your other device to share it…"}</p>
              </IonLabel>
              <IonButton slot="end" fill="clear" disabled={!!busy || !identity.mailbox} onClick={checkOrReplaceInbox}>
                {spin("inbox", "Check")}
              </IonButton>
            </IonItem>
          </IonList>

          <IonList inset>
            <IonListHeader>Encryption keys</IonListHeader>
            <IonItem>
              <IonLabel className="ion-text-wrap">
                Safety number (this device)
                <p style={{ fontFamily: "monospace" }}>{fingerprint(identity.keys.identity.publicKey)}</p>
                <p>Stays the same when keys rotate. Compare it with your contact's to rule out interception.</p>
              </IonLabel>
            </IonItem>
            <IonItem>
              <IonLabel className="ion-text-wrap">
                Message key #{prekey.id}
                <p>
                  Created {ago(prekey.createdAt)} · next rotation in{" "}
                  {Math.max(0, Math.ceil((prekey.createdAt + PREKEY_ROTATE_MS - Date.now()) / 86400_000))} days
                  {retired > 0 && ` · ${retired} retired key${retired > 1 ? "s" : ""} kept for in-flight messages`}
                </p>
              </IonLabel>
              <IonButton slot="end" fill="clear" disabled={!!busy} onClick={rotateNow}>
                {spin("rotate", "Rotate now")}
              </IonButton>
            </IonItem>
          </IonList>

          <IonList inset>
            <IonListHeader>Notifications & privacy</IonListHeader>
            <IonItem>
              <IonToggle checked={prefs.notifications} onIonChange={(e) => void toggleNotifications(e.detail.checked)}>
                Notifications
              </IonToggle>
            </IonItem>
            <IonItem>
              <IonSelect
                label="Default disappearing timer"
                value={prefs.defaultTimer}
                onIonChange={(e) => void updatePrefs({ defaultTimer: Number(e.detail.value) })}
              >
                {TIMER_OPTIONS.map((o) => (
                  <IonSelectOption key={o.value} value={o.value}>
                    {o.label}
                  </IonSelectOption>
                ))}
              </IonSelect>
            </IonItem>
          </IonList>

          <IonList inset>
            <IonListHeader>Recovery</IonListHeader>
            <IonItem lines="none">
              <IonLabel className="ion-text-wrap hint">
                Your <strong>recovery code</strong> signs you back in even if the temp inbox has been deleted. Each code
                works once, and a new one is issued when you use it. The kit also holds the inbox login. Anyone with the
                kit can sign in as you, so keep it private.
              </IonLabel>
            </IonItem>
            {showKit && (
              <IonItem lines="none">
                <div style={{ width: "100%" }}>
                  <p style={{ margin: "0 0 6px" }}>Recovery code</p>
                  <div className="kit" style={{ fontSize: 16, letterSpacing: 1 }}>{identity.recoveryCode ?? "Waiting for sync…"}</div>
                  <p style={{ margin: "12px 0 6px" }}>Full kit</p>
                  <div className="kit">{kit}</div>
                </div>
              </IonItem>
            )}
            <IonItem lines="none">
              <IonButton fill="outline" onClick={() => setShowKit(!showKit)}>{showKit ? "Hide" : "Show"}</IonButton>
              <IonButton fill="outline" onClick={copyKit}>Copy kit</IonButton>
              <IonButton fill="outline" onClick={downloadKit}>Download</IonButton>
            </IonItem>
            <IonItem button detail={false} disabled={!!busy} onClick={newRecoveryCode}>
              <IonLabel color="primary">{spin("code", "Generate a new recovery code")}</IonLabel>
            </IonItem>
          </IonList>

          <IonList inset>
            <IonListHeader>Devices</IonListHeader>
            {devices.map((d) => (
              <IonItem key={d.id}>
                <IonLabel className="ion-text-wrap">
                  {d.name} {d.id === identity.deviceId && <IonNote>(this device)</IonNote>}
                  <p>
                    Last seen {shortTime(d.lastSeen)} · push: {d.push ?? "off"} · key #{d.prekeyId}
                  </p>
                  <p style={{ fontFamily: "monospace" }}>{d.identityKey ? fingerprint(d.identityKey) : ""}</p>
                </IonLabel>
                {d.id !== identity.deviceId && (
                  <IonButton slot="end" fill="clear" color="danger" onClick={() => removeDevice(d)}>
                    Remove
                  </IonButton>
                )}
              </IonItem>
            ))}
            {linkCode ? (
              <IonItem lines="none">
                <IonLabel className="ion-text-wrap">
                  Enter this on the new device (Welcome › Link to my other device):
                  <div className="kit" style={{ fontSize: 24, textAlign: "center", letterSpacing: 4, marginTop: 8 }}>{linkCode.code}</div>
                  <p>
                    <IonSpinner name="dots" style={{ verticalAlign: "middle" }} /> Waiting for the new device · expires{" "}
                    {new Date(linkCode.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </p>
                </IonLabel>
              </IonItem>
            ) : (
              <IonItem button detail={false} disabled={!!busy} onClick={startLink}>
                <IonLabel color="primary">{spin("link", "Link a new device")}</IonLabel>
              </IonItem>
            )}
          </IonList>

          <IonList inset>
            <IonItem button onClick={logout}>
              <IonLabel color="danger">Sign out of this device</IonLabel>
            </IonItem>
            <IonItem button onClick={deleteAccount}>
              <IonLabel color="danger">Delete account</IonLabel>
            </IonItem>
          </IonList>
        </div>
      </IonContent>
    </IonPage>
  );
}
