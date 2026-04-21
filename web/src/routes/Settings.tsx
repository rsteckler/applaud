import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";

function formatRelative(ts: number | null): string {
  if (!ts) return "never";
  const diff = Date.now() - ts;
  if (diff < 10_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

function daysUntil(epochSec: number): number {
  return Math.max(0, Math.ceil((epochSec * 1000 - Date.now()) / (1000 * 60 * 60 * 24)));
}

export function Settings(): JSX.Element {
  const qc = useQueryClient();
  const cfg = useQuery({ queryKey: ["config"], queryFn: api.config });
  const syncStatus = useQuery({
    queryKey: ["sync-status"],
    queryFn: api.syncStatus,
    refetchInterval: 5000,
  });

  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [secretExists, setSecretExists] = useState(false);
  const [secretTouched, setSecretTouched] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [pollMinutes, setPollMinutes] = useState(10);
  const [importPlaudDeleted, setImportPlaudDeleted] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<null | { ok: boolean; message: string }>(null);
  const [clearIgnoreBusy, setClearIgnoreBusy] = useState(false);
  const [clearIgnoreMsg, setClearIgnoreMsg] = useState<null | { ok: boolean; text: string }>(null);

  useEffect(() => {
    if (!cfg.data) return;
    const c = cfg.data.config;
    setWebhookUrl(c.webhook?.url ?? "");
    setSecretExists(Boolean(c.webhook?.secret));
    setWebhookSecret("");
    setSecretTouched(false);
    setShowSecret(false);
    setPollMinutes(c.pollIntervalMinutes);
    setImportPlaudDeleted(c.importPlaudDeleted ?? false);
    setDirty(false);
  }, [cfg.data]);

  if (cfg.isLoading) return <p className="text-on-surface-variant">loading…</p>;
  const c = cfg.data?.config;
  if (!c) return <p>failed to load</p>;

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const url = webhookUrl.trim();
      const webhook = url
        ? {
            url,
            enabled: true,
            // Sent value: new secret if user typed one, sentinel to preserve existing, empty to clear.
            secret: webhookSecret.length > 0 ? webhookSecret : secretExists ? "***REDACTED***" : "",
          }
        : null;
      await api.updateConfig({
        webhook,
        pollIntervalMinutes: pollMinutes,
        importPlaudDeleted,
      });
      await qc.invalidateQueries({ queryKey: ["config"] });
      await qc.invalidateQueries({ queryKey: ["recordings"] });
      await qc.invalidateQueries({ queryKey: ["sync-status"] });
      setDirty(false);
    } finally {
      setSaving(false);
    }
  };

  const generateSecret = (): void => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    setWebhookSecret(hex);
    setShowSecret(true);
    setSecretTouched(true);
    setDirty(true);
  };

  const clearSecret = (): void => {
    setWebhookSecret("");
    setSecretExists(false);
    setSecretTouched(true);
    setDirty(true);
  };

  const test = async (): Promise<void> => {
    setTestResult(null);
    try {
      const r = await api.testWebhook(webhookUrl.trim());
      const snippet = r.bodySnippet?.slice(0, 400).trim();
      let message: string;
      if (r.error) {
        message = snippet ? `${r.error} — ${snippet}` : r.error;
      } else {
        message = `HTTP ${r.statusCode ?? "?"}`;
        if (snippet) message += ` — ${snippet}`;
      }
      setTestResult({ ok: r.ok, message });
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  };

  const s = syncStatus.data;
  const isHealthy = s && !s.authRequired && !s.lastError;

  return (
    <div className="max-w-[48rem] mx-auto space-y-8">
      {/* Page Header */}
      <div className="space-y-2 mb-12">
        <h1 className="text-5xl font-extrabold tracking-tighter text-on-surface">Configuration</h1>
        <p className="text-on-surface-variant">Manage your local ingestion engine and cloud synchronization.</p>
      </div>

      {/* Sync Status */}
      <section className="bg-surface-container-low rounded-xl p-8 transition-all hover:bg-surface-container">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <div className={`w-2.5 h-2.5 rounded-full ${isHealthy ? "bg-secondary shadow-[0_0_8px_rgba(157,223,46,0.4)]" : "bg-error shadow-[0_0_8px_rgba(255,180,171,0.4)]"}`} />
              <span className="font-label text-xs font-bold tracking-widest uppercase text-secondary">
                {isHealthy ? "All systems operational" : s?.authRequired ? "Auth required" : "Error detected"}
              </span>
            </div>
            <div>
              <h2 className="text-3xl font-bold tracking-tight text-on-surface">Sync Status</h2>
              <p className="text-on-surface-variant text-sm mt-1">Real-time health of your local applaud instance.</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 w-full md:w-auto">
            <div className="bg-surface-container-highest/50 border border-outline-variant/20 p-4 rounded-lg">
              <p className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest mb-1">Last poll</p>
              <p className="font-bold text-lg text-on-surface">{formatRelative(s?.lastPollAt ?? null)}</p>
            </div>
            <div className="bg-surface-container-highest/50 border border-outline-variant/20 p-4 rounded-lg">
              <p className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest mb-1">Pending</p>
              <p className="font-bold text-lg text-tertiary">
                {s?.pendingTranscripts ?? 0} transcript{(s?.pendingTranscripts ?? 0) !== 1 ? "s" : ""}
                {(s?.pendingSummaries ?? 0) > 0 ? (
                  <span className="block text-sm font-semibold mt-1 text-on-surface-variant">
                    {s?.pendingSummaries} summary pending
                  </span>
                ) : null}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Sync maintenance */}
      <section className="card p-8 space-y-4">
        <h2 className="text-xl font-bold text-on-surface">Sync maintenance</h2>
        <p className="text-sm text-on-surface-variant max-w-prose">
          After a recording spends 7 days in Trash, Applaud deletes its local files and adds the Plaud id to an internal
          blocklist so it is not downloaded again. If you need to pull those recordings from Plaud again, clear the
          blocklist here. This does not delete any files currently in your library.
        </p>
        {clearIgnoreMsg && (
          <p className={`text-sm ${clearIgnoreMsg.ok ? "text-secondary" : "text-error"}`}>{clearIgnoreMsg.text}</p>
        )}
        <button
          type="button"
          className="px-4 py-2 rounded-lg border border-error/30 text-error text-sm font-semibold hover:bg-error/10 transition-colors"
          disabled={clearIgnoreBusy}
          onClick={() => {
            if (
              !confirm(
                "Clear the purged-recording blocklist? Previously purged Plaud ids may be downloaded again on the next sync.",
              )
            ) {
              return;
            }
            setClearIgnoreBusy(true);
            setClearIgnoreMsg(null);
            void api
              .clearSyncIgnore()
              .then((r) => {
                setClearIgnoreMsg({ ok: true, text: `Cleared ${r.cleared} blocked id(s).` });
                void qc.invalidateQueries({ queryKey: ["sync-blocklist"] });
              })
              .catch((err) => {
                setClearIgnoreMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
              })
              .finally(() => {
                setClearIgnoreBusy(false);
              });
          }}
        >
          {clearIgnoreBusy ? "Clearing…" : "Clear purged recording blocklist"}
        </button>
      </section>

      {/* Account Details */}
      <section className="card p-8 space-y-6">
        <div className="flex items-center gap-3">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
          <h2 className="text-xl font-bold text-on-surface">Account Details</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-2">
            <label className="font-label text-xs font-semibold text-on-surface-variant uppercase tracking-wider">Email Address</label>
            <div className="bg-surface-container-low rounded-lg p-4 text-on-surface text-sm">
              {c.tokenEmail ?? "unknown"}
            </div>
          </div>
          <div className="space-y-2">
            <label className="font-label text-xs font-semibold text-on-surface-variant uppercase tracking-wider">Token Expiration</label>
            <div className="bg-surface-container-highest/50 border border-outline-variant/20 rounded-lg p-4 flex items-center justify-between">
              <span className="text-sm text-on-surface">
                {c.tokenExp ? `Expires in ${daysUntil(c.tokenExp)} days` : "—"}
              </span>
            </div>
          </div>
        </div>
        <div className="space-y-2">
          <label className="font-label text-xs font-semibold text-on-surface-variant uppercase tracking-wider">Local Storage Path</label>
          <div className="relative">
            <div className="bg-surface-container-low rounded-lg p-4 font-mono text-sm text-primary pr-12">
              {c.recordingsDir ?? "(not set)"}
            </div>
            <div className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </div>
          </div>
        </div>
      </section>

      {/* Webhook Outbound */}
      <section className="card p-8 space-y-6">
        <div className="flex items-center gap-3">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
          <h2 className="text-xl font-bold text-on-surface">Webhook Outbound</h2>
        </div>
        <div className="space-y-4">
          <div className="flex gap-3">
            <input
              className="input py-3 border-transparent"
              type="url"
              placeholder="https://api.yourdomain.com/v1/ingest"
              value={webhookUrl}
              onChange={(e) => {
                setWebhookUrl(e.target.value);
                setDirty(true);
                setTestResult(null);
              }}
            />
            <button
              className="btn-primary px-6 py-3"
              onClick={() => void test()}
              disabled={!webhookUrl}
            >
              Test
            </button>
          </div>
          <div className="space-y-2">
            <label className="font-label text-xs font-semibold text-on-surface-variant uppercase tracking-wider">
              Signing secret (optional)
            </label>
            <div className="flex gap-3">
              <input
                className="input py-3 border-transparent font-mono"
                type={showSecret ? "text" : "password"}
                placeholder={
                  secretExists
                    ? "Leave empty to keep current secret"
                    : "Paste a secret or click Generate"
                }
                value={webhookSecret}
                onChange={(e) => {
                  setWebhookSecret(e.target.value);
                  setSecretTouched(true);
                  setDirty(true);
                }}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="px-4 py-3 rounded-lg border border-outline-variant/30 text-on-surface text-sm font-semibold hover:bg-surface-container-highest transition-colors"
                onClick={() => setShowSecret((v) => !v)}
                disabled={!webhookSecret}
              >
                {showSecret ? "Hide" : "Show"}
              </button>
              <button
                type="button"
                className="px-4 py-3 rounded-lg border border-primary/30 text-primary text-sm font-semibold hover:bg-primary/10 transition-colors"
                onClick={generateSecret}
              >
                Generate
              </button>
              {secretExists && webhookSecret.length === 0 && (
                <button
                  type="button"
                  className="px-4 py-3 rounded-lg border border-error/30 text-error text-sm font-semibold hover:bg-error/10 transition-colors"
                  onClick={clearSecret}
                >
                  Clear
                </button>
              )}
            </div>
            {secretTouched && (
              <p className="text-xs font-semibold text-tertiary bg-tertiary/10 border border-tertiary/30 rounded-lg px-3 py-2">
                Click <strong>Save Settings</strong> at the bottom of the page before using <strong>Test</strong> — the new secret is not active until saved.
              </p>
            )}
            <p className="text-xs text-on-surface-variant">
              When set, outgoing webhooks include <span className="font-mono">X-Applaud-Signature: sha256=&lt;hex&gt;</span>{" "}
              (HMAC-SHA256 of the raw body). See the README for receiver verification snippets.
            </p>
          </div>
          {testResult && (
            <div
              className={`rounded-lg p-4 flex items-center gap-3 ${
                testResult.ok
                  ? "bg-secondary/10 border border-secondary/20"
                  : "bg-error/10 border border-error/20"
              }`}
            >
              {testResult.ok ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-secondary flex-shrink-0">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-error flex-shrink-0">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="15" y1="9" x2="9" y2="15" />
                  <line x1="9" y1="9" x2="15" y2="15" />
                </svg>
              )}
              <div>
                <p className={`font-bold text-sm ${testResult.ok ? "text-secondary" : "text-error"}`}>
                  {testResult.ok ? "Connection Success" : "Connection Failed"}
                </p>
                <p className={`text-xs ${testResult.ok ? "text-secondary/70" : "text-error/70"}`}>
                  {testResult.message}
                </p>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Poll Interval */}
      <section className="card p-8 space-y-6">
        <div className="flex justify-between items-end">
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <h2 className="text-xl font-bold text-on-surface">Poll Interval</h2>
            </div>
            <p className="text-on-surface-variant text-sm">Frequency of transcript synchronization cycles.</p>
          </div>
          <div className="text-right">
            <span className="text-5xl font-black text-primary tracking-tighter">{pollMinutes}</span>
            <span className="font-label text-sm font-bold text-on-surface-variant uppercase ml-2">minutes</span>
          </div>
        </div>
        <div className="space-y-3">
          <input
            type="range"
            min={1}
            max={60}
            value={pollMinutes}
            onChange={(e) => {
              setPollMinutes(Number(e.target.value));
              setDirty(true);
            }}
            className="w-full accent-primary"
          />
          <div className="flex justify-between font-label text-[10px] text-on-surface-variant font-bold tracking-widest uppercase">
            <span>1 min</span>
            <span>30 mins</span>
            <span>60 mins</span>
          </div>
        </div>
      </section>

      {/* Plaud import option (saved with Save Settings) */}
      <section className="card p-8 space-y-4">
        <h2 className="text-xl font-bold text-on-surface">Plaud library</h2>
        <p className="text-sm text-on-surface-variant max-w-prose">
          By default only files that are still active in Plaud are listed and synced. Enable the option below to also
          download and show items you deleted in the Plaud app (they appear with the trash badge on the recordings list).
        </p>
        <label className="flex items-start gap-3 cursor-pointer select-none">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-outline-variant text-primary focus:ring-primary shrink-0"
            checked={importPlaudDeleted}
            onChange={(e) => {
              setImportPlaudDeleted(e.target.checked);
              setDirty(true);
            }}
          />
          <span className="text-sm font-medium text-on-surface">Import recordings deleted in Plaud</span>
        </label>
      </section>

      {/* Save Footer */}
      <footer className="pt-4 flex flex-col items-center">
        <button
          className="w-full max-w-md btn-primary py-4 text-base font-black shadow-lg shadow-primary/10"
          onClick={() => void save()}
          disabled={!dirty || saving}
        >
          {saving ? "Saving…" : "Save Settings"}
        </button>
        <p className="mt-4 font-label text-[10px] text-on-surface-variant uppercase tracking-[0.15em]">
          Changes take effect immediately on local engine.
        </p>
      </footer>
    </div>
  );
}
