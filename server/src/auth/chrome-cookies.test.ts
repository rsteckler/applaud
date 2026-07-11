import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCipheriv } from "node:crypto";
import Database from "better-sqlite3";
import { deriveCbcKey, decryptCbcCookie, readPlaudCookieRows } from "./chrome-cookies.js";

const IV = Buffer.alloc(16, " ");

/** Encrypt like Chromium's Linux v10 scheme (peanuts key, optional prefix). */
function encryptV10(plaintext: Buffer | string, key: Buffer, prefix = "v10"): Buffer {
  const cipher = createCipheriv("aes-128-cbc", key, IV);
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  return Buffer.concat([Buffer.from(prefix, "latin1"), body]);
}

const JWT = "eyJhbGciOiJub25lIn0.eyJleHAiOjk5OTk5OTk5OTl9.sig";

describe("deriveCbcKey / decryptCbcCookie", () => {
  const peanuts = deriveCbcKey("peanuts", 1);

  it("round-trips a v10 (peanuts) cookie", () => {
    const enc = encryptV10(JWT, peanuts);
    expect(decryptCbcCookie(enc, [peanuts])).toBe(JWT);
  });

  it("extracts the JWT even when Chrome prepends a 32-byte domain hash", () => {
    const withHash = Buffer.concat([Buffer.alloc(32, 0xab), Buffer.from(JWT)]);
    const enc = encryptV10(withHash, peanuts);
    expect(decryptCbcCookie(enc, [peanuts])).toBe(JWT);
  });

  it("tries multiple candidate keys and picks the one that yields a JWT", () => {
    const wrong = deriveCbcKey("not-the-key", 1);
    const enc = encryptV10(JWT, peanuts);
    expect(decryptCbcCookie(enc, [wrong, peanuts])).toBe(JWT);
  });

  it("returns null when no key decrypts to a JWT", () => {
    const wrong = deriveCbcKey("nope", 1);
    const enc = encryptV10(JWT, peanuts);
    expect(decryptCbcCookie(enc, [wrong])).toBeNull();
  });

  it("returns null for a value without the v10/v11 prefix", () => {
    expect(decryptCbcCookie(Buffer.from("plaintext-no-prefix"), [peanuts])).toBeNull();
  });
});

describe("readPlaudCookieRows", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reads only pld_ut / pld_urt rows for plaud.ai hosts", () => {
    dir = mkdtempSync(path.join(tmpdir(), "cookie-test-"));
    const dbPath = path.join(dir, "Cookies");
    const db = new Database(dbPath);
    db.exec(
      "CREATE TABLE cookies (host_key TEXT, name TEXT, encrypted_value BLOB, value TEXT)",
    );
    const insert = db.prepare(
      "INSERT INTO cookies (host_key, name, encrypted_value, value) VALUES (?, ?, ?, ?)",
    );
    insert.run(".plaud.ai", "pld_ut", Buffer.from([1, 2, 3]), "");
    insert.run("plaud.ai", "pld_urt", Buffer.from([4, 5, 6]), ""); // apex host
    insert.run(".plaud.ai", "other", Buffer.from([9]), ""); // wrong name
    insert.run(".example.com", "pld_ut", Buffer.from([7]), ""); // wrong domain
    insert.run("evilplaud.ai", "pld_ut", Buffer.from([8]), ""); // lookalike domain
    db.close();

    const rows = readPlaudCookieRows(dbPath);
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(["pld_urt", "pld_ut"]);
    expect(rows.every((r) => r.hostKey.endsWith("plaud.ai") && r.hostKey !== "evilplaud.ai")).toBe(true);
    expect(rows.find((r) => r.name === "pld_ut")?.encryptedValue).toEqual(Buffer.from([1, 2, 3]));
  });
});
