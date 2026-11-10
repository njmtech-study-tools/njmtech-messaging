import { useState } from "react";
import { useHistory } from "react-router-dom";
import {
  IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonInput, IonItem, IonList,
  IonPage, IonText, IonTitle, IonToolbar, useIonToast,
} from "@ionic/react";
import { copyOutline, shareSocialOutline } from "ionicons/icons";
import type { PublicUser } from "@njm/shared";
import { api, ApiError } from "../services/api";
import { useSession } from "../session";

export default function NewChat() {
  const { identity, messenger, prefs } = useSession();
  const history = useHistory();
  const [handle, setHandle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast] = useIonToast();

  const start = async () => {
    const h = handle.trim().replace(/^@/, "").toLowerCase();
    if (!h) return;
    if (h === identity.user.handle) return setError("That's you.");
    setBusy(true);
    setError(null);
    try {
      const { user } = await api<{ user: PublicUser }>(`/users/by-handle/${encodeURIComponent(h)}`);
      await messenger.ensureContact(user, prefs.defaultTimer);
      history.replace(`/chat/${user.id}`);
      setHandle("");
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? `No one is using @${h}.` : "Lookup failed. Are you online?");
    } finally {
      setBusy(false);
    }
  };

  const myHandle = `@${identity.user.handle}`;
  const share = async () => {
    const text = `Message me on Ephemeral: ${myHandle}`;
    if (navigator.share) await navigator.share({ text }).catch(() => {});
    else {
      await navigator.clipboard.writeText(myHandle);
      void toast({ message: "Handle copied", duration: 1500 });
    }
  };

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton defaultHref="/chats" />
          </IonButtons>
          <IonTitle>New chat</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding">
        <div className="app-max" style={{ maxWidth: 520 }}>
          <IonList inset>
            <IonItem>
              <IonInput
                label="@"
                placeholder="their_handle"
                value={handle}
                autocapitalize="off"
                autocorrect="off"
                onIonInput={(e) => setHandle(String(e.detail.value ?? ""))}
                onKeyDown={(e) => e.key === "Enter" && void start()}
              />
            </IonItem>
          </IonList>
          {error && <IonText color="danger"><p style={{ paddingLeft: 20 }}>{error}</p></IonText>}
          <IonButton expand="block" onClick={start} disabled={!handle.trim() || busy}>
            Start chat
          </IonButton>

          <h3 style={{ marginTop: 40 }}>Your handle</h3>
          <p className="hint">Share it so people can reach you.</p>
          <IonItem lines="none">
            <strong style={{ fontSize: 20 }}>{myHandle}</strong>
            <IonButton slot="end" fill="clear" onClick={() => void navigator.clipboard.writeText(myHandle).then(() => toast({ message: "Copied", duration: 1200 }))} aria-label="Copy">
              <IonIcon slot="icon-only" icon={copyOutline} />
            </IonButton>
            <IonButton slot="end" fill="clear" onClick={share} aria-label="Share">
              <IonIcon slot="icon-only" icon={shareSocialOutline} />
            </IonButton>
          </IonItem>
        </div>
      </IonContent>
    </IonPage>
  );
}
