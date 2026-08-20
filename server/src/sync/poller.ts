import { writeFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import { logger } from "../logger.js";
import { listRecordings } from "../plaud/list.js";
import { downloadAudio } from "../plaud/audio.js";
import {
  getTranscriptAndSummary,
  flattenTranscript,
  extractSummaryMarkdown,
  fetchTranscriptFromContentList,
} from "../plaud/transcript.js";
import { getFileDetail } from "../plaud/detail.js";
import { PlaudAuthError, isPlaudAuthStatus } from "../plaud/client.js";
import { ensureFreshWorkspaceToken } from "../plaud/first-party.js";
import {
  upsertFromPlaud,
  markAudioDownloaded,
  markTranscriptDownloaded,
  markSummaryDownloaded,
  markWebhookFired,
  recordError,
  getRecordingById,
  findRecordingsNeedingAssets,
  purgeExpiredSoftDeletes,
  isSyncIgnoredId,
  findPlaudTrashAssetProbeCandidates,
  markTrashAssetProbed,
  PLAUD_TRASH_ASSET_PROBE_INTERVAL_MS,
  PLAUD_TRASH_ASSET_PROBE_SCHEDULED_LIMIT,
  PLAUD_TRASH_ASSET_PROBE_MANUAL_SYNC_LIMIT,
  clearError,
  resetPlaudTrashAssetProbeTimestamps,
} from "./state.js";
import { ensureRecordingFolder } from "./layout.js";
import { fireWebhookForRecording } from "../webhook/post.js";
import { emit } from "./events.js";
import type { RecordingRow } from "@applaud/shared";
import { sanitizePlaudSummaryMarkdown } from "@applaud/shared";

export interface PollerStatus {
  lastPollAt: number | null;
  nextPollAt: number | null;
  polling: boolean;
  lastError: string | null;
  authRequired: boolean;
}

class Poller {
  private interval: NodeJS.Timeout | null = null;
  private inFlight = false;
  private queuedTrigger = false;
  /** Set by trigger(); consumed on next poll past config gate — manual reset + higher Phase 3 probe cap. */
  private pendingManualSync = false;
  lastPollAt: number | null = null;
  nextPollAt: number | null = null;
  lastError: string | null = null;
  authRequired = false;

  start(): void {
    if (this.interval) return;
    const cfg = loadConfig();
    const ms = Math.max(cfg.pollIntervalMinutes, 1) * 60 * 1000;
    const runAndSchedule = (): void => {
      void this.runOnce().finally(() => {
        this.nextPollAt = Date.now() + ms;
      });
    };
    // Kick off immediately, then schedule.
    runAndSchedule();
    this.interval = setInterval(runAndSchedule, ms);
    logger.info({ intervalMinutes: cfg.pollIntervalMinutes }, "poller started");
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    logger.info("poller stopped");
  }

  async trigger(): Promise<void> {
    this.pendingManualSync = true;
    if (this.inFlight) {
      this.queuedTrigger = true;
      return;
    }
    await this.runOnce();
  }

  status(): PollerStatus {
    return {
      lastPollAt: this.lastPollAt,
      nextPollAt: this.nextPollAt,
      polling: this.inFlight,
      lastError: this.lastError,
      authRequired: this.authRequired,
    };
  }

  private async runOnce(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    emit("poll_start");
    try {
      await this.pollAndProcess();
      this.lastError = null;
    } catch (err) {
      // First-party mid-poll 401: Plaud rejected an unexpired WT (revoked or
      // rotated). Force one re-mint and retry the whole cycle before giving up.
      if (err instanceof PlaudAuthError && loadConfig().authMode === "first_party") {
        try {
          await ensureFreshWorkspaceToken(true);
          await this.pollAndProcess();
          this.lastError = null;
          return;
        } catch (retryErr) {
          this.handlePollError(retryErr);
          return;
        }
      }
      this.handlePollError(err);
    } finally {
      this.lastPollAt = Date.now();
      this.inFlight = false;
      emit("poll_end");
      if (this.queuedTrigger) {
        this.queuedTrigger = false;
        void this.runOnce();
      }
    }
  }

  private handlePollError(err: unknown): void {
    if (err instanceof PlaudAuthError) {
      this.authRequired = true;
      this.lastError = err.message;
      emit("auth_required", { message: err.message });
      logger.warn({ err }, "poller paused: auth required");
    } else {
      this.lastError = err instanceof Error ? err.message : String(err);
      emit("error", { message: this.lastError });
      logger.error({ err }, "poll failed");
    }
  }

  private async pollAndProcess(): Promise<void> {
    const cfg = loadConfig();
    if (!cfg.token || !cfg.recordingsDir || !cfg.setupComplete) return;

    // First-party sessions cache a short-lived workspace token; refresh/re-mint
    // it before the poll if it's stale. No-op for legacy installs. May throw
    // PlaudAuthError (reconnect required) or a transient Error, both handled by
    // runOnce. Subsequent Plaud calls read the freshly-persisted token.
    await ensureFreshWorkspaceToken();

    const isManualSync = this.pendingManualSync;
    if (isManualSync) this.pendingManualSync = false;

    if (isManualSync && cfg.importPlaudDeleted) {
      const cleared = resetPlaudTrashAssetProbeTimestamps();
      if (cleared > 0) {
        logger.info({ rows: cleared }, "manual sync: cleared Plaud trash transcript/summary probe throttles");
      }
    }

    this.authRequired = false;

    purgeExpiredSoftDeletes();

    const listTrashMode = cfg.importPlaudDeleted ? 2 : 0;

    // Phase 1 — Discovery: walk Plaud's recording list and upsert metadata for
    // any new rows. Upsert is a no-op for rows we already have. No fetching
    // happens here.
    const PAGE_SIZE = 50;
    const MAX_PAGES = 200;
    let fetched = 0;
    let totalReported = 0;
    for (let pageIdx = 0; pageIdx < MAX_PAGES; pageIdx++) {
      const page = await listRecordings({
        skip: pageIdx * PAGE_SIZE,
        limit: PAGE_SIZE,
        isTrash: listTrashMode,
      });
      if (page.status !== 0) {
        const msg = `Plaud list returned status=${page.status} msg=${page.msg}`;
        // Auth codes must surface as PlaudAuthError so the mid-poll forced
        // re-mint above can recover; a plain Error stalls until the WT's own
        // exp claim lapses, which can be ~24h after Plaud revoked it.
        if (isPlaudAuthStatus(page.status)) throw new PlaudAuthError(msg);
        throw new Error(msg);
      }
      totalReported = page.data_file_total ?? totalReported;
      const items = page.data_file_list ?? [];
      if (items.length === 0) break;
      for (const item of items) {
        try {
          if (isSyncIgnoredId(item.id)) continue;
          if (item.is_trash && !cfg.importPlaudDeleted) continue;
          const pre = getRecordingById(item.id);
          if (pre?.userDeletedAt) continue;
          upsertFromPlaud(item);
          fetched++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ err, id: item.id }, "upsert failed");
          recordError(item.id, msg);
          emit("error", { recordingId: item.id, message: msg });
        }
      }
      if (items.length < PAGE_SIZE) break;
    }
    logger.info({ fetched, reportedTotal: totalReported }, "list walk complete");

    // Phase 2 — Fetch: for every recording with any missing asset, try to
    // fetch the missing ones. Each asset is independent; each gets retried on
    // every poll until it's downloaded.
    const needy = findRecordingsNeedingAssets();
    for (const row of needy) {
      await this.processRecording(row).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err, id: row.id }, "processRecording failed");
        recordError(row.id, msg);
        emit("error", { recordingId: row.id, message: msg });
      });
    }

    // Phase 3 — Plaud trash: best-effort transcript/summary check (throttled).
    // Not included in pending counts or findRecordingsNeedingAssets; failures do not set last_error.
    if (cfg.importPlaudDeleted) {
      const probeCutoff = Date.now() - PLAUD_TRASH_ASSET_PROBE_INTERVAL_MS;
      const probeLimit = isManualSync
        ? PLAUD_TRASH_ASSET_PROBE_MANUAL_SYNC_LIMIT
        : PLAUD_TRASH_ASSET_PROBE_SCHEDULED_LIMIT;
      const trashProbe = findPlaudTrashAssetProbeCandidates(probeCutoff, probeLimit);
      for (const row of trashProbe) {
        try {
          clearError(row.id);
          await this.tryTranscriptAndSummary(row, true);
        } catch (err) {
          logger.info(
            { err, id: row.id },
            "plaud trash asset probe: no transcript/summary to ingest or transient error (ignored)",
          );
        } finally {
          markTrashAssetProbed(row.id);
        }
      }
    }
  }

  private async processRecording(row: RecordingRow): Promise<void> {
    const cfg = loadConfig();
    if (!cfg.recordingsDir) return;
    if (isSyncIgnoredId(row.id)) return;
    if (row.userDeletedAt) return;
    if (row.isTrash && !cfg.importPlaudDeleted) return;

    const paths = ensureRecordingFolder(cfg.recordingsDir, row.folder);

    // Each asset is retried independently — a failure fetching one doesn't
    // block the others. Errors are recorded on the row and the loop continues.
    if (!row.audioDownloadedAt) {
      try {
        try {
          const detail = await getFileDetail(row.id);
          writeFileSync(paths.metadataPath, JSON.stringify(detail, null, 2));
        } catch (err) {
          logger.warn({ err, id: row.id }, "file detail fetch failed (non-fatal)");
        }

        const bytes = await downloadAudio(row.id, paths.audioPath);
        markAudioDownloaded(row.id, bytes || row.filesizeBytes);
        emit("recording_new", { recordingId: row.id });

        const fresh = getRecordingById(row.id);
        if (fresh) {
          const fired = await fireWebhookForRecording("audio_ready", fresh);
          if (fired) markWebhookFired(row.id, "audio_ready");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err, id: row.id }, "audio download failed");
        recordError(row.id, msg);
        emit("error", { recordingId: row.id, message: msg });
      }
    }

    const wantSummary = !row.summaryDownloadedAt && row.plaudIsSummary;
    if (!row.isTrash && (!row.transcriptDownloadedAt || wantSummary)) {
      try {
        await this.tryTranscriptAndSummary(row);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err, id: row.id }, "transcript/summary fetch failed");
        recordError(row.id, msg);
        emit("error", { recordingId: row.id, message: msg });
      }
    }
  }

  private async tryTranscriptAndSummary(row: RecordingRow, opportunistic = false): Promise<void> {
    if (opportunistic) {
      if (!row.isTrash) return;
    } else if (row.isTrash) {
      return;
    }
    const cfg = loadConfig();
    if (!cfg.recordingsDir) return;
    const paths = ensureRecordingFolder(cfg.recordingsDir, row.folder);

    const needTranscript = !row.transcriptDownloadedAt;
    const needSummary = !row.summaryDownloadedAt && row.plaudIsSummary;
    let wroteTranscript = false;
    let wroteSummary = false;

    // Primary: transsumm endpoint. Returns transcript + summary together for
    // newer recordings. Shape of data_result_summ varies per recording — the
    // extractor handles that.
    const resp = await getTranscriptAndSummary(row.id);
    if (needTranscript && resp.data_result && resp.data_result.length > 0) {
      writeFileSync(paths.transcriptJsonPath, JSON.stringify(resp, null, 2));
      const txtContent = flattenTranscript(resp.data_result);
      writeFileSync(paths.transcriptTxtPath, txtContent);
      markTranscriptDownloaded(row.id, txtContent);
      wroteTranscript = true;
    }
    if (needSummary) {
      const md = extractSummaryMarkdown(resp);
      if (md) {
        const cleaned = sanitizePlaudSummaryMarkdown(md, {
          startTimeMs: row.startTime,
          endTimeMs: row.endTime,
        });
        writeFileSync(paths.summaryMdPath, cleaned);
        markSummaryDownloaded(row.id);
        wroteSummary = true;
      }
    }

    // Fallback: pre-March-2026 recordings where transsumm returns status:-12
    // with empty data_result. Transcript + summary live as S3 artifacts in
    // /file/detail content_list, tagged by data_type "transaction" and
    // "auto_sum_note" respectively.
    const stillNeedTranscript = needTranscript && !wroteTranscript;
    const stillNeedSummary = needSummary && !wroteSummary;
    if (stillNeedTranscript || stillNeedSummary) {
      logger.info(
        { id: row.id, stillNeedTranscript, stillNeedSummary },
        "trying content_list fallback",
      );
      const detail = await getFileDetail(row.id);
      if (detail.content_list && detail.content_list.length > 0) {
        const { segments, summaryMd } = await fetchTranscriptFromContentList(detail.content_list);
        if (stillNeedTranscript && segments.length > 0) {
          writeFileSync(paths.transcriptJsonPath, JSON.stringify(segments, null, 2));
          const txtContent = flattenTranscript(segments);
          writeFileSync(paths.transcriptTxtPath, txtContent);
          markTranscriptDownloaded(row.id, txtContent);
          wroteTranscript = true;
        }
        if (stillNeedSummary && summaryMd) {
          const cleaned = sanitizePlaudSummaryMarkdown(summaryMd, {
            startTimeMs: row.startTime,
            endTimeMs: row.endTime,
          });
          writeFileSync(paths.summaryMdPath, cleaned);
          markSummaryDownloaded(row.id);
          wroteSummary = true;
        }
      }
    }

    // transcript_ready fires only on a null→set transition; summary-only
    // backfills don't refire the webhook.
    if (wroteTranscript) {
      emit("recording_downloaded", { recordingId: row.id });
      const fresh = getRecordingById(row.id);
      if (fresh) {
        const fired = await fireWebhookForRecording("transcript_ready", fresh);
        if (fired) markWebhookFired(row.id, "transcript_ready");
      }
    }
  }
}

export const poller = new Poller();
