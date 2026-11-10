import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  IonBackButton, IonButton, IonButtons, IonContent, IonFooter, IonHeader, IonIcon, IonPage, IonSpinner,
  IonTextarea, IonTitle, IonToolbar, useIonActionSheet, useIonToast,
} from "@ionic/react";
import {
  alertCircleOutline, attachOutline, checkmarkDoneOutline, checkmarkOutline, documentOutline, send,
  timeOutline, timerOutline,
} from "ionicons/icons";
import Dexie from "dexie";
import { useLiveQuery } from "dexie-react-hooks";
import { db, type Message } from "../db";
import { useSession } from "../session";
import { timerLabel } from "../services/messenger";
import { formatBytes, remaining, TIMER_OPTIONS } from "../util";
import { useConnection } from "./Chats";

export default function Chat() {
  const { peer } = useParams<{ peer: string }>();
  const { messenger } = useSession();
  const status = useConnection();
  const [text, setText] = useState("");
  const textRef = useRef(""); // live value: Enter can fire before React re-renders with the latest input
  const [now, setNow] = useState(Date.now());
  const content = useRef<HTMLIonContentElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [sheet] = useIonActionSheet();
  const [toast] = useIonToast();

  const contact = useLiveQuery(() => db.contacts.get(peer), [peer]);
  const messages = useLiveQuery(
    () => db.messages.where("[peer+sentAt]").between([peer, Dexie.minKey], [peer, Dexie.maxKey]).toArray(),
    [peer],
    [] as Message[],
  );

  // Track the open conversation so it doesn't count as unread / notify.
  useEffect(() => {
    messenger.activePeer = peer;
    return () => {
      if (messenger.activePeer === peer) messenger.activePeer = null;
    };
  }, [messenger, peer]);

  useEffect(() => {
    if (document.visibilityState === "visible" && contact?.unread) void messenger.markRead(peer);
    const t = setTimeout(() => content.current?.scrollToBottom(150), 50);
    return () => clearTimeout(t);
  }, [messages.length, contact?.unread, messenger, peer]);

  // Tick for disappearing-message countdowns.
  const hasExpiring = messages.some((m) => m.expiresAt);
  useEffect(() => {
    if (!hasExpiring) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hasExpiring]);

  const submit = () => {
    const t = textRef.current.trim();
    if (!t) return;
    textRef.current = "";
    setText("");
    void messenger.sendText(peer, t);
  };

  const pickTimer = () =>
    sheet({
      header: "Disappearing messages",
      subHeader: "New messages in this chat delete themselves from both devices after:",
      buttons: [
        ...TIMER_OPTIONS.map((o) => ({
          text: o.label + (o.value === (contact?.timer ?? 0) ? "  ✓" : ""),
          handler: () => void messenger.setTimer(peer, o.value),
        })),
        { text: "Cancel", role: "cancel" },
      ],
    });

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    for (const f of files) {
      try {
        await messenger.sendFile(peer, f);
      } catch (err) {
        void toast({ message: (err as Error).message, duration: 3000, color: "danger" });
      }
    }
  };

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton defaultHref="/chats" />
          </IonButtons>
          <IonTitle>
            <span className={`status-dot ${status}`} title={status} />@{contact?.handle ?? "…"}
          </IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={pickTimer} aria-label="Disappearing messages timer">
              <IonIcon slot="start" icon={timerOutline} color={contact?.timer ? "primary" : undefined} />
              {contact?.timer ? timerLabel(contact.timer) : ""}
            </IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent ref={content}>
        <div className="messages app-max">
          {messages.length === 0 && (
            <div className="system-note">
              Messages are end-to-end encrypted and stored only on your devices.
            </div>
          )}
          {messages.map((m) =>
            m.dir === "system" ? (
              <div key={m.id} className="system-note">{m.text}</div>
            ) : (
              <Bubble key={m.id} m={m} now={now} onRetry={() => void messenger.resend(m.id)} onDownload={() => void messenger.download(m.id)} />
            ),
          )}
        </div>
      </IonContent>
      <IonFooter>
        <IonToolbar>
          <div className="composer app-max">
            <input ref={fileInput} type="file" multiple hidden onChange={onFile} />
            <IonButton fill="clear" onClick={() => fileInput.current?.click()} aria-label="Attach file">
              <IonIcon slot="icon-only" icon={attachOutline} />
            </IonButton>
            <IonTextarea
              style={{ flex: 1 }}
              autoGrow
              rows={1}
              placeholder={contact?.timer ? `Message (disappears after ${timerLabel(contact.timer)})` : "Message"}
              value={text}
              onIonInput={(e) => {
                textRef.current = String(e.detail.value ?? "");
                setText(textRef.current);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <IonButton fill="clear" onClick={submit} disabled={!text.trim()} aria-label="Send">
              <IonIcon slot="icon-only" icon={send} />
            </IonButton>
          </div>
        </IonToolbar>
      </IonFooter>
    </IonPage>
  );
}

function Bubble({ m, now, onRetry, onDownload }: { m: Message; now: number; onRetry(): void; onDownload(): void }) {
  const time = new Date(m.sentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div className={`bubble ${m.dir}`}>
      {m.kind === "file" && m.file && <FileView m={m} onDownload={onDownload} />}
      {m.text && <div>{m.text}</div>}
      <div className="meta">
        {m.expiresAt && (
          <span title="Disappears">
            <IonIcon icon={timerOutline} style={{ verticalAlign: "-2px" }} /> {remaining(m.expiresAt, now)}
          </span>
        )}
        <span>{time}</span>
        {m.dir === "out" && <StatusIcon m={m} onRetry={onRetry} />}
      </div>
    </div>
  );
}

function StatusIcon({ m, onRetry }: { m: Message; onRetry(): void }) {
  if (m.status === "pending") return <IonIcon icon={timeOutline} aria-label="Sending" />;
  if (m.status === "failed")
    return (
      <button onClick={onRetry} style={{ background: "none", color: "inherit", padding: 0, cursor: "pointer" }} aria-label="Retry">
        <IonIcon icon={alertCircleOutline} /> retry
      </button>
    );
  return <IonIcon icon={m.status === "sent" ? checkmarkOutline : checkmarkDoneOutline} aria-label="Sent" />;
}

function FileView({ m, onDownload }: { m: Message; onDownload(): void }) {
  const f = m.file!;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!f.blob) return;
    const u = URL.createObjectURL(f.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [f.blob]);

  if (f.state === "uploading" || f.state === "downloading") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <IonSpinner name="dots" /> {f.name}
      </div>
    );
  }
  if (f.state === "expired") return <em>📎 {f.name} — expired before it was downloaded</em>;
  if (f.state === "error" && !url)
    return (
      <button onClick={onDownload} style={{ background: "none", color: "inherit", textDecoration: "underline" }}>
        📎 {f.name} — tap to retry download
      </button>
    );
  if (url && f.mime.startsWith("image/")) {
    return (
      <a href={url} download={f.name} target="_blank" rel="noreferrer">
        <img src={url} alt={f.name} />
      </a>
    );
  }
  if (url && f.mime.startsWith("video/")) return <video src={url} controls style={{ maxWidth: "100%", borderRadius: 12 }} />;
  if (url && f.mime.startsWith("audio/")) return <audio src={url} controls />;
  return (
    <a href={url ?? undefined} download={f.name} style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <IonIcon icon={documentOutline} style={{ fontSize: 24 }} />
      <span>
        {f.name}
        <br />
        <small>{formatBytes(f.size)}</small>
      </span>
    </a>
  );
}
