import { describe, it, expect } from "vitest";
import { sanitizeFilename, dateStamp, folderName } from "./layout.js";

describe("sanitizeFilename", () => {
  it.each([
    ["a/b", "a_b"],
    ["a\\b", "a_b"],
    ["a:b", "a_b"],
    ["a*b", "a_b"],
    ["a?b", "a_b"],
    ['a"b', "a_b"],
    ["a<b", "a_b"],
    ["a>b", "a_b"],
    ["a|b", "a_b"],
    ["a\nb", "a_b"],
    ["a\rb", "a_b"],
    ["a\tb", "a_b"],
  ])("replaces unsafe char in %j → %j", (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
  });

  it("collapses multiple unsafe chars in a row to a single underscore", () => {
    expect(sanitizeFilename("a///b")).toBe("a_b");
  });

  it("collapses runs of whitespace to a single space then converts to underscore", () => {
    expect(sanitizeFilename("a   b")).toBe("a_b");
  });

  it("strips leading and trailing dots and underscores", () => {
    expect(sanitizeFilename("...name...")).toBe("name");
    expect(sanitizeFilename("___name___")).toBe("name");
    expect(sanitizeFilename("._name_.")).toBe("name");
  });

  it("caps the result at 100 characters", () => {
    const long = "a".repeat(500);
    expect(sanitizeFilename(long)).toHaveLength(100);
  });

  it("preserves Unicode (non-ASCII letters are NOT in the unsafe set)", () => {
    // Latin extended, CJK, emoji
    expect(sanitizeFilename("café")).toBe("café");
    expect(sanitizeFilename("会议记录")).toBe("会议记录");
    expect(sanitizeFilename("meeting 🎙")).toBe("meeting_🎙");
  });

  it.each([
    ["", ""],
    ["//:", ""],
    ["...", ""],
    ["___", ""],
  ])(
    "returns empty string for input that sanitizes to nothing: %j",
    (input, expected) => {
      expect(sanitizeFilename(input)).toBe(expected);
    },
  );

  it("two filenames differing only in unsafe chars produce different sanitized output when there's other content", () => {
    // "foo bar" vs "foo/bar" — both become "foo_bar"; this is acceptable collapse,
    // but adding any distinguishing safe char preserves the difference.
    expect(sanitizeFilename("foo:bar")).toBe(sanitizeFilename("foo|bar"));
    // The id suffix in folderName is what makes the FULL folder name unique;
    // sanitizeFilename does NOT promise distinct outputs for distinct inputs.
  });
});

describe("dateStamp", () => {
  it("formats UTC date as YYYY-MM-DD", () => {
    // 2026-04-11 19:34:01 UTC
    expect(dateStamp(Date.UTC(2026, 3, 11, 19, 34, 1))).toBe("2026-04-11");
  });

  it("uses UTC, not local time (test runs in any timezone)", () => {
    // 2026-04-11 23:30 UTC — local time may roll over to the 12th in eastern TZs
    expect(dateStamp(Date.UTC(2026, 3, 11, 23, 30))).toBe("2026-04-11");
  });

  it("zero-pads single-digit months and days", () => {
    expect(dateStamp(Date.UTC(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("folderName", () => {
  it("composes date + sanitized filename + 8-char id", () => {
    const out = folderName(
      Date.UTC(2026, 3, 11, 12, 0),
      "Team standup",
      "abcdef0123456789feedfacecafebabe",
    );
    expect(out).toBe("2026-04-11_Team_standup__abcdef01");
  });

  it("falls back to 'recording' when filename sanitizes to empty", () => {
    const out = folderName(Date.UTC(2026, 3, 11), "...", "abcdef01zzzzzzzz");
    expect(out).toBe("2026-04-11_recording__abcdef01");
  });

  it("two recordings with the SAME filename + date + different id produce different folders", () => {
    const a = folderName(Date.UTC(2026, 3, 11), "Standup", "id-aaaaa-rest");
    const b = folderName(Date.UTC(2026, 3, 11), "Standup", "id-bbbbb-rest");
    expect(a).not.toBe(b);
  });

  it("two recordings with the same id prefix collide (known limitation — short id)", () => {
    // Documented behavior: only first 8 chars of id are used. If two ids share
    // the first 8 chars, the folders collide. This is a known tradeoff.
    const a = folderName(Date.UTC(2026, 3, 11), "Standup", "abcdef01-different-tail");
    const b = folderName(Date.UTC(2026, 3, 11), "Standup", "abcdef01-yet-another");
    expect(a).toBe(b);
  });
});
