import Database from "better-sqlite3";
import { runMigrations, setDbForTests } from "../../db.js";

/**
 * Build a fresh in-memory SQLite handle with the production schema applied,
 * and install it as the cached `getDb()` singleton so production code under
 * test transparently uses it. Pair every call with `teardownTestDb()`.
 */
export function setupTestDb(): Database.Database {
  const handle = new Database(":memory:");
  handle.pragma("foreign_keys = ON");
  runMigrations(handle);
  setDbForTests(handle);
  return handle;
}

export function teardownTestDb(handle: Database.Database): void {
  // Close the handle BEFORE clearing the singleton so that any in-flight
  // microtask calling getDb() in the gap can't open a fresh file-backed DB
  // and leak that handle when we then null it.
  try {
    handle.close();
  } catch {
    /* already closed */
  }
  setDbForTests(null);
}
