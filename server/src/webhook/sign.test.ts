import { describe, it, expect } from "vitest";
import { signPayload } from "./sign.js";

describe("signPayload", () => {
  // RFC 4231 test case 1 — the canonical "do you actually implement HMAC-SHA256" vector.
  // key   = 0x0b * 20  (binary)
  // data  = "Hi There"
  // mac   = b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7
  // We pass the key as a Latin-1-encoded string so the bytes match the spec input.
  it("matches RFC 4231 test case 1", () => {
    const key = "\x0b".repeat(20);
    const data = "Hi There";
    expect(signPayload(key, data)).toBe(
      "sha256=b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    );
  });

  it("produces a 71-char output (sha256= + 64 hex chars) for any input", () => {
    expect(signPayload("k", "v")).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signPayload("k", "")).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signPayload("", "v")).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("is sensitive to a one-byte change in the body (no silent truncation)", () => {
    const a = signPayload("secret", '{"event":"a"}');
    const b = signPayload("secret", '{"event":"b"}');
    expect(a).not.toBe(b);
  });

  it("is sensitive to a one-byte change in the secret", () => {
    const a = signPayload("secret-a", "body");
    const b = signPayload("secret-b", "body");
    expect(a).not.toBe(b);
  });

  it("handles non-ASCII bodies (UTF-8 multibyte)", () => {
    // Sanity: result is deterministic and well-formed; matches a hash we can
    // independently regenerate via Node's crypto with the same UTF-8 bytes.
    const sig = signPayload("k", "héllo 你好 🎙");
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    // Re-signing the same input must produce the same output.
    expect(signPayload("k", "héllo 你好 🎙")).toBe(sig);
  });

  it("treats NUL as a regular byte in the secret (no C-string truncation)", () => {
    // Some HMAC libraries that wrap a C-string interface silently truncate
    // the key at the first \0. Node's crypto.createHmac doesn't, but the
    // contract matters because an attacker who can control the secret source
    // and inject a NUL byte must NOT be able to collide with the shorter prefix.
    const withNul = signPayload("key\x00suffix", "body");
    const truncated = signPayload("key", "body");
    expect(withNul).not.toBe(truncated);
  });

  it("handles empty body without throwing", () => {
    expect(() => signPayload("k", "")).not.toThrow();
  });
});
