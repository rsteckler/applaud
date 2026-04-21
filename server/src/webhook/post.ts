import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { WebhookPayload, WebhookEvent, RecordingRow } from "@applaud/shared";
import { sanitizePlaudSummaryMarkdown } from "@applaud/shared";
import { loadConfig } from "../config.js";
import { getDb } from "../db.js";
import { logger } from "../logger.js";
import { signPayload } from "./sign.js";

const BACKOFF_MS = [5_000, 30_000, 120_000];

function readIfExists(absPath: string): string | null {
  try {
    if (!existsSync(absPath)) return null;
    return readFileSync(absPath, "utf8");
  } catch (err) {
    logger.warn({ err, absPath }, "failed to read file for webhook inline content");
    return null;
  }
}

function buildPayload(event: WebhookEvent, row: RecordingRow): WebhookPayload {
  const cfg = loadConfig();
  const host = cfg.bind.host === "0.0.0.0" ? "127.0.0.1" : cfg.bind.host;
  const base = `http://${host}:${cfg.bind.port}/media/${encodeURI(row.folder)}`;
  const payload: WebhookPayload = {
    event,
    recording: {
      id: row.id,
      filename: row.filename,
      start_time_ms: row.startTime,
      end_time_ms: row.endTime,
      duration_ms: row.durationMs,
      filesize_bytes: row.filesizeBytes,
      serial_number: row.serialNumber,
    },
    files: {
      folder: row.folder,
      audio: `${row.folder}/audio.ogg`,
      transcript: `${row.folder}/transcript.json`,
      summary: `${row.folder}/summary.md`,
    },
    http_urls: {
      audio: `${base}/audio.ogg`,
      transcript: `${base}/transcript.json`,
      summary: `${base}/summary.md`,
    },
  };

  if (event === "transcript_ready" && cfg.recordingsDir) {
    const folderAbs = path.join(cfg.recordingsDir, row.folder);
    const rawSummary = readIfExists(path.join(folderAbs, "summary.md"));
    payload.content = {
      transcript_text: readIfExists(path.join(folderAbs, "transcript.txt")),
      summary_markdown:
        rawSummary != null
          ? sanitizePlaudSummaryMarkdown(rawSummary, {
              startTimeMs: row.startTime,
              endTimeMs: row.endTime,
            })
          : null,
    };
  }

  return payload;
}

function logAttempt(
  recordingId: string | null,
  event: WebhookEvent,
  url: string,
  statusCode: number | null,
  snippet: string | null,
  durationMs: number,
  error: string | null,
): void {
  getDb()
    .prepare(
      `INSERT INTO webhook_log (recording_id, event, url, status_code, response_snippet, fired_at, duration_ms, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(recordingId, event, url, statusCode, snippet, Date.now(), durationMs, error);
}

export async function fireWebhookForRecording(
  event: WebhookEvent,
  row: RecordingRow,
): Promise<boolean> {
  const cfg = loadConfig();
  if (!cfg.webhook || !cfg.webhook.enabled || !cfg.webhook.url) return false;
  const payload = buildPayload(event, row);
  return fireRaw(cfg.webhook.url, payload, row.id, event, cfg.webhook.secret);
}

async function fireRaw(
  url: string,
  payload: WebhookPayload,
  recordingId: string | null,
  event: WebhookEvent,
  secret?: string,
): Promise<boolean> {
  const body = JSON.stringify(payload);
  const signature = secret ? signPayload(secret, body) : null;
  for (let attempt = 0; attempt < BACKOFF_MS.length; attempt++) {
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "applaud/0.1.0",
          "x-applaud-event": event,
          ...(signature ? { "x-applaud-signature": signature } : {}),
        },
        body,
      });
      const text = (await res.text().catch(() => "")).slice(0, 500);
      const ok = res.status >= 200 && res.status < 300;
      logAttempt(recordingId, event, url, res.status, text, Date.now() - started, ok ? null : `HTTP ${res.status}`);
      if (ok) return true;
      if (attempt < BACKOFF_MS.length - 1) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
        continue;
      }
      return false;
    } catch (err) {
      logAttempt(
        recordingId,
        event,
        url,
        null,
        null,
        Date.now() - started,
        err instanceof Error ? err.message : String(err),
      );
      if (attempt < BACKOFF_MS.length - 1) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
        continue;
      }
      logger.warn({ err, url }, "webhook fired up all retries");
      return false;
    }
  }
  return false;
}

function buildTestPayload(): WebhookPayload & { test: true } {
  const cfg = loadConfig();
  const host = cfg.bind.host === "0.0.0.0" ? "127.0.0.1" : cfg.bind.host;
  const folder = "2026/04/11/sample-recording";
  const base = `http://${host}:${cfg.bind.port}/media/${encodeURI(folder)}`;
  const now = Date.now();
  return {
    test: true,
    event: "transcript_ready",
    recording: {
      id: "sample-recording-id",
      filename: "sample.ogg",
      start_time_ms: now - 60_000,
      end_time_ms: now,
      duration_ms: 60_000,
      filesize_bytes: 123456,
      serial_number: "SAMPLE1234",
    },
    files: {
      folder,
      audio: `${folder}/audio.ogg`,
      transcript: `${folder}/transcript.json`,
      summary: `${folder}/summary.md`,
    },
    http_urls: {
      audio: `${base}/audio.ogg`,
      transcript: `${base}/transcript.json`,
      summary: `${base}/summary.md`,
    },
    content: {
      transcript_text: "This is a sample transcript from an Applaud test webhook.",
      summary_markdown: "# Sample Summary\n\nThis is a sample summary from an Applaud test webhook.",
    },
  };
}

/** Test a webhook URL without retries, for UI validation. */
export async function testWebhook(
  url: string,
): Promise<{ ok: boolean; statusCode?: number; bodySnippet?: string; error?: string; durationMs: number }> {
  const started = Date.now();
  const body = JSON.stringify(buildTestPayload());
  const cfg = loadConfig();
  const secret = cfg.webhook?.secret;
  const signature = secret ? signPayload(secret, body) : null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "applaud/0.1.0",
        "x-applaud-event": "transcript_ready",
        "x-applaud-test": "1",
        ...(signature ? { "x-applaud-signature": signature } : {}),
      },
      body,
    });
    const text = (await res.text().catch(() => "")).slice(0, 500);
    return {
      ok: res.status >= 200 && res.status < 300,
      statusCode: res.status,
      bodySnippet: text,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
    };
  }
}
