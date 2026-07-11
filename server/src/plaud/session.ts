// First-party Plaud session helpers — refresh, list, mint. Pure I/O against
// the Plaud API with NO config/DB access: callers pass the tokens in and
// persist whatever these return. Ported from rovenotes-cloud's
// `first-party-session.ts` (the RoveNotes Connector's server side), which is
// the reference implementation of Plaud's newer cookie-based auth model.
//
// Plaud's model has three tokens:
//   - UT  (`pld_ut`,  ~1 day)   — bearer for listing workspaces + minting WTs.
//   - URT (`pld_urt`, ~30 days) — refreshes the UT when it goes stale.
//   - WT  (workspace token)     — bearer for the actual REST API (list/audio/
//                                 transcript). Minted from the UT per workspace.
//
// Two load-bearing gotchas, both unit-tested:
//   1. Multi-Set-Cookie parsing. Plaud sets `pld_ut`/`pld_urt` several times
//      per response — `Max-Age=0` clearers FIRST, the real token LAST. Take
//      the last non-empty, non-cleared value.
//   2. Region `-302` redirects. Plaud may answer with
//      `{ status: -302, data: { domains: { api } } }`. Follow it once through
//      the known-region allowlist and return the resolved region.

import { logger } from "../logger.js";
import { parseJwtClaims } from "../auth/jwt.js";
import { apiBaseForRegion, parseRegionRedirect } from "./client.js";

// Default region key used when a call succeeds without a `-302` follow and the
// caller supplied no starting region. Matches Plaud's default (api.plaud.ai).
const DEFAULT_REGION = "aws:us-west-2";

// Present as a current desktop Chrome so Plaud sees browser-shaped traffic
// rather than a bot-flagged custom UA (same rationale as client.ts).
const PLAUD_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/** Refresh a UT this close to (or past) its expiry before using it. */
export const UT_REFRESH_SKEW_MS = 5 * 60 * 1000;
/** Re-mint a WT this close to (or past) its expiry before using it. */
export const WT_REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * Outcome of a cookie read or refresh: the UT/URT plus their expiries and the
 * resolved region (after any `-302` follow) so the caller persists where this
 * session actually lives.
 */
export interface SessionTokens {
  ut: string;
  utExp: number | null; // seconds since epoch
  urt: string;
  urtExp: number | null; // seconds since epoch
  /** Plaud's `sid` claim from the UT — marks this as our own session. */
  sid: string | null;
  region: string;
}

export interface WorkspaceSummary {
  workspace_id: string;
  /** "0" = personal; anything else is a team / shared workspace. */
  workspace_type: string;
  workspace_name?: string;
}

export type MintFailureKind =
  | "user_token_rejected"
  | "stale"
  | "transient"
  | "rejected";

export class PlaudMintError extends Error {
  constructor(
    public readonly kind: MintFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "PlaudMintError";
  }
}

export class PlaudRelayError extends Error {
  constructor(
    public readonly kind: "rejected" | "transient" | "region_unknown",
    message: string,
  ) {
    super(message);
    this.name = "PlaudRelayError";
  }
}

// ---------------------------------------------------------------------
// Set-Cookie helper (load-bearing — read the comment, then read it again)
// ---------------------------------------------------------------------

/**
 * Pull the latest value of a named cookie out of a `Set-Cookie` list. Plaud
 * emits several `Set-Cookie` headers per response: a `Max-Age=0` clearer FIRST
 * and the real token LAST. `headers.get` would join them into a single
 * comma-separated string that isn't safely splittable, so we rely on
 * `headers.getSetCookie()` (Node 19+/undici) which returns the raw array.
 *
 * Returns `null` if no non-empty, non-cleared value for `name` is present.
 */
export function pickLatestSetCookie(headers: Headers, name: string): string | null {
  const all = headers.getSetCookie();
  let latest: string | null = null;
  for (const raw of all) {
    const parsed = parseSetCookie(raw);
    if (!parsed) continue;
    if (parsed.name !== name) continue;
    if (parsed.value === "") continue;
    if (parsed.cleared) continue;
    // Last write wins — keep scanning so the final non-empty entry is returned.
    latest = parsed.value;
  }
  return latest;
}

interface ParsedCookie {
  name: string;
  value: string;
  cleared: boolean;
}

