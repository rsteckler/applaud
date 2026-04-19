import { plaudJson } from "./client.js";
import { gunzipSync } from "node:zlib";
import type { ContentListItem } from "./detail.js";

export interface TranscriptSegment {
  start_time: number;
  end_time: number;
  content: string;
  speaker: string;
  original_speaker: string;
}

export interface OutlineItem {
  start_time: number;
  end_time: number;
  topic: string;
}

export interface SummaryContent {
  content?:
    | {
        markdown?: string;
        [k: string]: unknown;
      }
    | string;
}

/**
 * The combined transcript + summary endpoint. Despite the name, this returns
 * BOTH the transcript (data_result) and the AI summary (data_result_summ).
 *
 * `data_result_summ` is inconsistent: Plaud returns it as a JSON-encoded string
 * for normal recordings and as a structured object for very short recordings.
 * Normalize via `extractSummaryMarkdown` below.
 */
export interface TranssummResponse {
  status: number;
  msg: string;
  request_id?: string;
  data_result: TranscriptSegment[] | null;
  data_result_summ: SummaryContent | string | null;
  data_result_summ_mul: unknown;
  outline_result: OutlineItem[] | null;
  outline_task_status?: number;
  task_id_info?: unknown;
  data_source_result?: unknown;
  data_note_result?: unknown;
  download_link_map?: Record<string, string>;
  file_version?: number;
  auto_save?: unknown;
  ppc_status?: number;
  err_code?: string;
  err_msg?: string;
}

export async function getTranscriptAndSummary(id: string): Promise<TranssummResponse> {
  return plaudJson<TranssummResponse>(`/ai/transsumm/${id}`, {
    method: "POST",
    body: "{}",
  });
}

export function flattenTranscript(segments: TranscriptSegment[] | null): string {
  if (!segments || segments.length === 0) return "";
  const lines: string[] = [];
  for (const s of segments) {
    const speaker = s.speaker || s.original_speaker || "Speaker";
    const ts = formatTimestamp(s.start_time);
    lines.push(`[${ts}] ${speaker}: ${s.content}`);
  }
  return lines.join("\n\n");
}

function formatTimestamp(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Fetch transcript segments from the S3 `data_link` in the file detail
 * `content_list`. Older recordings store transcripts here instead of the
 * transsumm endpoint.
 */
export async function fetchTranscriptFromContentList(
  contentList: ContentListItem[],
): Promise<{ segments: TranscriptSegment[]; summaryMd: string | null }> {
  const transItem = contentList.find((c) => c.data_type === "transaction" && c.data_link);
  const summItem = contentList.find((c) => c.data_type === "auto_sum_note" && c.data_link);

  let segments: TranscriptSegment[] = [];
  if (transItem?.data_link) {
    const res = await fetch(transItem.data_link);
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      let text: string;
      // Some links are gzipped, some aren't — try gunzip, fall back to raw
      try {
        text = gunzipSync(buf).toString("utf8");
      } catch {
        text = buf.toString("utf8");
      }
      const parsed = JSON.parse(text) as TranscriptSegment[] | Record<string, TranscriptSegment>;
      const arr = Array.isArray(parsed) ? parsed : Object.values(parsed);
      segments = arr as TranscriptSegment[];
    }
  }

  let summaryMd: string | null = null;
  if (summItem?.data_link) {
    const res = await fetch(summItem.data_link);
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      let raw: string;
      try {
        raw = gunzipSync(buf).toString("utf8");
      } catch {
        raw = buf.toString("utf8");
      }
      summaryMd = extractMarkdownFromSummaryPayload(raw);
    }
  }

  return { segments, summaryMd };
}

export function extractSummaryMarkdown(resp: TranssummResponse): string | null {
  const raw = resp.data_result_summ;
  if (raw === null || raw === undefined) return null;
  return extractMarkdownFromSummaryPayload(raw);
}

// Plaud returns summary payloads in several shapes across its endpoints and
// across recordings of different ages. Known shapes:
//   - Raw markdown string
//   - JSON object / JSON-encoded string with one of:
//       { markdown: "..." }                    (top-level markdown)
//       { ai_content: "...", header, ... }    (S3 auto_sum_note blobs)
//       { content: "..." }                     (legacy string form)
//       { content: { markdown: "..." } }       (legacy nested form)
// Returns the markdown string, or null if nothing usable was found.
function extractMarkdownFromSummaryPayload(input: unknown): string | null {
  let obj: unknown = input;
  if (typeof obj === "string") {
    const s = obj.trim();
    if (s.length === 0) return null;
    // Try to parse as JSON; if it fails the raw string IS the markdown.
    if (s.startsWith("{") || s.startsWith("[")) {
      try {
        obj = JSON.parse(s);
      } catch {
        return s;
      }
    } else {
      return s;
    }
  }

  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;

  const aiContent = rec.ai_content;
  if (typeof aiContent === "string" && aiContent.trim().length > 0) return aiContent;

  const topMd = rec.markdown;
  if (typeof topMd === "string" && topMd.trim().length > 0) return topMd;

  const content = rec.content;
  if (typeof content === "string") {
    return content.trim().length > 0 ? content : null;
  }
  if (content && typeof content === "object") {
    const md = (content as Record<string, unknown>).markdown;
    if (typeof md === "string" && md.trim().length > 0) return md;
  }
  return null;
}
