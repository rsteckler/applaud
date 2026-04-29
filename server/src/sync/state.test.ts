import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import type { AppConfig, PlaudRawRecording } from "@applaud/shared";

// Hoisted mocks. Must be set up before importing state.ts.
const { loadConfig } = vi.hoisted(() => ({ loadConfig: vi.fn() }));
const fsMocks = vi.hoisted(() => ({
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  existsSync: vi.fn(() => true),
}));
vi.mock("../config.js", () => ({ loadConfig, updateConfig: vi.fn() }));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, ...fsMocks };
});
vi.mock("./events.js", () => ({ emit: vi.fn() }));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  upsertFromPlaud,
  softDeleteRecording,
  purgeExpiredSoftDeletes,
  purgeSoftDeletedRecordingNow,
  isSyncIgnoredId,
  SOFT_DELETE_RETENTION_MS,
} from "./state.js";
import { setupTestDb, teardownTestDb } from "../test/fixtures/db.js";

const baseConfig: AppConfig = {
  version: 1,
  setupComplete: true,
  token: "t",
  tokenExp: null,
  tokenEmail: null,
  plaudRegion: null,
  recordingsDir: "/test/recordings",
  webhook: null,
  pollIntervalMinutes: 10,
  bind: { host: "127.0.0.1", port: 44471 },
  lanToken: null,
  importPlaudDeleted: false,
};

function makePlaudItem(overrides: Partial<PlaudRawRecording> = {}): PlaudRawRecording {
  return {
    id: "abcdef0123456789",
    filename: "Standup",
    fullname: "Standup",
    filesize: 12345,
    file_md5: "deadbeef",
    start_time: Date.UTC(2026, 3, 11, 12, 0),
    end_time: Date.UTC(2026, 3, 11, 12, 1),
    duration: 60_000,
    version: 1,
    version_ms: 0,
    edit_time: 0,
    is_trash: false,
    is_trans: false,
    is_summary: true,
    serial_number: "S1",
    ...overrides,
  };
}

describe("upsertFromPlaud", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupTestDb();
    loadConfig.mockReset();
    loadConfig.mockReturnValue(baseConfig);
    fsMocks.renameSync.mockReset();
    fsMocks.rmSync.mockReset();
    fsMocks.existsSync.mockReset();
    fsMocks.existsSync.mockReturnValue(true);
  });

  afterEach(() => {
    teardownTestDb(db);
  });

  it("inserts a new recording with computed folder + paths", () => {
    const out = upsertFromPlaud(makePlaudItem());
    expect(out.id).toBe("abcdef0123456789");
    expect(out.folder).toBe("2026-04-11_Standup__abcdef01");
    expect(out.filesizeBytes).toBe(12345);
    expect(out.isTrash).toBe(false);
    expect(out.plaudIsSummary).toBe(true);
    expect(out.audioPath).toBe("/test/recordings/2026-04-11_Standup__abcdef01/audio.ogg");

    // Row really exists in DB.
    const row = db.prepare("SELECT * FROM recordings WHERE id = ?").get("abcdef0123456789");
    expect(row).toBeDefined();
  });

  it("renames folder on disk + DB when filename changes (different sanitized output)", () => {
    upsertFromPlaud(makePlaudItem({ filename: "Standup" }));
    fsMocks.renameSync.mockClear();
    upsertFromPlaud(makePlaudItem({ filename: "Standup renamed" }));

    expect(fsMocks.renameSync).toHaveBeenCalledTimes(1);
    const [oldAbs, newAbs] = fsMocks.renameSync.mock.calls[0]!;
    expect(oldAbs).toContain("2026-04-11_Standup__abcdef01");
    expect(newAbs).toContain("2026-04-11_Standup_renamed__abcdef01");

    const row = db
      .prepare<[string], { folder: string; filename: string }>(
        "SELECT folder, filename FROM recordings WHERE id = ?",
      )
      .get("abcdef0123456789");
    expect(row?.folder).toBe("2026-04-11_Standup_renamed__abcdef01");
    expect(row?.filename).toBe("Standup renamed");
  });

  it("skips rename when filename change does not affect sanitized folder name", () => {
    upsertFromPlaud(makePlaudItem({ filename: "Stand:up" }));
    fsMocks.renameSync.mockClear();
    // Both "Stand:up" and "Stand|up" sanitize to "Stand_up" — folder is unchanged.
    upsertFromPlaud(makePlaudItem({ filename: "Stand|up" }));
    expect(fsMocks.renameSync).not.toHaveBeenCalled();
    const row = db
      .prepare<[string], { filename: string }>("SELECT filename FROM recordings WHERE id = ?")
      .get("abcdef0123456789");
    expect(row?.filename).toBe("Stand|up");
  });

  it("flips is_trash and plaud_is_summary on subsequent upsert", () => {
    upsertFromPlaud(makePlaudItem({ is_trash: false, is_summary: true }));
    const after = upsertFromPlaud(makePlaudItem({ is_trash: true, is_summary: false }));
    expect(after.isTrash).toBe(true);
    expect(after.plaudIsSummary).toBe(false);
  });

  it("does not call renameSync when the on-disk folder is missing (existsSync false)", () => {
    upsertFromPlaud(makePlaudItem({ filename: "Original" }));
    fsMocks.existsSync.mockReturnValue(false);
    fsMocks.renameSync.mockClear();
    upsertFromPlaud(makePlaudItem({ filename: "New" }));
    // Folder didn't exist on disk → no rename. DB is still updated.
    expect(fsMocks.renameSync).not.toHaveBeenCalled();
    const row = db
      .prepare<[string], { folder: string }>("SELECT folder FROM recordings WHERE id = ?")
      .get("abcdef0123456789");
    expect(row?.folder).toBe("2026-04-11_New__abcdef01");
  });

  it("throws when recordingsDir is not configured", () => {
    loadConfig.mockReturnValue({ ...baseConfig, recordingsDir: null });
    expect(() => upsertFromPlaud(makePlaudItem())).toThrow(/recordingsDir/);
  });
});

