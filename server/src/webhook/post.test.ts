import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import type { WebhookPayload } from "@applaud/shared";
import { fireRaw } from "./post.js";
import { setupTestDb, teardownTestDb } from "../test/fixtures/db.js";
import { installFetchMock, type FetchMock } from "../test/fixtures/fetch.js";

const samplePayload: WebhookPayload = {
  event: "audio_ready",
  recording: {
    id: "rec-1",
    filename: "sample.ogg",
    start_time_ms: 1_000_000,
    end_time_ms: 1_060_000,
    duration_ms: 60_000,
    filesize_bytes: 100,
    serial_number: "S1",
  },
  files: { folder: "f", audio: "f/a.ogg", transcript: "f/t.json", summary: "f/s.md" },
  http_urls: { audio: "x", transcript: "x", summary: "x" },
};

describe("fireRaw retry loop", () => {
  let db: Database.Database;
  let mock: FetchMock;

  beforeEach(() => {
    db = setupTestDb();
    mock = installFetchMock();
    // Skip the real 5s/30s/120s waits between attempts.
    vi.useFakeTimers();
  });

  afterEach(() => {
    mock.restore();
    teardownTestDb(db);
    vi.useRealTimers();
  });

  function logRowCount(): number {
    return (db.prepare("SELECT COUNT(*) AS c FROM webhook_log").get() as { c: number }).c;
  }

  /**
   * Drive a fireRaw call to completion under fake timers. Each retry inserts
   * a setTimeout we have to advance through; runAllTimersAsync walks the
   * cascade until everything resolves.
   */
  async function runWithTimers<T>(p: Promise<T>): Promise<T> {
    let done = false;
    const wrapped = p.finally(() => {
      done = true;
    });
    while (!done) {
      // Tick microtasks first so any synchronous fetch resolution settles
      // before we advance the next timer.
      await Promise.resolve();
      await vi.runAllTimersAsync();
    }
    return wrapped;
  }

  it("returns true after a single successful POST (no retry)", async () => {
    mock.enqueue({ status: 200, body: "ok" });
    const ok = await runWithTimers(
      fireRaw("https://hook.example/x", samplePayload, "rec-1", "audio_ready"),
    );
    expect(ok).toBe(true);
    expect(mock.calls.length).toBe(1);
    expect(logRowCount()).toBe(1);
  });

  it("retries on 5xx and succeeds on the third attempt (3 calls, 2 backoffs)", async () => {
    mock.enqueue({ status: 502 });
    mock.enqueue({ status: 503 });
    mock.enqueue({ status: 200, body: "ok" });
    const ok = await runWithTimers(
      fireRaw("https://hook.example/x", samplePayload, "rec-1", "audio_ready"),
    );
    expect(ok).toBe(true);
    expect(mock.calls.length).toBe(3);
    expect(logRowCount()).toBe(3);
  });

  it("returns false after exhausting all retries on persistent failure", async () => {
    mock.enqueue({ status: 500 });
    mock.enqueue({ status: 500 });
    mock.enqueue({ status: 500 });
    const ok = await runWithTimers(
      fireRaw("https://hook.example/x", samplePayload, "rec-1", "audio_ready"),
    );
    expect(ok).toBe(false);
    expect(mock.calls.length).toBe(3);
    expect(logRowCount()).toBe(3);
  });

  it("retries on network throw and succeeds on the second attempt", async () => {
    mock.enqueue({ throws: new Error("ECONNREFUSED") });
    mock.enqueue({ status: 200, body: "ok" });
    const ok = await runWithTimers(
      fireRaw("https://hook.example/x", samplePayload, "rec-1", "audio_ready"),
    );
    expect(ok).toBe(true);
    expect(mock.calls.length).toBe(2);
    // Network throw logs a row with null status.
    const errorRow = db
      .prepare<[], { status_code: number | null; error: string | null }>(
        "SELECT status_code, error FROM webhook_log ORDER BY id ASC LIMIT 1",
      )
      .get();
    expect(errorRow?.status_code).toBeNull();
    expect(errorRow?.error).toContain("ECONNREFUSED");
  });

  it("includes the X-Applaud-Signature header when a secret is provided", async () => {
    mock.enqueue({ status: 200 });
    await fireRaw("https://hook.example/x", samplePayload, "rec-1", "audio_ready", "shh");
    const call = mock.calls[0];
    expect(call).toBeDefined();
    const headers = (call!.init?.headers ?? {}) as Record<string, string>;
    expect(headers["x-applaud-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("omits the signature header entirely when no secret is provided", async () => {
    mock.enqueue({ status: 200 });
    await fireRaw("https://hook.example/x", samplePayload, "rec-1", "audio_ready");
    const headers = (mock.calls[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(headers).not.toHaveProperty("x-applaud-signature");
    // Confirms the absence is by-omission, not empty-string.
    expect(headers["x-applaud-event"]).toBe("audio_ready");
  });

  it("re-uses the same signature across retries (no re-sign per attempt)", async () => {
    mock.enqueue({ status: 502 });
    mock.enqueue({ status: 502 });
    mock.enqueue({ status: 200 });
    await runWithTimers(
      fireRaw("https://hook.example/x", samplePayload, "rec-1", "audio_ready", "shh"),
    );
    const sigs = mock.calls.map(
      (c) => (c.init!.headers as Record<string, string>)["x-applaud-signature"],
    );
    expect(new Set(sigs).size).toBe(1);
  });
});
