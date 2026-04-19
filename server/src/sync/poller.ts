import { writeFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import { logger } from "../logger.js";
import { listRecordings } from "../plaud/list.js";
import { downloadAudio, md5File } from "../plaud/audio.js";
import {
  getTranscriptAndSummary,
  flattenTranscript,
  extractSummaryMarkdown,
  fetchTranscriptFromContentList,
} from "../plaud/transcript.js";
import { getFileDetail } from "../plaud/detail.js";
import { PlaudAuthError } from "../plaud/client.js";
import {
  upsertFromPlaud,
  markAudioDownloaded,
  markTranscriptDownloaded,
  markSummaryDownloaded,
  markWebhookFired,
  recordError,
  getRecordingById,
  findRecordingsNeedingAssets,
} from "./state.js";
import { ensureRecordingFolder } from "./layout.js";
import { fireWebhookForRecording } from "../webhook/post.js";
import { emit } from "./events.js";
import type { RecordingRow } from "@applaud/shared";

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

  private async pollAndProcess(): Promise<void> {
    const cfg = loadConfig();
    if (!cfg.token || !cfg.recordingsDir || !cfg.setupComplete) return;
    this.authRequired = false;

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
      });
      if (page.status !== 0) {
        throw new Error(`Plaud list returned status=${page.status} msg=${page.msg}`);
      }
      totalReported = page.data_file_total ?? totalReported;
      const items = page.data_file_list ?? [];
      if (items.length === 0) break;
      for (const item of items) {
        try {
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
  }

  private async processRecording(row: RecordingRow): Promise<void> {
    const cfg = loadConfig();
    if (!cfg.recordingsDir) return;
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

    if (!row.transcriptDownloadedAt || !row.summaryDownloadedAt) {
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

  private async tryTranscriptAndSummary(row: RecordingRow): Promise<void> {
    const cfg = loadConfig();
    if (!cfg.recordingsDir) return;
    const paths = ensureRecordingFolder(cfg.recordingsDir, row.folder);

    const needTranscript = !row.transcriptDownloadedAt;
    const needSummary = !row.summaryDownloadedAt;
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
        writeFileSync(paths.summaryMdPath, md);
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
          writeFileSync(paths.summaryMdPath, summaryMd);
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
