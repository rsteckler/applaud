// Read Plaud's first-party session cookies (`pld_ut` / `pld_urt`) from a
// Chromium profile ON DISK.
//
// This is the file-based counterpart to the RoveNotes Connector, which reads
// the same two cookies via `chrome.cookies.getAll()`. Applaud has no browser
// process to ask, so it reads Chromium's on-disk cookie store directly:
//
//   1. The store is a SQLite DB (`<profile>/Network/Cookies`, or the older
//      `<profile>/Cookies`). We copy it to a temp path first — Chromium holds
//      a lock on the live file exactly like it does on the LevelDB store.
//   2. Cookie values are encrypted at rest. We decrypt with the platform
//      scheme (Linux: AES-128-CBC keyed off the login keyring or the well-known
//      "peanuts" fallback; macOS: AES-128-CBC keyed off the Keychain). Rather
//      than parse the plaintext layout (which varies by Chrome version and can
//      carry a leading domain-hash), we extract the JWT with a regex — the same
//      trick `chrome-leveldb.ts` uses for the localStorage token.
//
// Windows (DPAPI / App-Bound Encryption) is not decrypted here; those users
// fall back to the manual paste flow. All failures are non-fatal: a profile we
// can't read is skipped, and the caller degrades to manual paste.

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pbkdf2Sync, createDecipheriv } from "node:crypto";
import Database from "better-sqlite3";
import { logger } from "../logger.js";
import { discoverProfiles, type BrowserProfile } from "./profiles.js";
import { parseJwtClaims } from "./jwt.js";

const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

// AES-CBC parameters shared by the Linux and macOS Chromium schemes.
const SALT = "saltysalt";
const AES_CBC_IV = Buffer.alloc(16, " "); // 16 spaces
const KEY_LENGTH = 16; // AES-128

export interface FirstPartyCookies {
  ut: string;
  urt: string;
  browser: string;
  profile: string;
}

interface CookieRow {
  name: string;
  hostKey: string;
  encryptedValue: Buffer;
  value: string;
}

/**
 * Derive an AES-128 key from a passphrase using Chromium's PBKDF2-SHA1
 * parameters. Iterations differ by platform: 1 on Linux, 1003 on macOS.
 */
export function deriveCbcKey(passphrase: string, iterations: number): Buffer {
  return pbkdf2Sync(passphrase, SALT, iterations, KEY_LENGTH, "sha1");
}

/**
 * Decrypt a Chromium `encrypted_value` (a `v10`/`v11`-prefixed AES-128-CBC
 * blob) by trying each candidate key and returning the first plaintext that
 * contains a JWT. Auto-padding is disabled and the JWT is regex-extracted, so
 * PKCS7 padding bytes and any leading domain-hash prefix are ignored. Returns
 * `null` when no key yields a JWT.
 */
export function decryptCbcCookie(encrypted: Buffer, keys: Buffer[]): string | null {
  if (encrypted.length <= 3) return null;
  const prefix = encrypted.subarray(0, 3).toString("latin1");
  if (prefix !== "v10" && prefix !== "v11") return null;
  const body = encrypted.subarray(3);
  for (const key of keys) {
    try {
      const decipher = createDecipheriv("aes-128-cbc", key, AES_CBC_IV);
      decipher.setAutoPadding(false);
      const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString("latin1");
      const m = plain.match(JWT_RE);
      if (m) return m[0];
    } catch {
      // wrong key / bad block — try the next candidate
    }
  }
  return null;
}

/** Candidate decryption keys for the current platform, best-effort. */
function candidateKeys(browser: string, userDataDir: string): Buffer[] {
  const plat = platform();
  if (plat === "linux") {
    const keys: Buffer[] = [];
    // Try the login-keyring password ("v11"), then the "peanuts" fallback
    // ("v10", used when no keyring is available — common on headless/server
    // installs). We can't tell which a given cookie used without trying, and
    // decryptCbcCookie validates by JWT presence, so order is just efficiency.
    const keyringPw = readLinuxKeyringPassword(browser);
    if (keyringPw) keys.push(deriveCbcKey(keyringPw, 1));
    keys.push(deriveCbcKey("peanuts", 1));
    return keys;
  }
  if (plat === "darwin") {
    const pw = readMacKeychainPassword(browser);
    return pw ? [deriveCbcKey(pw, 1003)] : [];
  }
  // Windows and everything else: not supported on disk — use manual paste.
  void userDataDir;
  return [];
}

/** Service name Chromium stores its "Safe Storage" secret under, per brand. */
function safeStorageService(browser: string): string {
  switch (browser) {
    case "Edge":
      return "Microsoft Edge";
    case "Brave":
      return "Brave";
    case "Chromium":
      return "Chromium";
    case "Vivaldi":
      return "Vivaldi";
    default:
      return "Chrome";
  }
}

