// First-party Plaud session bootstrap + keep-alive for Applaud.
//
// The session helpers in `session.ts` are pure Plaud I/O; this module is the
// Applaud-flavoured orchestration around them — it reads/writes `settings.json`
// (via config.ts) instead of a database. Ported in spirit from
// rovenotes-cloud's `connect-session.ts` + the poll-time `mintAndPersist`.
//
//   - `bootstrapFirstPartySession` turns a captured `pld_ut`/`pld_urt` pair
//     into a full first-party config patch: preflight-refresh a stale UT, list
//     workspaces, mint the first workspace token (WT), probe the account email,
//     and hand the caller a patch to persist.
//   - `ensureFreshWorkspaceToken` is called before each poll: when the cached
//     WT is stale it refreshes the UT (if needed) and re-mints the WT,
//     persisting the rotated tokens. Legacy installs are a no-op here.

import type { AppConfig } from "@applaud/shared";
import { logger } from "../logger.js";
import { loadConfig, updateConfig } from "../config.js";
import { apiBaseForRegion, PlaudAuthError } from "./client.js";
import { parseJwtClaims } from "../auth/jwt.js";
import {
  isExpiryWithinSkew,
  listWorkspaces,
  mintWorkspaceToken,
  pickPersonalWorkspaceId,
  PlaudMintError,
  PlaudRelayError,
  refreshUserToken,
  sessionFromCookies,
  UT_REFRESH_SKEW_MS,
  WT_REFRESH_SKEW_MS,
  type SessionTokens,
} from "./session.js";

const PLAUD_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/** The subset of config written when a first-party session is (re)established. */
export type FirstPartyPatch = Pick<
  AppConfig,
  | "authMode"
  | "token"
  | "tokenExp"
  | "tokenEmail"
  | "ut"
  | "utExp"
  | "urt"
  | "urtExp"
  | "plaudWorkspaceId"
  | "plaudRegion"
>;

export type BootstrapResult =
  | { ok: true; patch: FirstPartyPatch; email: string | null }
  | { ok: false; error: string };

function jwtExp(jwt: string): number | null {
  const claims = parseJwtClaims(jwt);
  return typeof claims?.exp === "number" ? claims.exp : null;
}

