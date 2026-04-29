import { describe, it, expect } from "vitest";
import { sanitizePlaudSummaryMarkdown } from "./summarySanitize.js";

describe("sanitizePlaudSummaryMarkdown", () => {
  describe("img / image-link stripping", () => {
    it("removes raw <img> tags", () => {
      const out = sanitizePlaudSummaryMarkdown('before <img src="x"> after');
      expect(out).toBe("before  after");
    });

    it("removes <img> with attributes spanning multiple chars", () => {
      const out = sanitizePlaudSummaryMarkdown(
        '<img alt="a" src="https://x.png" class="logo" /> body',
      );
      expect(out).toBe(" body");
    });

    it("converts markdown image with alt text to bold", () => {
      const out = sanitizePlaudSummaryMarkdown("![Plaud Logo](https://example.com/logo.png)");
      expect(out).toBe("**Plaud Logo**");
    });

    it("drops markdown image entirely when alt text is empty", () => {
      const out = sanitizePlaudSummaryMarkdown("text ![](https://example.com/x.png) more");
      expect(out).toBe("text  more");
    });

    it("leaves regular markdown links alone (only image links are touched)", () => {
      const out = sanitizePlaudSummaryMarkdown("see [docs](https://example.com) for details");
      expect(out).toBe("see [docs](https://example.com) for details");
    });
  });

  describe("$[…] template variables", () => {
    it("substitutes $[audio_start_time] when startTimeMs is provided", () => {
      const ms = Date.UTC(2026, 3, 28, 14, 0); // 2026-04-28 14:00 UTC
      const out = sanitizePlaudSummaryMarkdown("Meeting on $[audio_start_time]", {
        startTimeMs: ms,
      });
      // Locale-formatted; we only assert the placeholder is replaced and the
      // year survives. Different runners may format hour differently.
      expect(out).not.toContain("$[audio_start_time]");
      expect(out).toContain("2026");
    });

    it("substitutes $[audio_end_time] when endTimeMs is provided", () => {
      const ms = Date.UTC(2026, 3, 28, 14, 0);
      const out = sanitizePlaudSummaryMarkdown("ended $[audio_end_time]", { endTimeMs: ms });
      expect(out).not.toContain("$[audio_end_time]");
    });

    it("replaces unknown $[…] vars with em dash", () => {
      const out = sanitizePlaudSummaryMarkdown("Topic: $[foo_bar] here");
      expect(out).toBe("Topic: — here");
    });

    it("leaves $[audio_start_time] as em dash when no opts are provided", () => {
      const out = sanitizePlaudSummaryMarkdown("at $[audio_start_time]");
      expect(out).toBe("at —");
    });

    it("$[audio_start_time] match is case-insensitive", () => {
      const ms = Date.UTC(2026, 3, 28);
      const out = sanitizePlaudSummaryMarkdown("$[Audio_Start_Time]", { startTimeMs: ms });
      expect(out).not.toContain("$[Audio_Start_Time]");
    });
  });

  describe("[Insert …] placeholders", () => {
    it("replaces a typical [Insert ...] placeholder", () => {
      const out = sanitizePlaudSummaryMarkdown("Summary: [Insert summary here]");
      expect(out).toBe("Summary: —");
    });

    it("matches case-insensitively", () => {
      const out = sanitizePlaudSummaryMarkdown("[INSERT name] joined");
      expect(out).toBe("— joined");
    });

    it("does not match a regular markdown link [text](url)", () => {
      const out = sanitizePlaudSummaryMarkdown("[Insert link]: see [docs](https://x)");
      expect(out).toBe("—: see [docs](https://x)");
    });
  });

  describe("whitespace + trim", () => {
    it("collapses 3+ consecutive newlines to two", () => {
      const out = sanitizePlaudSummaryMarkdown("a\n\n\n\nb");
      expect(out).toBe("a\n\nb");
    });

    it("preserves a single double-newline (paragraph break)", () => {
      const out = sanitizePlaudSummaryMarkdown("a\n\nb");
      expect(out).toBe("a\n\nb");
    });

    it("trims trailing whitespace + newlines", () => {
      const out = sanitizePlaudSummaryMarkdown("a\n\n\n");
      expect(out).toBe("a");
    });
  });

  describe("realistic combined fixtures", () => {
    it("normalizes a full Plaud-style summary in one pass", () => {
      const input = [
        "![Plaud Note](https://web.plaud.ai/icon.png)",
        "",
        "# Meeting Summary",
        "",
        "Date: $[audio_start_time]",
        "",
        "Attendees: [Insert attendees]",
        "",
        "<img src='https://web.plaud.ai/sig.svg' />",
        "",
        "",
        "",
        "End: $[audio_end_time]",
      ].join("\n");
      const out = sanitizePlaudSummaryMarkdown(input, {
        startTimeMs: Date.UTC(2026, 3, 28, 9, 0),
        endTimeMs: Date.UTC(2026, 3, 28, 10, 0),
      });
      expect(out).toContain("**Plaud Note**");
      expect(out).toContain("# Meeting Summary");
      expect(out).toContain("Attendees: —");
      expect(out).not.toContain("<img");
      expect(out).not.toContain("$[audio_start_time]");
      expect(out).not.toContain("$[audio_end_time]");
      expect(out).not.toContain("[Insert");
      expect(out).not.toMatch(/\n{3,}/);
    });

    it("returns input unchanged when no patterns match", () => {
      const md = "# Title\n\nA simple paragraph.\n";
      const out = sanitizePlaudSummaryMarkdown(md);
      expect(out).toBe("# Title\n\nA simple paragraph.");
    });
  });
});
