import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClassicLevel } from "classic-level";
import { logger } from "../logger.js";
import { discoverProfiles, type BrowserProfile } from "./profiles.js";
import { parseJwtClaims } from "./jwt.js";

const ORIGIN_PREFIX = Buffer.concat([
  Buffer.from("_https://web.plaud.ai"),
  Buffer.from([0x00, 0x01]),
]);

const TOKENSTR_KEY = Buffer.concat([ORIGIN_PREFIX, Buffer.from("tokenstr")]);

export interface FoundToken {
  token: string;
  browser: string;
  profile: string;
  email: string | null;
  iat: number | null;
  exp: number | null;
}

/**
 * Decode a Chrome LevelDB localStorage value. First byte is an encoding marker:
 *   0x00 = UTF-16LE, 0x01 = Latin-1. Strip and decode.
 */
function decodeValue(buf: Buffer): string {
  if (buf.length === 0) return "";
  const marker = buf[0];
  const body = buf.subarray(1);
  if (marker === 0x00) return body.toString("utf16le");
  if (marker === 0x01) return body.toString("latin1");
  return buf.toString("utf8");
}

function tokenTimestamps(jwt: string): { iat: number | null; exp: number | null } {
  const claims = parseJwtClaims(jwt);
  return {
    iat: typeof claims?.iat === "number" ? claims.iat : null,
    exp: typeof claims?.exp === "number" ? claims.exp : null,
  };
}

function copyProfileToTemp(srcLeveldb: string): string {
  const tmp = mkdtempSync(path.join(tmpdir(), "applaud-ldb-"));
  cpSync(srcLeveldb, tmp, {
    recursive: true,
    // Chrome holds an exclusive lock on LOCK while running. Skip it; readers don't need it.
    filter: (s) => !s.endsWith(`${path.sep}LOCK`) && !s.endsWith("/LOCK"),
  });
  return tmp;
}

async function scanProfile(p: BrowserProfile): Promise<FoundToken | null> {
  const tmp = copyProfileToTemp(p.leveldbPath);
  try {
    const db = new ClassicLevel<Buffer, Buffer>(tmp, {
      keyEncoding: "buffer",
      valueEncoding: "buffer",
    });
    try {
      await db.open({ passive: false, createIfMissing: false, errorIfExists: false });
    } catch (err) {
      logger.debug({ err, path: tmp }, "failed to open LevelDB copy");
      return null;
    }
    try {
      let token: string | null = null;
      let email: string | null = null;

      // 1. Try the canonical `tokenstr` key directly (fast path).
      try {
        const raw = await db.get(TOKENSTR_KEY);
        if (raw) {
          const decoded = decodeValue(raw).trim();
          // Value is typically `bearer eyJ...`. Strip the prefix.
          const withoutBearer = decoded.replace(/^bearer\s+/i, "").trim();
          if (withoutBearer.startsWith("eyJ")) {
            token = withoutBearer;
          }
        }
      } catch {
        // key not found — fall through to iterator scan
      }

      // 2. Iterate the origin's keys to find the email and fall back to the PLADU_bearer trick.
      const upper = Buffer.concat([ORIGIN_PREFIX, Buffer.from([0xff])]);
      for await (const [k] of db.iterator({ gte: ORIGIN_PREFIX, lt: upper })) {
        const keyStr = k.toString("latin1");
        if (!email) {
          const emailMatch = keyStr.match(/PLADU_([^_\s]+@[^_\s]+)_/);
          if (emailMatch) email = emailMatch[1] ?? null;
        }
        if (!token) {
          // Key-name trick: `PLADU_<uid>_bearer eyJ...<sig>_welcomeFileShown`
          const m = keyStr.match(
            /bearer (eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/,
          );
          if (m && m[1]) token = m[1];
        }
      }

      if (!token) return null;
      const { iat, exp } = tokenTimestamps(token);
      return { token, browser: p.browser, profile: p.profile, email, iat, exp };
    } finally {
      try {
        await db.close();
      } catch {
        /* ignore */
      }
    }
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Scan every discovered Chromium-family profile on this machine for a Plaud
 * bearer token. Returns the newest (by JWT `iat`) token if multiple are found.
 */
export async function findToken(): Promise<FoundToken | null> {
  const profiles = discoverProfiles();
  if (profiles.length === 0) {
    logger.info("no Chromium-family browser profiles found");
    return null;
  }
  const results: FoundToken[] = [];
  for (const p of profiles) {
    try {
      const hit = await scanProfile(p);
      if (hit) {
        logger.info(
          { browser: hit.browser, profile: hit.profile, email: hit.email },
          "found Plaud session",
        );
        results.push(hit);
      }
    } catch (err) {
      logger.warn({ err, profile: p }, "failed to scan profile");
    }
  }
  if (results.length === 0) return null;
  results.sort((a, b) => (b.iat ?? 0) - (a.iat ?? 0));
  return results[0] ?? null;
}
