import { useEffect, useState } from "react";
import {
  IonBadge, IonButton, IonButtons, IonContent, IonFab, IonFabButton, IonHeader, IonIcon, IonItem,
  IonItemOption, IonItemOptions, IonItemSliding, IonLabel, IonList, IonNote, IonPage, IonTitle, IonToolbar,
  useIonAlert,
} from "@ionic/react";
import { add, chatbubblesOutline, settingsOutline, timerOutline } from "ionicons/icons";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db";
import { useSession } from "../session";
import type { ConnectionStatus } from "../services/messenger";
import { avatarColor, shortTime } from "../util";

export function useConnection(): ConnectionStatus {
  const { messenger } = useSession();
  const [s, setS] = useState<ConnectionStatus>(messenger.status);
  useEffect(() => {
    const off = messenger.onStatus(setS);
    return () => void off();
  }, [messenger]);
  return s;
}

export default function Chats() {
  const { identity, prefs } = useSession();
  const status = useConnection();
  const [alert] = useIonAlert();
  const contacts = useLiveQuery(() => db.contacts.orderBy("lastAt").reverse().toArray(), [], []);

  const removeChat = (id: string, handle: string) =>
    alert({
      header: `Delete chat with @${handle}?`,
      message: "Messages are removed from this device only.",
      buttons: [
        "Cancel",
        {
          text: "Delete",
          role: "destructive",
          handler: () => {
            void db.transaction("rw", db.messages, db.contacts, async () => {
              await db.messages.where("[peer+sentAt]").between([id, 0], [id, Infinity]).delete();
              await db.contacts.delete(id);
            });
          },
        },
      ],
    });

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>
            <span className={`status-dot ${status}`} title={status} />
            Chats
          </IonTitle>
          <IonButtons slot="end">
            <IonButton routerLink="/settings" aria-label="Settings">
              <IonIcon slot="icon-only" icon={settingsOutline} />
            </IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <div className="app-max">
          {!prefs.kitSaved && (
            <IonItem color="warning" routerLink="/settings" detail lines="none">
              <IonLabel className="ion-text-wrap">
                <strong>Save your recovery kit</strong>
                <p>It's the only way back into @{identity.user.handle} on a new device.</p>
              </IonLabel>
            </IonItem>
          )}
          {contacts.length === 0 ? (
            <div className="empty">
              <IonIcon icon={chatbubblesOutline} />
              <p>No conversations yet.</p>
              <IonButton routerLink="/new">Start a chat</IonButton>
            </div>
          ) : (
            <IonList>
              {contacts.map((c) => (
                <IonItemSliding key={c.id}>
                  <IonItem routerLink={`/chat/${c.id}`} detail={false}>
                    <div slot="start" className="avatar" style={{ background: avatarColor(c.id) }}>
                      {c.handle.slice(0, 1)}
                    </div>
                    <IonLabel>
                      <h2 style={{ fontWeight: c.unread ? 700 : 500 }}>
                        @{c.handle}{" "}
                        {c.timer > 0 && <IonIcon icon={timerOutline} style={{ verticalAlign: "-2px", opacity: 0.6 }} />}
                      </h2>
                      <p>{c.lastText || " "}</p>
                    </IonLabel>
                    <div slot="end" style={{ textAlign: "right" }}>
                      <IonNote style={{ fontSize: 12 }}>{c.lastText ? shortTime(c.lastAt) : ""}</IonNote>
                      <br />
                      {c.unread > 0 && <IonBadge color="primary">{c.unread}</IonBadge>}
                    </div>
                  </IonItem>
                  <IonItemOptions side="end">
                    <IonItemOption color="danger" onClick={() => removeChat(c.id, c.handle)}>
                      Delete
                    </IonItemOption>
                  </IonItemOptions>
                </IonItemSliding>
              ))}
            </IonList>
          )}
        </div>
        <IonFab vertical="bottom" horizontal="end" slot="fixed">
          <IonFabButton routerLink="/new" aria-label="New chat">
            <IonIcon icon={add} />
          </IonFabButton>
        </IonFab>
      </IonContent>
    </IonPage>
  );
}
