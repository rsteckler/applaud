export interface BindConfig {
  host: string;
  port: number;
}

export interface WebhookConfig {
  url: string;
  enabled: boolean;
  secret?: string;
}

/**
 * How the stored Plaud credential was obtained, which decides how the token
 * is kept fresh:
 *   - `"legacy"`   — a single long-lived bearer JWT lifted from Local Storage
 *                    (`tokenstr`). No refresh capability; when it expires the
 *                    user must reconnect. This is the original Applaud model
 *                    and remains the default for existing installs where
 *                    `authMode` is unset.
 *   - `"first_party"` — Plaud's newer cookie model. We hold a user token (UT,
 *                    `pld_ut`, ~1 day) and a user refresh token (URT,
 *                    `pld_urt`, ~30 days) and mint a short-lived workspace
 *                    token (WT) on demand, refreshing the UT off the URT as it
 *                    ages. `token`/`tokenExp` cache the current WT.
 */
export type PlaudAuthMode = "legacy" | "first_party";

export interface AppConfig {
  version: number;
  setupComplete: boolean;
  /**
   * When unset (`null`), the credential predates the first-party model and is
   * treated as `"legacy"` — the stored `token` is used directly as the bearer.
   */
  authMode: PlaudAuthMode | null;
  /** Bearer token used for Plaud API calls. Legacy: the long-lived JWT.
   *  First-party: the cached workspace token (WT), re-minted as it expires. */
  token: string | null;
  tokenExp: number | null;
  tokenEmail: string | null;
  /** First-party only: user token (`pld_ut`) — mints workspace tokens. */
  ut: string | null;
  utExp: number | null;
  /** First-party only: user refresh token (`pld_urt`) — refreshes the UT. */
  urt: string | null;
  urtExp: number | null;
  /** First-party only: the workspace the WT is minted for. */
  plaudWorkspaceId: string | null;
  plaudRegion: string | null;
  recordingsDir: string | null;
  webhook: WebhookConfig | null;
  pollIntervalMinutes: number;
  bind: BindConfig;
  lanToken: string | null;
  /**
   * When true, list/sync includes items in Plaud’s trash (`is_trash`) so they can be archived locally.
   * When false, only non-trashed Plaud files are synced and the main list hides Plaud-trashed rows.
   */
  importPlaudDeleted: boolean;
}

export const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  setupComplete: false,
  authMode: null,
  token: null,
  tokenExp: null,
  tokenEmail: null,
  ut: null,
  utExp: null,
  urt: null,
  urtExp: null,
  plaudWorkspaceId: null,
  plaudRegion: null,
  recordingsDir: null,
  webhook: null,
  pollIntervalMinutes: 10,
  bind: { host: "127.0.0.1", port: 44471 },
  lanToken: null,
  importPlaudDeleted: false,
};
