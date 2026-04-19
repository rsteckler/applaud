import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import type { RecordingRow } from "@applaud/shared";

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function StatusDots({ row }: { row: RecordingRow }): JSX.Element {
  const hasAudio = !!row.audioDownloadedAt;
  const hasTranscript = !!row.transcriptDownloadedAt;
  const hasSummary = !!row.summaryDownloadedAt;
  return (
    <div className="flex items-center gap-2 text-[10px] font-label font-bold uppercase tracking-widest">
      <StatusPill on={hasAudio} label="audio" color="secondary" />
      <StatusPill on={hasTranscript} label="transcript" color="primary" />
      <StatusPill on={hasSummary} label="summary" color="primary" />
    </div>
  );
}

function StatusPill({
  on,
  label,
  color,
}: {
  on: boolean;
  label: string;
  color: "primary" | "secondary";
}): JSX.Element {
  if (on) {
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 bg-surface-container-highest ${
          color === "secondary" ? "text-secondary" : "text-primary"
        }`}
      >
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            color === "secondary" ? "bg-secondary" : "bg-primary"
          }`}
        />
        {label}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 bg-surface-container-highest text-outline">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-outline-variant" />
      {label}
    </span>
  );
}

function RecordingIcon({ isTrash }: { isTrash: boolean }): JSX.Element {
  return (
    <div className="w-12 h-12 flex-shrink-0 bg-surface-container-highest rounded-lg flex items-center justify-center">
      {isTrash ? (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-tertiary">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      ) : (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
      )}
    </div>
  );
}

export function Dashboard(): JSX.Element {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const list = useQuery({
    queryKey: ["recordings", { search }],
    queryFn: () => api.listRecordings({ limit: 200, search: search || undefined }),
  });
  const [triggering, setTriggering] = useState(false);

  const triggerSync = async (): Promise<void> => {
    setTriggering(true);
    try {
      await api.syncTrigger();
      await qc.invalidateQueries({ queryKey: ["recordings"] });
      await qc.invalidateQueries({ queryKey: ["sync-status"] });
    } finally {
      setTriggering(false);
    }
  };

  return (
    <div>
      {/* Page Header */}
      <header className="mb-10 flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div className="space-y-2">
          <h1 className="text-5xl font-black leading-none tracking-tighter text-on-surface" style={{ fontWeight: 900 }}>
            Recordings
          </h1>
          <p className="text-on-surface-variant font-label text-sm tracking-wide uppercase">
            {list.data?.total ?? "…"} items total
            {list.data?.totalBytes != null && (
              <>
                <span className="mx-2 text-outline-variant opacity-40">|</span>
                {formatBytes(list.data.totalBytes)} used
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3 w-full md:w-auto">
          <div className="relative flex-grow md:w-64">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant"
              width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              className="input pl-10 py-3 border-transparent"
              placeholder="Search archives..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <button
            className="btn-primary py-3 px-5 flex items-center gap-2 shadow-lg shadow-primary/10"
            onClick={() => void triggerSync()}
            disabled={triggering}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={triggering ? "animate-spin" : ""}>
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
              <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" />
            </svg>
            {triggering ? "Syncing…" : "Sync Now"}
          </button>
        </div>
      </header>

      {list.isLoading && <p className="text-on-surface-variant">loading…</p>}
      {list.error && (
        <p className="text-error">Failed to load recordings: {String(list.error)}</p>
      )}

      {list.data && list.data.items.length === 0 && (
        <div className="card flex flex-col items-center justify-center p-12 text-center">
          <p className="text-on-surface">No recordings yet.</p>
          <p className="mt-1 text-sm text-on-surface-variant">
            Click <span className="font-medium">Sync now</span> or wait for the next poll
            cycle.
          </p>
        </div>
      )}

      {/* Recordings Grid */}
      {list.data && list.data.items.length > 0 && (
        <div className="grid gap-3">
          {list.data.items.map((r) => (
            <Link
              key={r.id}
              to={`/recordings/${r.id}`}
              className="group bg-surface-container hover:bg-surface-container-high transition-all duration-200 rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 relative overflow-hidden"
            >
              {/* Hover glow */}
              <div className="absolute inset-0 bg-gradient-to-r from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
              <div className="relative flex items-center gap-4">
                <RecordingIcon isTrash={r.isTrash} />
                <div>
                  <h3 className="text-base font-bold text-on-surface leading-tight group-hover:text-primary transition-colors">
                    {r.filename}
                  </h3>
                  <div className="mt-1 flex items-center gap-3 font-label text-[11px] tracking-wider text-on-surface-variant uppercase">
                    <span>{formatDate(r.startTime)}</span>
                    <span className="w-1 h-1 rounded-full bg-outline-variant" />
                    <span>{formatDuration(r.durationMs)}</span>
                    <span className="w-1 h-1 rounded-full bg-outline-variant" />
                    <span>{(r.filesizeBytes / 1024 / 1024).toFixed(1)} MB</span>
                  </div>
                </div>
              </div>
              <div className="relative">
                <StatusDots row={r} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
