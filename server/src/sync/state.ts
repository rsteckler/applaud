import { renameSync, existsSync } from "node:fs";
import path from "node:path";
import type { RecordingRow, PlaudRawRecording } from "@applaud/shared";
import { getDb, rowToRecording, type RecordingDbRow } from "../db.js";
import { folderName, recordingPaths } from "./layout.js";
import { loadConfig } from "../config.js";
import { logger } from "../logger.js";
import { emit } from "./events.js";

export function upsertFromPlaud(item: PlaudRawRecording): RecordingRow {
  const db = getDb();
  const existing = db
    .prepare<[string], RecordingDbRow>("SELECT * FROM recordings WHERE id = ?")
    .get(item.id);
  if (existing) {
    if (existing.filename !== item.filename) {
      renameRecordingFolder(existing, item.filename);
    }
    const trashVal = item.is_trash ? 1 : 0;
    if (existing.is_trash !== trashVal) {
      db.prepare("UPDATE recordings SET is_trash = ? WHERE id = ?").run(trashVal, item.id);
    }
    return rowToRecording(
      db.prepare<[string], RecordingDbRow>("SELECT * FROM recordings WHERE id = ?").get(item.id)!,
    );
  }

  const cfg = loadConfig();
  if (!cfg.recordingsDir) throw new Error("recordingsDir not configured");
  const folder = folderName(item.start_time, item.filename, item.id);
  const paths = recordingPaths(cfg.recordingsDir, folder);

  db.prepare(
    `INSERT INTO recordings (
      id, filename, start_time, end_time, duration_ms, filesize_bytes, serial_number,
      folder, audio_path, transcript_path, summary_path, metadata_path,
      audio_downloaded_at, transcript_downloaded_at, webhook_audio_fired_at,
      webhook_transcript_fired_at, is_trash, last_error, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL, NULL)`,
  ).run(
    item.id,
    item.filename,
    item.start_time,
    item.end_time,
    item.duration,
    item.filesize,
    item.serial_number,
    folder,
    paths.audioPath,
    paths.transcriptJsonPath,
    paths.summaryMdPath,
    paths.metadataPath,
    item.is_trash ? 1 : 0,
  );

  return rowToRecording(
    db
      .prepare<[string], RecordingDbRow>("SELECT * FROM recordings WHERE id = ?")
      .get(item.id)!,
  );
}

function renameRecordingFolder(row: RecordingDbRow, newFilename: string): void {
  const cfg = loadConfig();
  if (!cfg.recordingsDir) return;

  const newFolder = folderName(row.start_time, newFilename, row.id);
  if (newFolder === row.folder) {
    getDb().prepare("UPDATE recordings SET filename = ? WHERE id = ?").run(newFilename, row.id);
    emit("recording_renamed", { recordingId: row.id });
    return;
  }

  const oldAbs = path.join(cfg.recordingsDir, row.folder);
  const newAbs = path.join(cfg.recordingsDir, newFolder);

  if (existsSync(oldAbs)) {
    renameSync(oldAbs, newAbs);
    logger.info({ id: row.id, oldFolder: row.folder, newFolder }, "renamed recording folder");
  }

  const newPaths = recordingPaths(cfg.recordingsDir, newFolder);
  getDb()
    .prepare(
      `UPDATE recordings
         SET filename = ?, folder = ?, audio_path = ?, transcript_path = ?, summary_path = ?, metadata_path = ?
       WHERE id = ?`,
    )
    .run(
      newFilename,
      newFolder,
      newPaths.audioPath,
      newPaths.transcriptJsonPath,
      newPaths.summaryMdPath,
      newPaths.metadataPath,
      row.id,
    );
  emit("recording_renamed", { recordingId: row.id });
}

export function markAudioDownloaded(id: string, sizeBytes: number): void {
  const now = Date.now();
  getDb()
    .prepare(
      "UPDATE recordings SET audio_downloaded_at = ?, filesize_bytes = ?, last_error = NULL WHERE id = ?",
    )
    .run(now, sizeBytes, id);
}