function parseSetCookie(raw: string): ParsedCookie | null {
  const semi = raw.indexOf(";");
  const head = semi === -1 ? raw : raw.slice(0, semi);
  const eq = head.indexOf("=");
  if (eq === -1) return null;
  const name = head.slice(0, eq).trim();
  const value = head.slice(eq + 1).trim();
  if (!name) return null;

  let cleared = false;
  const attrs = semi === -1 ? "" : raw.slice(semi + 1);
  for (const attr of attrs.split(";")) {
    const a = attr.trim().toLowerCase();
    if (a === "max-age=0" || a === "max-age=-1") {
      cleared = true;
      break;
    }
    if (a.startsWith("expires=")) {
      if (a.includes("1970")) {
        cleared = true;
        break;
      }
    }
  }
  return { name, value, cleared };
}

// ---------------------------------------------------------------------
// JWT claim helpers
// ---------------------------------------------------------------------

function jwtExp(jwt: string): number | null {
  const claims = parseJwtClaims(jwt);
  return typeof claims?.exp === "number" ? claims.exp : null;
}

function jwtRegion(jwt: string): string | null {
  const claims = parseJwtClaims(jwt);
  return typeof claims?.region === "string" ? claims.region : null;
}

function extractSid(jwt: string): string | null {
  const claims = parseJwtClaims(jwt) as { sid?: unknown; ut_sid?: unknown } | null;
  if (!claims) return null;
  if (typeof claims.sid === "string") return claims.sid;
  if (typeof claims.ut_sid === "string") return claims.ut_sid;
  return null;
}

/**
 * True when a JWT-derived expiry (seconds since epoch, or null) is within
 * `skewMs` of now, already past, or unknown. A missing expiry is treated as
 * "refresh now" rather than trusting an un-dated token.
 */
export function isExpiryWithinSkew(expSeconds: number | null, skewMs: number): boolean {
  if (!expSeconds) return true;
  return expSeconds * 1000 - Date.now() <= skewMs;
}

// ---------------------------------------------------------------------
// Single Plaud call + region follow
// ---------------------------------------------------------------------

interface RawAttempt {
  ok: true;
  httpStatus: number;
  body: unknown;
  rawText: string;
  region: string | null;
  response: Response;
}

type AttemptFailure =
  | { ok: false; kind: "transient"; reason: string; region: string | null }
  | { ok: false; kind: "unauthorized"; reason: string; region: string | null }
  | { ok: false; kind: "rejected"; reason: string; region: string | null };

interface DoFetchOpts {
  method: "GET" | "POST";
  path: string;
  region: string | null;
  bearer?: string;
  cookie?: string;
  body?: BodyInit | null;
  contentType?: string;
}

/**
 * Single Plaud call. Reads the body once and classifies HTTP-level failures
 * (transient vs unauthorized vs rejected). Region `-302` is NOT followed here;
 * callers thread it through `followRegion()`.
 */
async function doFetch(opts: DoFetchOpts): Promise<RawAttempt | AttemptFailure> {
  const base = apiBaseForRegion(opts.region);
  const url = `${base}${opts.path}`;
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": PLAUD_USER_AGENT,
  };
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.contentType) headers["content-type"] = opts.contentType;

  let res: Response;
  try {
    res = await fetch(url, { method: opts.method, headers, body: opts.body });
  } catch (err) {
    return {
      ok: false,
      kind: "transient",
      reason: `network error: ${err instanceof Error ? err.message : String(err)}`,
      region: opts.region,
    };
  }

  const rawText = await res.text().catch(() => "");

  if (res.status === 401) {
    return { ok: false, kind: "unauthorized", reason: "Plaud returned 401", region: opts.region };
  }
  if (res.status >= 500) {
    return { ok: false, kind: "transient", reason: `HTTP ${res.status}`, region: opts.region };
  }

  let body: unknown = null;
  if (rawText.length > 0) {
    try {
      body = JSON.parse(rawText);
    } catch {
      return {
        ok: false,
        kind: "transient",
        reason: `${res.ok ? "" : `HTTP ${res.status} `}non-JSON response; body=${rawText.slice(0, 200)}`,
        region: opts.region,
      };
    }
  }

  if (!res.ok) {
    // 4xx other than 401 — classify as rejected. Mint-side callers reinterpret
    // this as `stale`; refresh callers surface it directly.
    return {
      ok: false,
      kind: "rejected",
      reason: `HTTP ${res.status}; body=${rawText.slice(0, 200)}`,
      region: opts.region,
    };
  }

  return { ok: true, httpStatus: res.status, body, rawText, region: opts.region, response: res };
}