function readLinuxKeyringPassword(browser: string): string | null {
  const service = safeStorageService(browser);
  // libsecret's secret-tool; absent on many systems, hence best-effort.
  for (const attrs of [
    ["application", service.toLowerCase()],
    ["application", "chrome"],
  ]) {
    try {
      const out = execFileSync("secret-tool", ["lookup", ...attrs], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      }).trim();
      if (out) return out;
    } catch {
      // secret-tool missing or no match — try next
    }
  }
  return null;
}

function readMacKeychainPassword(browser: string): string | null {
  const service = `${safeStorageService(browser)} Safe Storage`;
  try {
    return execFileSync("security", ["find-generic-password", "-w", "-s", service], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
}

/** Locate the cookie SQLite file inside a profile, newest layout first. */
function cookieDbPath(profileDir: string): string | null {
  const candidates = [path.join(profileDir, "Network", "Cookies"), path.join(profileDir, "Cookies")];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * Read the `pld_ut` / `pld_urt` rows out of a Chromium cookie SQLite file.
 * Copies the DB to a temp path first (the live file is locked while the
 * browser runs) and opens it read-only. Exported for testing.
 */
export function readPlaudCookieRows(dbPath: string): CookieRow[] {
  const tmp = mkdtempSync(path.join(tmpdir(), "applaud-cookies-"));
  const tmpDb = path.join(tmp, "Cookies");
  try {
    cpSync(dbPath, tmpDb);
    const db = new Database(tmpDb, { readonly: true, fileMustExist: true });
    try {
      const rows = db
        .prepare(
          "SELECT host_key, name, encrypted_value, value FROM cookies " +
            "WHERE name IN ('pld_ut', 'pld_urt') " +
            // Require a domain boundary so 'evilplaud.ai' can't match.
            "AND (host_key = 'plaud.ai' OR host_key LIKE '%.plaud.ai')",
        )
        .all() as Array<{ host_key: string; name: string; encrypted_value: Buffer | null; value: string | null }>;
      return rows.map((r) => ({
        name: r.name,
        hostKey: r.host_key,
        encryptedValue: r.encrypted_value ?? Buffer.alloc(0),
        value: r.value ?? "",
      }));
    } finally {
      db.close();
    }
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function jwtIat(jwt: string): number {
  const claims = parseJwtClaims(jwt);
  return typeof claims?.iat === "number" ? claims.iat : 0;
}

function readProfileCookies(p: BrowserProfile): FirstPartyCookies | null {
  const dbPath = cookieDbPath(p.profileDir);
  if (!dbPath) return null;

  let rows: CookieRow[];
  try {
    rows = readPlaudCookieRows(dbPath);
  } catch (err) {
    logger.debug({ err, profile: p.profile }, "failed to read cookie DB");
    return null;
  }
  if (rows.length === 0) return null;

  const keys = candidateKeys(p.browser, p.userDataDir);

  const resolve = (name: string): string | null => {
    // Prefer the newest cookie when a name appears under several host_keys.
    const matches = rows.filter((r) => r.name === name);
    for (const row of matches) {
      // Unencrypted fallback (older / test data): value already holds the JWT.
      if (row.encryptedValue.length === 0 && row.value) {
        const m = row.value.match(JWT_RE);
        if (m) return m[0];
        continue;
      }
      const decrypted = decryptCbcCookie(row.encryptedValue, keys);
      if (decrypted) return decrypted;
    }
    return null;
  };

  const ut = resolve("pld_ut");
  const urt = resolve("pld_urt");
  if (!ut || !urt) return null;
  return { ut, urt, browser: p.browser, profile: p.profile };
}

/**
 * Scan every discovered Chromium-family profile for Plaud's first-party
 * session cookies. Returns the pair whose UT was issued most recently (by JWT
 * `iat`) when several profiles are logged in, or `null` when none can be read.
 */
export function findFirstPartyCookies(): FirstPartyCookies | null {
  if (platform() === "win32") {
    // Cookies are DPAPI/App-Bound encrypted on Windows; we can't decrypt them
    // off disk without native APIs. The manual paste flow covers these users.
    logger.info("first-party cookie disk-read is not supported on Windows — use manual paste");
    return null;
  }
  const profiles = discoverProfiles();
  const hits: FirstPartyCookies[] = [];
  for (const p of profiles) {
    try {
      const found = readProfileCookies(p);
      if (found) {
        logger.info({ browser: found.browser, profile: found.profile }, "found Plaud first-party cookies");
        hits.push(found);
      }
    } catch (err) {
      logger.warn({ err, profile: p.profile }, "failed to scan profile cookies");
    }
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => jwtIat(b.ut) - jwtIat(a.ut));
  return hits[0] ?? null;
}
