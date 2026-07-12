// Unified Plaud session detection from the local browser profiles.
//
// Backwards-compat order (per APP-2 / issue #31): try the legacy `tokenstr`
// localStorage value FIRST — existing logged-in Plaud users still have it, and
// it stays the simplest path. Only when it's gone (Plaud no longer exposes it)
// do we fall back to reading the first-party `pld_ut` / `pld_urt` cookies the
// way the RoveNotes Connector does.

import { findToken } from "./chrome-leveldb.js";
import { findFirstPartyCookies } from "./chrome-cookies.js";

export type DetectedSession =
  | {
      kind: "legacy";
      token: string;
      email: string | null;
      browser: string;
      profile: string;
    }
  | {
      kind: "first_party";
      ut: string;
      urt: string;
      browser: string;
      profile: string;
    };

/** A stable identity for a detected session, used to dedupe across polls. */
export function sessionKey(s: DetectedSession): string {
  return s.kind === "legacy" ? `legacy:${s.token}` : `first_party:${s.ut}`;
}

/**
 * Whether we can read a Plaud session off this machine's browser profiles.
 * Windows cookies are DPAPI / App-Bound encrypted and the legacy `tokenstr`
 * is on its way out, so rather than ship a fragile Windows decrypt path we
 * skip auto-detection there and route Windows users straight to manual paste.
 * Takes an explicit platform for testability; defaults to the host platform.
 */
export function autoDetectSupported(plat: NodeJS.Platform = process.platform): boolean {
  return plat !== "win32";
}

/**
 * Detect a Plaud session on this machine. Legacy `tokenstr` wins when present;
 * otherwise the first-party cookie pair. Returns `null` when neither is found.
 */
export async function detectSession(): Promise<DetectedSession | null> {
  const legacy = await findToken();
  if (legacy) {
    return {
      kind: "legacy",
      token: legacy.token,
      email: legacy.email,
      browser: legacy.browser,
      profile: legacy.profile,
    };
  }
  const cookies = findFirstPartyCookies();
  if (cookies) {
    return {
      kind: "first_party",
      ut: cookies.ut,
      urt: cookies.urt,
      browser: cookies.browser,
      profile: cookies.profile,
    };
  }
  return null;
}