function detectRegionMismatch(
  body: unknown,
): { ok: true; correctRegion: string } | { ok: false; reason: string } | null {
  const redirect = parseRegionRedirect(body);
  if (redirect === null) return null;
  if (redirect.ok) return { ok: true, correctRegion: redirect.region };
  return {
    ok: false,
    reason: redirect.apiBase
      ? `region mismatch points at unknown endpoint ${redirect.apiBase}`
      : "region mismatch without a target domain",
  };
}

/**
 * Run `attempt(region)`, and if Plaud answers with `-302` follow exactly once
 * against the corrected region. Unknown target domains are rejected via the
 * allowlist. A second `-302` is surfaced as transient so the next cycle retries.
 */
async function followRegion(
  startRegion: string | null,
  attempt: (region: string | null) => Promise<RawAttempt | AttemptFailure>,
): Promise<RawAttempt | AttemptFailure> {
  const first = await attempt(startRegion);
  if (!first.ok) return first;
  const mismatch = detectRegionMismatch(first.body);
  if (mismatch === null) return first;
  if (!mismatch.ok) {
    return { ok: false, kind: "rejected", reason: mismatch.reason, region: first.region };
  }
  logger.info(
    { previousRegion: startRegion, correctRegion: mismatch.correctRegion },
    "Plaud first-party session: region mismatch — retrying against corrected endpoint",
  );
  const second = await attempt(mismatch.correctRegion);
  if (!second.ok) return second;
  const chained = detectRegionMismatch(second.body);
  if (chained !== null) {
    return { ok: false, kind: "transient", reason: "chained region mismatch after retry", region: second.region };
  }
  return second;
}

function extractSessionFromResponse(
  attempt: RawAttempt,
  fallbackUt?: string,
  fallbackUrt?: string,
): SessionTokens | null {
  const ut = pickLatestSetCookie(attempt.response.headers, "pld_ut") ?? fallbackUt ?? null;
  const urt = pickLatestSetCookie(attempt.response.headers, "pld_urt") ?? fallbackUrt ?? null;
  if (!ut || !urt) return null;
  return sessionFromCookies({ ut, urt, region: attempt.region ?? undefined });
}

/**
 * Build a `SessionTokens` from raw `pld_ut`/`pld_urt` JWTs lifted straight from
 * the browser's cookie jar. No Plaud network call — the caller hands valid
 * tokens in. Region preference: explicit arg, then the UT's `region` claim,
 * then `DEFAULT_REGION`.
 */
export function sessionFromCookies(opts: { ut: string; urt: string; region?: string }): SessionTokens {
  return {
    ut: opts.ut,
    utExp: jwtExp(opts.ut),
    urt: opts.urt,
    urtExp: jwtExp(opts.urt),
    sid: extractSid(opts.ut),
    region: opts.region ?? jwtRegion(opts.ut) ?? DEFAULT_REGION,
  };
}

function failureToRelayError(failure: AttemptFailure): PlaudRelayError {
  // Refresh callers don't distinguish 401 from any other rejection — both mean
  // the URT is dead. Mint keeps 401 separate as `user_token_rejected`.
  const kind = failure.kind === "transient" ? "transient" : "rejected";
  return new PlaudRelayError(kind, failure.reason);
}

function classifyEnvelope(body: unknown, rawText: string): { ok: true } | PlaudRelayError {
  if (typeof body !== "object" || body === null) {
    return new PlaudRelayError("rejected", `Plaud returned non-envelope body; raw=${rawText.slice(0, 200)}`);
  }
  const b = body as { status?: unknown; msg?: unknown };
  if (b.status === 0) return { ok: true };
  if (b.status === -302) {
    return new PlaudRelayError("transient", `Plaud envelope status=-302 after region follow; raw=${rawText.slice(0, 200)}`);
  }
  const status = typeof b.status === "number" ? b.status : "unknown";
  const msg = typeof b.msg === "string" ? b.msg : "";
  return new PlaudRelayError("rejected", `Plaud envelope status=${status}${msg ? ` msg=${msg}` : ""}; raw=${rawText.slice(0, 200)}`);
}

// ---------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------

/**
 * Self-refresh the first-party session via `POST /auth/refresh-user-token`.
 * Plaud rotates the URT near expiry; the caller MUST persist both returned
 * tokens. The cookie header carries the current UT and URT.
 */
