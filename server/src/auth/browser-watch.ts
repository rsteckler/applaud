import { randomUUID } from "node:crypto";
import openUrl from "open";
import { detectSession, sessionKey, type DetectedSession } from "./detect.js";
import { logger } from "../logger.js";

export type WatchEvent =
  | { type: "waiting"; elapsedMs: number }
  | { type: "found"; session: DetectedSession }
  | { type: "timeout" }
  | { type: "error"; message: string };

type Listener = (e: WatchEvent) => void;

interface Watch {
  id: string;
  startedAt: number;
  listeners: Set<Listener>;
  stop: () => void;
  done: boolean;
  lastEvent: WatchEvent | null;
  baselineTokens: Set<string>;
}

const watches = new Map<string, Watch>();

const POLL_INTERVAL_MS = 2_000;
const TIMEOUT_MS = 5 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 5_000;

export async function startBrowserWatch(openBrowser = true): Promise<string> {
  const id = randomUUID();
  const startedAt = Date.now();

  // Snapshot any currently-valid session so we can ignore it and detect NEW logins.
  // This matters if the user already had a session but chose "log in again" or "different account."
  const baseline = await detectSession().catch(() => null);
  const baselineTokens = new Set<string>();
  if (baseline) baselineTokens.add(sessionKey(baseline));

  const listeners = new Set<Listener>();
  let done = false;
  let lastEvent: WatchEvent | null = null;

  const emit = (e: WatchEvent): void => {
    lastEvent = e;
    for (const l of listeners) {
      try {
        l(e);
      } catch (err) {
        logger.warn({ err }, "watch listener threw");
      }
    }
  };

  let heartbeatTimer: NodeJS.Timeout | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let timeoutTimer: NodeJS.Timeout | null = null;

  const stop = (): void => {
    if (done) return;
    done = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (pollTimer) clearInterval(pollTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
  };

  const poll = async (): Promise<void> => {
    try {
      const found = await detectSession();
      if (!found) return;
      if (baselineTokens.has(sessionKey(found))) return; // same session we started with
      emit({ type: "found", session: found });
      stop();
    } catch (err) {
      logger.warn({ err }, "browser-watch poll error");
    }
  };

  const watch: Watch = {
    id,
    startedAt,
    listeners,
    stop,
    done,
    lastEvent,
    baselineTokens,
  };
  watches.set(id, watch);

  // Heartbeat "waiting" events for the UI.
  heartbeatTimer = setInterval(() => {
    if (done) return;
    emit({ type: "waiting", elapsedMs: Date.now() - startedAt });
  }, HEARTBEAT_INTERVAL_MS);

  pollTimer = setInterval(() => {
    if (!done) void poll();
  }, POLL_INTERVAL_MS);

  timeoutTimer = setTimeout(() => {
    if (!done) {
      emit({ type: "timeout" });
      stop();
    }
  }, TIMEOUT_MS);

  if (openBrowser) {
    try {
      await openUrl("https://web.plaud.ai/");
    } catch (err) {
      emit({
        type: "error",
        message: `failed to open browser: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Fire an immediate poll so we don't wait the full interval.
  void poll();

  // Schedule cleanup 30 s after finish so late subscribers can still fetch the last event.
  setTimeout(
    () => {
      watches.delete(id);
    },
    TIMEOUT_MS + 30_000,
  );

  return id;
}

export function subscribeWatch(id: string, listener: Listener): (() => void) | null {
  const w = watches.get(id);
  if (!w) return null;
  w.listeners.add(listener);
  // Replay the last event so a late subscriber gets current state.
  if (w.lastEvent) listener(w.lastEvent);
  return () => {
    w.listeners.delete(listener);
  };
}

export function stopWatch(id: string): boolean {
  const w = watches.get(id);
  if (!w) return false;
  w.stop();
  return true;
}