describe("softDeleteRecording → purge flow", () => {
  let db: Database.Database;
  const NOW = Date.UTC(2026, 3, 28, 12, 0);

  beforeEach(() => {
    db = setupTestDb();
    loadConfig.mockReset();
    loadConfig.mockReturnValue(baseConfig);
    fsMocks.renameSync.mockReset();
    fsMocks.rmSync.mockReset();
    fsMocks.existsSync.mockReset();
    fsMocks.existsSync.mockReturnValue(true);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    teardownTestDb(db);
  });

  it("softDeleteRecording stamps user_deleted_at and user_purge_at = now + retention", () => {
    upsertFromPlaud(makePlaudItem());
    softDeleteRecording("abcdef0123456789");
    const row = db
      .prepare<[string], { user_deleted_at: number; user_purge_at: number }>(
        "SELECT user_deleted_at, user_purge_at FROM recordings WHERE id = ?",
      )
      .get("abcdef0123456789");
    expect(row?.user_deleted_at).toBe(NOW);
    expect(row?.user_purge_at).toBe(NOW + SOFT_DELETE_RETENTION_MS);
  });

  it("purgeExpiredSoftDeletes leaves rows alone before retention has elapsed", () => {
    upsertFromPlaud(makePlaudItem());
    softDeleteRecording("abcdef0123456789");
    // Advance just shy of the retention window.
    vi.setSystemTime(NOW + SOFT_DELETE_RETENTION_MS - 1);
    purgeExpiredSoftDeletes();
    expect(fsMocks.rmSync).not.toHaveBeenCalled();
    const row = db.prepare("SELECT id FROM recordings WHERE id = ?").get("abcdef0123456789");
    expect(row).toBeDefined();
  });

  it("purgeExpiredSoftDeletes removes files, inserts sync_ignore, and deletes the row after retention", () => {
    upsertFromPlaud(makePlaudItem());
    softDeleteRecording("abcdef0123456789");
    vi.setSystemTime(NOW + SOFT_DELETE_RETENTION_MS + 1);
    purgeExpiredSoftDeletes();

    expect(fsMocks.rmSync).toHaveBeenCalledTimes(1);
    expect(fsMocks.rmSync.mock.calls[0]![0]).toContain("2026-04-11_Standup__abcdef01");
    expect(isSyncIgnoredId("abcdef0123456789")).toBe(true);
    const row = db.prepare("SELECT id FROM recordings WHERE id = ?").get("abcdef0123456789");
    expect(row).toBeUndefined();
  });

  it("purge keeps the DB row when disk removal fails (no orphan-on-disk)", () => {
    upsertFromPlaud(makePlaudItem());
    softDeleteRecording("abcdef0123456789");
    fsMocks.rmSync.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });
    vi.setSystemTime(NOW + SOFT_DELETE_RETENTION_MS + 1);
    purgeExpiredSoftDeletes();

    // Row still present, sync_ignore NOT inserted, last_error captured.
    const row = db
      .prepare<[string], { id: string; last_error: string | null }>(
        "SELECT id, last_error FROM recordings WHERE id = ?",
      )
      .get("abcdef0123456789");
    expect(row).toBeDefined();
    expect(row?.last_error).toContain("Purge failed");
    expect(isSyncIgnoredId("abcdef0123456789")).toBe(false);
  });

  it("purgeSoftDeletedRecordingNow returns 'not_found' for unknown id", () => {
    expect(purgeSoftDeletedRecordingNow("missing-id")).toBe("not_found");
  });

  it("purgeSoftDeletedRecordingNow returns 'not_in_trash' when row was never soft-deleted", () => {
    upsertFromPlaud(makePlaudItem());
    expect(purgeSoftDeletedRecordingNow("abcdef0123456789")).toBe("not_in_trash");
  });

  it("purgeSoftDeletedRecordingNow purges immediately regardless of retention window", () => {
    upsertFromPlaud(makePlaudItem());
    softDeleteRecording("abcdef0123456789");
    // No time advance — should still succeed.
    expect(purgeSoftDeletedRecordingNow("abcdef0123456789")).toBe("ok");
    expect(fsMocks.rmSync).toHaveBeenCalledTimes(1);
    expect(isSyncIgnoredId("abcdef0123456789")).toBe(true);
  });
});