/** Best-effort account email probe via `/user/me` (Plaud JWTs carry no email). */
async function probeEmail(workspaceToken: string, region: string): Promise<string | null> {
  try {
    const res = await fetch(`${apiBaseForRegion(region)}/user/me`, {
      headers: {
        accept: "application/json",
        "user-agent": PLAUD_USER_AGENT,
        authorization: `Bearer ${workspaceToken}`,
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { status?: number; data_user?: { email?: string | null } };
    return body.data_user?.email ?? null;
  } catch (err) {
    logger.warn({ err }, "first-party: /user/me email probe failed — leaving null");
    return null;
  }
}

/**
 * Bootstrap a first-party session from a captured `pld_ut`/`pld_urt` cookie
 * pair. Returns a config patch to persist, or a human-readable error. Never
 * throws the typed session errors — they are folded into `{ ok: false }`.
 */
export async function bootstrapFirstPartySession(cookies: {
  ut: string;
  urt: string;
  region?: string;
}): Promise<BootstrapResult> {
  let session: SessionTokens = sessionFromCookies(cookies);

  // Preflight UT refresh: the cookie jar can hand us a UT minted hours ago.
  if (isExpiryWithinSkew(session.utExp, UT_REFRESH_SKEW_MS)) {
    try {
      session = await refreshUserToken(session.urt, session.ut, session.region);
    } catch (err) {
      if (err instanceof PlaudRelayError) {
        return { ok: false, error: `Plaud refresh ${err.kind}: ${err.message}` };
      }
      throw err;
    }
  }

  // List workspaces + pick the personal one.
  let workspaceId: string | null;
  try {
    const { workspaces } = await listWorkspaces(session.ut, session.region);
    workspaceId = pickPersonalWorkspaceId(workspaces);
  } catch (err) {
    if (err instanceof PlaudRelayError) {
      return { ok: false, error: `Plaud workspace list ${err.kind}: ${err.message}` };
    }
    throw err;
  }
  if (!workspaceId) {
    return { ok: false, error: "This Plaud account has no workspaces." };
  }

  // Mint the first workspace token.
  let workspaceToken: string;
  let effectiveRegion = session.region;
  try {
    const minted = await mintWorkspaceToken(session.ut, workspaceId, session.region);
    workspaceToken = minted.workspaceToken;
    effectiveRegion = minted.region;
  } catch (err) {
    if (err instanceof PlaudMintError) {
      return { ok: false, error: `Plaud token mint ${err.kind}: ${err.message}` };
    }
    throw err;
  }

  const email = await probeEmail(workspaceToken, effectiveRegion);

  const patch: FirstPartyPatch = {
    authMode: "first_party",
    token: workspaceToken,
    tokenExp: jwtExp(workspaceToken),
    tokenEmail: email,
    ut: session.ut,
    utExp: session.utExp,
    urt: session.urt,
    urtExp: session.urtExp,
    plaudWorkspaceId: workspaceId,
    plaudRegion: effectiveRegion,
  };
  return { ok: true, patch, email };
}

/**
 * Ensure the cached workspace token is usable before a poll. No-op for legacy
 * installs (they use the stored token directly until it expires). For
 * first-party installs, refreshes the UT off the URT when stale, then re-mints
 * the WT when stale, persisting rotated tokens as it goes.
 *
 * Throws `PlaudAuthError` when the credential is dead (UT/URT rejected) so the
 * poller surfaces "reconnect required"; throws a plain `Error` on transient
 * upstream failures so the poller records a retryable error.
 *
 * Pass `force` to re-mint even when the cached WT looks unexpired — used for
 * mid-poll 401 recovery, where Plaud rejected a WT that hadn't hit its skew.
 */
export async function ensureFreshWorkspaceToken(force = false): Promise<void> {
  const cfg = loadConfig();
  if (cfg.authMode !== "first_party") return; // legacy: nothing to refresh

  const wtFresh = cfg.token != null && !isExpiryWithinSkew(cfg.tokenExp, WT_REFRESH_SKEW_MS);
  if (wtFresh && !force) return;

  if (!cfg.ut || !cfg.urt || !cfg.plaudWorkspaceId || !cfg.plaudRegion) {
    throw new PlaudAuthError("first-party session is missing tokens — reconnect required");
  }

  let ut = cfg.ut;
  let region = cfg.plaudRegion;

  // 1. Refresh the UT off the URT when it's stale.
  if (isExpiryWithinSkew(cfg.utExp, UT_REFRESH_SKEW_MS)) {
    try {
      const refreshed = await refreshUserToken(cfg.urt, cfg.ut, region);
      ut = refreshed.ut;
      region = refreshed.region;
      updateConfig({
        ut: refreshed.ut,
        utExp: refreshed.utExp,
        urt: refreshed.urt,
        urtExp: refreshed.urtExp,
        plaudRegion: region,
      });
    } catch (err) {
      if (err instanceof PlaudRelayError) {
        if (err.kind === "rejected") {
          throw new PlaudAuthError(`Plaud refresh token rejected — reconnect required: ${err.message}`);
        }
        throw new Error(`Plaud UT refresh ${err.kind}: ${err.message}`);
      }
      throw err;
    }
  }

  // 2. Mint a fresh WT from the (possibly refreshed) UT.
  try {
    const minted = await mintWorkspaceToken(ut, cfg.plaudWorkspaceId, region);
    updateConfig({
      token: minted.workspaceToken,
      tokenExp: jwtExp(minted.workspaceToken),
      plaudRegion: minted.region,
    });
    logger.info({ region: minted.region }, "first-party: minted fresh workspace token");
  } catch (err) {
    if (err instanceof PlaudMintError) {
      if (err.kind === "user_token_rejected") {
        throw new PlaudAuthError(`Plaud user token rejected — reconnect required: ${err.message}`);
      }
      throw new Error(`Plaud workspace token mint ${err.kind}: ${err.message}`);
    }
    throw err;
  }
}
