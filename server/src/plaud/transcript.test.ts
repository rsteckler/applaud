import { describe, it, expect } from "vitest";
import {
  flattenTranscript,
  extractMarkdownFromSummaryPayload,
  extractSummaryMarkdown,
  type TranscriptSegment,
  type TranssummResponse,
} from "./transcript.js";

function seg(partial: Partial<TranscriptSegment>): TranscriptSegment {
  return {
    start_time: 0,
    end_time: 1000,
    content: "",
    speaker: "",
    original_speaker: "",
    ...partial,
  };
}

describe("flattenTranscript", () => {
  it("returns empty string for null", () => {
    expect(flattenTranscript(null)).toBe("");
  });

  it("returns empty string for an empty array", () => {
    expect(flattenTranscript([])).toBe("");
  });

  it("formats a single segment with mm:ss timestamp", () => {
    const out = flattenTranscript([
      seg({ start_time: 65_000, content: "Hello there.", speaker: "Alice" }),
    ]);
    expect(out).toBe("[01:05] Alice: Hello there.");
  });

  it("uses h:mm:ss format past the one-hour mark", () => {
    const out = flattenTranscript([
      seg({ start_time: 3_661_000, content: "later", speaker: "Bob" }),
    ]);
    expect(out).toBe("[1:01:01] Bob: later");
  });

  it("falls back to original_speaker when speaker is empty", () => {
    const out = flattenTranscript([
      seg({ start_time: 0, content: "hi", speaker: "", original_speaker: "Speaker 2" }),
    ]);
    expect(out).toContain("Speaker 2: hi");
  });

  it("falls back to literal 'Speaker' when both speaker fields are empty", () => {
    const out = flattenTranscript([seg({ start_time: 0, content: "hi" })]);
    expect(out).toContain("Speaker: hi");
  });

  it("joins multiple segments with a blank line between", () => {
    const out = flattenTranscript([
      seg({ start_time: 0, content: "one", speaker: "A" }),
      seg({ start_time: 5_000, content: "two", speaker: "B" }),
    ]);
    expect(out).toBe("[00:00] A: one\n\n[00:05] B: two");
  });
});

describe("extractMarkdownFromSummaryPayload", () => {
  it("returns null for null/undefined/empty", () => {
    expect(extractMarkdownFromSummaryPayload(null)).toBeNull();
    expect(extractMarkdownFromSummaryPayload(undefined)).toBeNull();
    expect(extractMarkdownFromSummaryPayload("")).toBeNull();
    expect(extractMarkdownFromSummaryPayload("   ")).toBeNull();
  });

  it("returns the input directly when it's a non-JSON markdown string", () => {
    expect(extractMarkdownFromSummaryPayload("# Heading\n\nbody")).toBe("# Heading\n\nbody");
  });

  it("returns the raw string when it starts with { but isn't valid JSON", () => {
    expect(extractMarkdownFromSummaryPayload("{not json {")).toBe("{not json {");
  });

  it("extracts ai_content (the S3 auto_sum_note shape) — first in fallback chain", () => {
    const obj = { ai_content: "## Summary\n\ngood", markdown: "should be ignored", content: "ignored" };
    expect(extractMarkdownFromSummaryPayload(obj)).toBe("## Summary\n\ngood");
  });

  it("extracts top-level `markdown` when ai_content is missing", () => {
    expect(extractMarkdownFromSummaryPayload({ markdown: "# md" })).toBe("# md");
  });

  it("extracts string `content` when markdown is missing", () => {
    expect(extractMarkdownFromSummaryPayload({ content: "just text" })).toBe("just text");
  });

  it("extracts `content.markdown` (legacy nested form)", () => {
    expect(extractMarkdownFromSummaryPayload({ content: { markdown: "# nested" } })).toBe("# nested");
  });

  it("parses a JSON-encoded string and walks the same fallback chain", () => {
    const json = JSON.stringify({ ai_content: "from string" });
    expect(extractMarkdownFromSummaryPayload(json)).toBe("from string");
  });

  it("returns null when none of the known shapes apply", () => {
    expect(extractMarkdownFromSummaryPayload({ unrelated: 42 })).toBeNull();
  });

  it("treats whitespace-only fields as missing and walks past them", () => {
    expect(
      extractMarkdownFromSummaryPayload({ ai_content: "   ", markdown: "real" }),
    ).toBe("real");
  });
});

describe("extractSummaryMarkdown — fallback chain across the response object", () => {
  function resp(partial: Partial<TranssummResponse>): TranssummResponse {
    return {
      status: 200,
      msg: "ok",
      data_result: null,
      data_result_summ: null,
      data_result_summ_mul: null,
      outline_result: null,
      ...partial,
    };
  }

  it("prefers data_result_summ when present", () => {
    const out = extractSummaryMarkdown(
      resp({ data_result_summ: { content: { markdown: "# primary" } } }),
    );
    expect(out).toBe("# primary");
  });

  it("falls back to data_result_summ_mul when data_result_summ is empty", () => {
    const out = extractSummaryMarkdown(
      resp({
        data_result_summ: null,
        data_result_summ_mul: { ai_content: "# multi" },
      }),
    );
    expect(out).toBe("# multi");
  });

  it("falls back to data_note_result when both summ fields are empty", () => {
    const out = extractSummaryMarkdown(
      resp({
        data_note_result: { markdown: "# note" },
      }),
    );
    expect(out).toBe("# note");
  });

  it("synthesizes a Topics section from outline_result as last resort", () => {
    const out = extractSummaryMarkdown(
      resp({
        outline_result: [
          { start_time: 0, end_time: 10_000, topic: "Intro" },
          { start_time: 60_000, end_time: 90_000, topic: "Decision" },
        ],
      }),
    );
    expect(out).toBe("## Topics\n\n- **00:00** — Intro\n- **01:00** — Decision");
  });

  it("returns null when nothing in the response carries a summary", () => {
    expect(extractSummaryMarkdown(resp({}))).toBeNull();
  });
});