export function markTranscriptDownloaded(id: string, transcriptText?: string): void {
  const now = Date.now();
  getDb()
    .prepare(
      "UPDATE recordings SET transcript_downloaded_at = ?, transcript_text = ?, last_error = NULL WHERE id = ?",
    )
    .run(now, transcriptText ?? null, id);
}

export function markSummaryDownloaded(id: string): void {
  getDb()
    .prepare("UPDATE recordings SET summary_downloaded_at = ? WHERE id = ?")
    .run(Date.now(), id);
}

export function markWebhookFired(id: string, event: "audio_ready" | "transcript_ready"): void {
  const col = event === "audio_ready" ? "webhook_audio_fired_at" : "webhook_transcript_fired_at";
  getDb().prepare(`UPDATE recordings SET ${col} = ? WHERE id = ?`).run(Date.now(), id);
}

export function recordError(id: string, message: string): void {
  getDb()
    .prepare("UPDATE recordings SET last_error = ? WHERE id = ?")
    .run(message.slice(0, 500), id);
}

export function clearError(id: string): void {
  getDb().prepare("UPDATE recordings SET last_error = NULL WHERE id = ?").run(id);
}

export function listRecordingRows(
  opts: { limit?: number; offset?: number; search?: string } = {},
): { total: number; totalBytes: number; items: RecordingRow[] } {
  const db = getDb();
  const limit = Math.min(opts.limit ?? 100, 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const search = opts.search?.trim();

  let aggRow: { c: number; b: number } | undefined;
  let rows: RecordingDbRow[];
  if (search) {
    const like = `%${search}%`;
    aggRow = db
      .prepare<[string, string], { c: number; b: number }>(
        "SELECT COUNT(*) AS c, COALESCE(SUM(filesize_bytes), 0) AS b FROM recordings WHERE filename LIKE ? OR transcript_text LIKE ?",
      )
      .get(like, like);
    rows = db
      .prepare<[string, string, number, number], RecordingDbRow>(
        "SELECT * FROM recordings WHERE filename LIKE ? OR transcript_text LIKE ? ORDER BY start_time DESC LIMIT ? OFFSET ?",
      )
      .all(like, like, limit, offset);
  } else {
    aggRow = db.prepare<[], { c: number; b: number }>("SELECT COUNT(*) AS c, COALESCE(SUM(filesize_bytes), 0) AS b FROM recordings").get();
    rows = db
      .prepare<[number, number], RecordingDbRow>(
        "SELECT * FROM recordings ORDER BY start_time DESC LIMIT ? OFFSET ?",
      )
      .all(limit, offset);
  }
  return {
    total: aggRow?.c ?? 0,
    totalBytes: aggRow?.b ?? 0,
    items: rows.map(rowToRecording),
  };
}

export function getRecordingById(id: string): RecordingRow | null {
  const row = getDb()
    .prepare<[string], RecordingDbRow>("SELECT * FROM recordings WHERE id = ?")
    .get(id);
  return row ? rowToRecording(row) : null;
}

export function deleteRecording(id: string): void {
  getDb().prepare("DELETE FROM recordings WHERE id = ?").run(id);
}

export function countPendingAssets(): number {
  const row = getDb()
    .prepare<[], { c: number }>(
      `SELECT COUNT(*) AS c FROM recordings
       WHERE audio_downloaded_at IS NULL
          OR transcript_downloaded_at IS NULL
          OR summary_downloaded_at IS NULL`,
    )
    .get();
  return row?.c ?? 0;
}

export function countErrorsLast24h(): number {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const row = getDb()
    .prepare<[number, number], { c: number }>(
      "SELECT COUNT(*) AS c FROM recordings WHERE last_error IS NOT NULL AND (audio_downloaded_at > ? OR transcript_downloaded_at > ?)",
    )
    .get(cutoff, cutoff);
  return row?.c ?? 0;
}

export function findRecordingsNeedingAssets(): RecordingRow[] {
  const rows = getDb()
    .prepare<[], RecordingDbRow>(
      `SELECT * FROM recordings
       WHERE audio_downloaded_at IS NULL
          OR transcript_downloaded_at IS NULL
          OR summary_downloaded_at IS NULL
       ORDER BY start_time DESC`,
    )
    .all();
  return rows.map(rowToRecording);
}