export async function refreshUserToken(urt: string, ut: string, region: string): Promise<SessionTokens> {
  const cookie = `pld_ut=${ut}; pld_urt=${urt}`;
  const result = await followRegion(region, (r) =>
    doFetch({
      method: "POST",
      path: "/auth/refresh-user-token",
      region: r,
      cookie,
      contentType: "application/json",
      body: JSON.stringify({}),
    }),
  );
  if (!result.ok) throw failureToRelayError(result);
  const verdict = classifyEnvelope(result.body, result.rawText);
  if (verdict instanceof PlaudRelayError) throw verdict;
  // Response sets fresh pld_ut + (rotated) pld_urt. If only one is set, fall
  // back to the value we already hold — Plaud's behavior here is erratic.
  const session = extractSessionFromResponse(result, ut, urt);
  if (!session) {
    throw new PlaudRelayError("rejected", "Plaud refresh returned 200 but no usable pld_ut / pld_urt cookies");
  }
  return session;
}

// ---------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------

/** List the user's workspaces via the team-app endpoint. */
export async function listWorkspaces(
  ut: string,
  region: string,
): Promise<{ workspaces: WorkspaceSummary[]; region: string }> {
  const result = await followRegion(region, (r) =>
    doFetch({
      method: "GET",
      path: "/team-app/workspaces/list?need_personal_workspace=true",
      region: r,
      bearer: ut,
    }),
  );
  if (!result.ok) throw failureToRelayError(result);
  const verdict = classifyEnvelope(result.body, result.rawText);
  if (verdict instanceof PlaudRelayError) throw verdict;
  const data = (result.body as { data?: { workspaces?: unknown } } | null)?.data;
  const list = Array.isArray(data?.workspaces) ? data.workspaces : [];
  const workspaces: WorkspaceSummary[] = list
    .filter((w): w is Record<string, unknown> => typeof w === "object" && w !== null)
    .map((w) => ({
      workspace_id: String(w.workspace_id ?? ""),
      workspace_type: String(w.workspace_type ?? ""),
      workspace_name: typeof w.workspace_name === "string" ? w.workspace_name : undefined,
    }))
    .filter((w) => w.workspace_id !== "");
  return { workspaces, region: result.region ?? DEFAULT_REGION };
}

/**
 * Pick the personal workspace (`workspace_type === "0"`), falling back to the
 * first listed workspace. Returns `null` for an empty list.
 */
export function pickPersonalWorkspaceId(workspaces: WorkspaceSummary[]): string | null {
  const personal = workspaces.find((w) => w.workspace_type === "0");
  return personal?.workspace_id ?? workspaces[0]?.workspace_id ?? null;
}

// ---------------------------------------------------------------------
// Mint
// ---------------------------------------------------------------------

/**
 * Mint a workspace token from the UT via
 * `POST /user-app/auth/workspace/token/{workspaceId}`. Failure classification:
 *   - `user_token_rejected` (401) — the UT is dead. Tear down; do NOT retry.
 *   - `stale` (other 4xx or non-zero envelope) — workspace id stale; relist + re-mint.
 *   - `transient` (5xx / network) — retry next cycle.
 */
export async function mintWorkspaceToken(
  ut: string,
  workspaceId: string,
  region: string,
): Promise<{ workspaceToken: string; region: string }> {
  const result = await followRegion(region, (r) =>
    doFetch({
      method: "POST",
      path: `/user-app/auth/workspace/token/${encodeURIComponent(workspaceId)}`,
      region: r,
      bearer: ut,
      contentType: "application/json",
      body: JSON.stringify({}),
    }),
  );
  if (!result.ok) {
    if (result.kind === "unauthorized") {
      throw new PlaudMintError("user_token_rejected", result.reason);
    }
    if (result.kind === "rejected") {
      throw new PlaudMintError("stale", result.reason);
    }
    throw new PlaudMintError("transient", result.reason);
  }
  if (typeof result.body !== "object" || result.body === null) {
    throw new PlaudMintError("transient", `Plaud mint returned non-envelope body; raw=${result.rawText.slice(0, 200)}`);
  }
  const b = result.body as { status?: unknown; msg?: unknown; data?: { workspace_token?: unknown } };
  if (b.status !== 0) {
    const status = typeof b.status === "number" ? b.status : "unknown";
    const msg = typeof b.msg === "string" ? b.msg : "";
    throw new PlaudMintError("stale", `Plaud envelope status=${status}${msg ? ` msg=${msg}` : ""}; raw=${result.rawText.slice(0, 200)}`);
  }
  const workspaceToken = typeof b.data?.workspace_token === "string" ? b.data.workspace_token : null;
  if (!workspaceToken) {
    throw new PlaudMintError("stale", `Plaud mint envelope status=0 but missing data.workspace_token; raw=${result.rawText.slice(0, 200)}`);
  }
  return { workspaceToken, region: result.region ?? DEFAULT_REGION };
}
