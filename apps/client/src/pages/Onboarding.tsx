import { useEffect, useRef, useState } from "react";
import {
  IonButton, IonContent, IonHeader, IonIcon, IonInput, IonItem, IonLabel, IonList, IonNote,
  IonPage, IonSpinner, IonText, IonTextarea, IonTitle, IonToolbar,
} from "@ionic/react";
import { checkmarkCircle, chatbubblesOutline, ellipseOutline, alertCircle } from "ionicons/icons";
import { HANDLE_RE } from "@njm/shared/protocol";
import { authenticate, checkHandle, linkDevice, parseRecoveryKit, recover, type Step } from "../services/auth";
import type { Identity, MailboxCreds } from "../services/storage";

type Mode = "welcome" | "create" | "restore" | "link" | "progress";

const STEPS: { key: Step; label: string }[] = [
  { key: "inbox", label: "Creating a disposable inbox" },
  { key: "request", label: "Requesting a one-time code" },
  { key: "waiting", label: "Reading the code from your inbox" },
  { key: "verify", label: "Generating keys & verifying" },
];

export default function Onboarding({ onDone }: { onDone: (id: Identity) => void }) {
  const [mode, setMode] = useState<Mode>("welcome");
  const [handle, setHandle] = useState("");
  const [available, setAvailable] = useState<boolean | null>(null);
  const [kitText, setKitText] = useState("");
  const [recHandle, setRecHandle] = useState("");
  const [recCode, setRecCode] = useState("");
  const [linkCode, setLinkCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<Step | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needCode, setNeedCode] = useState(false);
  const [manualCode, setManualCode] = useState("");
  const codeResolver = useRef<((c: string) => void) | null>(null);
  const abort = useRef<AbortController | null>(null);
  const lastRun = useRef<{ handle?: string; mailbox?: MailboxCreds } | null>(null);

  const normalized = handle.trim().toLowerCase();
  const valid = HANDLE_RE.test(normalized);

  useEffect(() => {
    setAvailable(null);
    if (!valid) return;
    const t = setTimeout(() => {
      checkHandle(normalized).then(setAvailable).catch(() => setAvailable(null));
    }, 350);
    return () => clearTimeout(t);
  }, [normalized, valid]);

  useEffect(() => () => abort.current?.abort(), []);

  async function run(opts: { handle?: string; mailbox?: MailboxCreds }) {
    lastRun.current = opts;
    abort.current?.abort();
    abort.current = new AbortController();
    setError(null);
    setNeedCode(false);
    setStep(null);
    setMode("progress");
    try {
      const id = await authenticate({
        ...opts,
        signal: abort.current.signal,
        onStep: setStep,
        askCode: () =>
          new Promise<string>((resolve) => {
            codeResolver.current = resolve;
            setNeedCode(true);
          }),
      });
      onDone(id);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message || "Something went wrong");
    }
  }

  async function guarded(fn: () => Promise<Identity | void>) {
    setBusy(true);
    setError(null);
    try {
      const id = await fn();
      if (id) onDone(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Recovery kit: the recovery code works even if the temp inbox was deleted; the inbox
   * (if still alive) is the fallback for old kits without a code.
   */
  const restoreKit = () =>
    guarded(async () => {
      const kit = parseRecoveryKit(kitText.trim());
      if (kit.recoveryCode) {
        try {
          return await recover(kit.handle, kit.recoveryCode, kit.mailbox ?? null);
        } catch (e) {
          if (!kit.mailbox) throw e;
        }
      }
      if (kit.mailbox) void run({ mailbox: kit.mailbox });
    });

  const restoreManual = () => guarded(() => recover(recHandle, recCode));
  const link = () => guarded(() => linkDevice(linkCode));

  const stepIndex = step ? STEPS.findIndex((s) => s.key === step) : -1;

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Ephemeral</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding">
        <div className="app-max" style={{ maxWidth: 460 }}>
          {mode === "welcome" && (
            <div style={{ textAlign: "center", paddingTop: 32 }}>
              <IonIcon icon={chatbubblesOutline} color="primary" style={{ fontSize: 72 }} />
              <h1 style={{ fontWeight: 700 }}>Messages that don't stick around</h1>
              <p className="hint">
                End-to-end encrypted. Messages live only on your devices — the server relays ciphertext and forgets
                it once delivered. No phone number, no real email: we create a disposable inbox for you.
              </p>
              <IonButton expand="block" onClick={() => setMode("create")} style={{ marginTop: 24 }}>
                Create anonymous account
              </IonButton>
              <IonButton expand="block" fill="clear" onClick={() => setMode("link")}>
                Link to my other device
              </IonButton>
              <IonButton expand="block" fill="clear" onClick={() => setMode("restore")}>
                Restore with recovery code
              </IonButton>
            </div>
          )}

          {mode === "create" && (
            <>
              <h2>Pick a handle</h2>
              <p className="hint">This is how people find you. Lowercase letters, numbers and _ (3–24).</p>
              <IonList inset>
                <IonItem>
                  <IonInput
                    label="@"
                    placeholder="your_handle"
                    value={handle}
                    autocapitalize="off"
                    autocorrect="off"
                    maxlength={24}
                    onIonInput={(e) => setHandle(String(e.detail.value ?? ""))}
                    onKeyDown={(e) => e.key === "Enter" && valid && available && void run({ handle: normalized })}
                  />
                </IonItem>
              </IonList>
              <IonNote style={{ display: "block", minHeight: 20, paddingLeft: 20 }}>
                {normalized && !valid && <IonText color="danger">Invalid handle</IonText>}
                {valid && available === true && <IonText color="success">@{normalized} is available</IonText>}
                {valid && available === false && <IonText color="danger">@{normalized} is taken</IonText>}
              </IonNote>
              <IonButton expand="block" disabled={!valid || available !== true} onClick={() => void run({ handle: normalized })}>
                Create account
              </IonButton>
              <IonButton expand="block" fill="clear" onClick={() => setMode("welcome")}>
                Back
              </IonButton>
            </>
          )}

          {mode === "restore" && (
            <>
              <h2>Restore your account</h2>
              <p className="hint">
                Use your recovery code — it works even if the temp inbox was deleted. Old messages aren't restored;
                they never left your previous device.
              </p>
              <IonList inset>
                <IonItem>
                  <IonInput
                    label="@"
                    placeholder="your_handle"
                    value={recHandle}
                    autocapitalize="off"
                    onIonInput={(e) => setRecHandle(String(e.detail.value ?? ""))}
                  />
                </IonItem>
                <IonItem>
                  <IonInput
                    label="Recovery code"
                    labelPlacement="stacked"
                    placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
                    value={recCode}
                    autocapitalize="characters"
                    onIonInput={(e) => setRecCode(String(e.detail.value ?? ""))}
                  />
                </IonItem>
              </IonList>
              <IonButton expand="block" disabled={busy || !recHandle.trim() || recCode.replace(/[^A-Za-z0-9]/g, "").length < 20} onClick={restoreManual}>
                {busy ? <IonSpinner name="dots" /> : "Restore with code"}
              </IonButton>

              <p className="hint" style={{ marginTop: 28 }}>…or paste the recovery kit you saved from Settings:</p>
              <IonTextarea
                className="kit"
                autoGrow
                rows={4}
                placeholder='{"app":"ephemeral", ...}'
                value={kitText}
                onIonInput={(e) => setKitText(String(e.detail.value ?? ""))}
              />
              <IonButton expand="block" fill="outline" disabled={busy || !kitText.trim()} onClick={restoreKit} style={{ marginTop: 12 }}>
                Restore from kit
              </IonButton>
              {error && <IonText color="danger"><p>{error}</p></IonText>}
              <IonButton expand="block" fill="clear" onClick={() => { setError(null); setMode("welcome"); }}>
                Back
              </IonButton>
            </>
          )}

          {mode === "link" && (
            <>
              <h2>Link to an existing device</h2>
              <p className="hint">
                On a device that's already signed in, open Settings › Link a new device and enter the code shown there.
              </p>
              <IonList inset>
                <IonItem>
                  <IonInput
                    label="Link code"
                    placeholder="ABCD-EFGH"
                    value={linkCode}
                    autocapitalize="characters"
                    maxlength={9}
                    onIonInput={(e) => setLinkCode(String(e.detail.value ?? ""))}
                    onKeyDown={(e) => e.key === "Enter" && void link()}
                  />
                </IonItem>
              </IonList>
              <IonButton expand="block" disabled={busy || linkCode.replace(/[^A-Za-z0-9]/g, "").length !== 8} onClick={link}>
                {busy ? <IonSpinner name="dots" /> : "Link device"}
              </IonButton>
              {error && <IonText color="danger"><p>{error}</p></IonText>}
              <IonButton expand="block" fill="clear" onClick={() => { setError(null); setMode("welcome"); }}>
                Back
              </IonButton>
            </>
          )}

          {mode === "progress" && (
            <>
              <h2>Setting things up</h2>
              <IonList className="steps" lines="none">
                {STEPS.map((s, i) => {
                  const done = stepIndex > i || step === "done";
                  const active = stepIndex === i && !error;
                  const failed = stepIndex === i && !!error;
                  return (
                    <IonItem key={s.key}>
                      {active ? (
                        <IonSpinner slot="start" name="crescent" />
                      ) : (
                        <IonIcon
                          slot="start"
                          icon={failed ? alertCircle : done ? checkmarkCircle : ellipseOutline}
                          color={failed ? "danger" : done ? "success" : "medium"}
                        />
                      )}
                      <IonLabel color={done || active ? undefined : "medium"}>{s.label}</IonLabel>
                    </IonItem>
                  );
                })}
              </IonList>

              {needCode && !error && (
                <>
                  <p className="hint">
                    The code didn't arrive automatically. If you can see it in the inbox, enter it here.
                  </p>
                  <IonList inset>
                    <IonItem>
                      <IonInput
                        label="Code"
                        inputmode="numeric"
                        maxlength={6}
                        value={manualCode}
                        onIonInput={(e) => setManualCode(String(e.detail.value ?? ""))}
                      />
                    </IonItem>
                  </IonList>
                  <IonButton
                    expand="block"
                    disabled={!/^\d{6}$/.test(manualCode)}
                    onClick={() => { setNeedCode(false); codeResolver.current?.(manualCode); }}
                  >
                    Verify
                  </IonButton>
                </>
              )}

              {error && (
                <>
                  <IonText color="danger"><p>{error}</p></IonText>
                  <IonButton expand="block" onClick={() => lastRun.current && void run(lastRun.current)}>
                    Try again
                  </IonButton>
                  <IonButton expand="block" fill="clear" onClick={() => setMode("welcome")}>
                    Back
                  </IonButton>
                </>
              )}
            </>
          )}
        </div>
      </IonContent>
    </IonPage>
  );
}
