import { useEffect, useState } from "react";
import { api } from "../../api.js";

type DetectState =
  | { kind: "idle" }
  | { kind: "detecting" }
  | {
      kind: "found";
      authMode: "legacy" | "first_party";
      email?: string;
      browser?: string;
      profile?: string;
      token?: string;
      ut?: string;
      urt?: string;
    }
  | { kind: "notfound" }
  // Windows: auto-detection isn't supported, so we skip straight to manual paste.
  | { kind: "unsupported" }
  | { kind: "error"; message: string };

type WatchState =
  | { kind: "inactive" }
  | { kind: "waiting"; elapsedSec: number }
  | { kind: "error"; message: string };

type ManualState =
  | { kind: "idle" }
  | { kind: "validating" }
  | { kind: "error"; message: string };

export function AuthStep({
  onNext,
  onBack,
}: {
  onNext: () => void;
  onBack: () => void;
}): JSX.Element {
  const [detect, setDetect] = useState<DetectState>({ kind: "idle" });
  const [watch, setWatch] = useState<WatchState>({ kind: "inactive" });
  const [manual, setManual] = useState<ManualState>({ kind: "idle" });
  const [manualText, setManualText] = useState("");
  const [manualUt, setManualUt] = useState("");
  const [manualUrt, setManualUrt] = useState("");
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    setDetect({ kind: "detecting" });
    api
      .authDetect()
      .then((r) => {
        if (r.autoDetectSupported === false) {
          // Windows: no on-disk detection — go straight to manual paste.
          setDetect({ kind: "unsupported" });
        } else if (r.found && r.authMode === "first_party" && r.ut && r.urt) {
          setDetect({ kind: "found", authMode: "first_party", browser: r.browser, profile: r.profile, ut: r.ut, urt: r.urt });
        } else if (r.found && r.token) {
          setDetect({ kind: "found", authMode: "legacy", email: r.email, browser: r.browser, profile: r.profile, token: r.token });
        } else if (r.error) {
          setDetect({ kind: "error", message: r.error });
        } else {
          setDetect({ kind: "notfound" });
        }
      })
      .catch((err: Error) => setDetect({ kind: "error", message: err.message }));
  }, []);

  const acceptResult = (r: { ok: boolean; error?: string }): void => {
    if (r.ok) { setAccepted(true); onNext(); }
    else { setDetect({ kind: "error", message: r.error ?? "token validation failed" }); }
  };

  const accept = async (token: string, email?: string): Promise<void> => {
    try {
      acceptResult(await api.authAccept(token, email));
    } catch (err) {
      setDetect({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const acceptCookies = async (ut: string, urt: string): Promise<void> => {
    try {
      acceptResult(await api.authAcceptCookies(ut, urt));
    } catch (err) {
      setDetect({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const startWatch = async (): Promise<void> => {
    try {
      const { watchId } = await api.authStartWatch();
      setWatch({ kind: "waiting", elapsedSec: 0 });
      const es = new EventSource(`/api/auth/watch/${watchId}/events`);
      const start = Date.now();
      const tick = setInterval(() => {
        setWatch({ kind: "waiting", elapsedSec: Math.floor((Date.now() - start) / 1000) });
      }, 1000);
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.type === "found") { clearInterval(tick); es.close(); setAccepted(true); onNext(); }
          else if (data.type === "timeout") { clearInterval(tick); es.close(); setWatch({ kind: "error", message: "timed out waiting for login (5 min)" }); }
          else if (data.type === "error") { clearInterval(tick); es.close(); setWatch({ kind: "error", message: data.message }); }
        } catch { /* ignore */ }
      };
      es.onerror = () => { clearInterval(tick); es.close(); setWatch({ kind: "error", message: "connection lost" }); };
    } catch (err) {
      setWatch({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const onManualResult = (r: { ok: boolean; error?: string }): void => {
    if (r.ok) { setAccepted(true); onNext(); }
    else { setManual({ kind: "error", message: r.error ?? "validation failed" }); }
  };

  const submitManual = async (): Promise<void> => {
    setManual({ kind: "validating" });
    try {
      onManualResult(await api.authAccept(manualText));
    } catch (err) {
      setManual({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const submitManualCookies = async (): Promise<void> => {
    setManual({ kind: "validating" });
    try {
      onManualResult(await api.authAcceptCookies(manualUt.trim(), manualUrt.trim()));
    } catch (err) {
      setManual({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  // The manual-paste form body, reused by the "no session found" flow (tucked
  // inside a <details>) and the Windows flow (shown directly, since auto-detect
  // isn't available there).
  const manualPasteBody = (): JSX.Element => (
    <>
      <div className="mt-4 space-y-3">
        <p className="text-xs text-on-surface-variant">
          Newer Plaud accounts no longer expose a long-lived token in Local Storage. On web.plaud.ai open DevTools → Application → Cookies → <code>https://web.plaud.ai</code> and paste the values of <code>pld_ut</code> and <code>pld_urt</code> (each starts with <code>eyJ…</code>).
        </p>
        <label className="font-label text-xs text-on-surface-variant uppercase tracking-wider block">pld_ut</label>
        <textarea
          className="w-full bg-surface-container-highest/50 border-0 rounded-lg p-3 font-mono text-xs text-on-surface h-16 focus:ring-2 focus:ring-primary/40 focus:outline-none"
          placeholder="eyJhbGciOiJIUzI1NiIs..."
          value={manualUt}
          onChange={(e) => setManualUt(e.target.value)}
        />
        <label className="font-label text-xs text-on-surface-variant uppercase tracking-wider block">pld_urt</label>
        <textarea
          className="w-full bg-surface-container-highest/50 border-0 rounded-lg p-3 font-mono text-xs text-on-surface h-16 focus:ring-2 focus:ring-primary/40 focus:outline-none"
          placeholder="eyJhbGciOiJIUzI1NiIs..."
          value={manualUrt}
          onChange={(e) => setManualUrt(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <button className="btn-primary" onClick={() => void submitManualCookies()} disabled={manual.kind === "validating" || manualUt.trim().length < 20 || manualUrt.trim().length < 20}>
            {manual.kind === "validating" ? "Connecting…" : "Connect with cookies"}
          </button>
        </div>
      </div>
      <div className="mt-5 border-t border-outline-variant/30 pt-4 space-y-3">
        <p className="text-xs text-on-surface-variant">
          Still have the old <code>tokenstr</code> value? Open DevTools → Application → Local Storage and paste it (starts with <code>bearer eyJ…</code>) or the raw JWT.
        </p>
        <label className="font-label text-xs text-on-surface-variant uppercase tracking-wider block">tokenstr (legacy)</label>
        <textarea
          className="w-full bg-surface-container-highest/50 border-0 rounded-lg p-4 font-mono text-xs text-on-surface h-24 focus:ring-2 focus:ring-primary/40 focus:outline-none"
          placeholder="bearer eyJhbGciOiJIUzI1NiIs..."
          value={manualText}
          onChange={(e) => setManualText(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <button className="btn-secondary" onClick={() => void submitManual()} disabled={manual.kind === "validating" || manualText.length < 20}>
            {manual.kind === "validating" ? "Validating…" : "Use this token"}
          </button>
        </div>
      </div>
      {manual.kind === "error" && <p className="mt-3 text-sm text-error">{manual.message}</p>}
    </>
  );

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <span className="font-label text-primary text-xs font-bold tracking-widest uppercase">Step 2</span>
        <h1 className="text-3xl font-extrabold tracking-tight text-on-surface">Connect Your Plaud Account</h1>
        <p className="text-on-surface-variant text-base max-w-md leading-relaxed">
          Applaud authenticates by reading your existing Plaud session from Chrome.
        </p>
      </div>

      <div className="rounded-xl bg-surface-container-low p-6 space-y-4">
        {detect.kind === "detecting" && (
          <p className="text-sm text-on-surface-variant">Scanning browsers on this machine…</p>
        )}
        {detect.kind === "found" && (
          <div>
            <p className="text-sm text-on-surface">
              ✓ Found a Plaud session in{" "}
              <span className="font-medium">{detect.browser} / {detect.profile}</span>
              {detect.email && <>{" "}for <span className="font-medium">{detect.email}</span></>}
            </p>
            <div className="mt-4 flex gap-2">
              <button
                className="btn-primary"
                onClick={() =>
                  detect.authMode === "first_party" && detect.ut && detect.urt
                    ? void acceptCookies(detect.ut, detect.urt)
                    : detect.token
                      ? void accept(detect.token, detect.email)
                      : undefined
                }
                disabled={accepted}
              >
                Use this session
              </button>
              <button className="btn-secondary" onClick={() => setDetect({ kind: "notfound" })}>
                Use a different account
              </button>
            </div>
          </div>
        )}
        {detect.kind === "notfound" && (
          <div className="space-y-4">
            <p className="text-sm text-on-surface-variant">
              No existing Plaud session found. Open the Plaud web app in your browser, log in, and we'll pick up the session automatically.
            </p>
            {watch.kind === "inactive" && (
              <button className="btn-primary" onClick={() => void startWatch()}>
                Open web.plaud.ai and watch for login
              </button>
            )}
            {watch.kind === "waiting" && (
              <p className="text-sm text-on-surface-variant">Waiting for you to log in… ({watch.elapsedSec}s)</p>
            )}
            {watch.kind === "error" && <p className="text-sm text-error">{watch.message}</p>}
            <details className="rounded-xl bg-surface-container p-4 text-sm">
              <summary className="cursor-pointer font-medium text-on-surface">Paste cookies manually</summary>
              {manualPasteBody()}
            </details>
          </div>
        )}
        {detect.kind === "unsupported" && (
          <div className="space-y-4">
            <p className="text-sm text-on-surface-variant">
              Automatic session detection isn't available on Windows yet, so connect by pasting your Plaud session cookies below.
            </p>
            <div className="rounded-xl bg-surface-container p-4 text-sm">
              {manualPasteBody()}
            </div>
          </div>
        )}
        {detect.kind === "error" && (
          <div>
            <p className="text-sm text-error">Detect failed: {detect.message}</p>
            <button className="btn-secondary mt-2" onClick={() => setDetect({ kind: "notfound" })}>Try another method</button>
          </div>
        )}
      </div>

      <div className="flex justify-between pt-4">
        <button className="flex items-center gap-2 text-on-surface-variant font-semibold text-sm hover:text-on-surface transition-colors group" onClick={onBack}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="group-hover:-translate-x-1 transition-transform"><path d="M19 12H5" /><path d="M12 19l-7-7 7-7" /></svg>
          Back
        </button>
      </div>
    </div>
  );
}
