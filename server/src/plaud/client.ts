import { logger } from "../logger.js";
import { loadConfig, updateConfig } from "../config.js";

const REGION_API_BASES: Record<string, string> = {
  "aws:us-west-2": "https://api.plaud.ai",
  "aws:eu-central-1": "https://api-euc1.plaud.ai",
  "aws:ap-southeast-1": "https://api-apse1.plaud.ai",
};
const DEFAULT_API_BASE = "https://api.plaud.ai";

/** Reverse lookup: API base URL → region key. */
const API_BASE_TO_REGION = new Map(
  Object.entries(REGION_API_BASES).map(([region, url]) => [new URL(url).hostname, region]),
);

/**
 * Given an API base URL returned by Plaud's region-mismatch response,
 * resolve the corresponding region key (e.g. "aws:eu-central-1").
 * Returns `null` if the hostname is not in the known map.
 */
export function resolveRegionFromDomain(apiBaseUrl: string): string | null {
  try {
    const hostname = new URL(apiBaseUrl).hostname;
    return API_BASE_TO_REGION.get(hostname) ?? null;
  } catch {
    return null;
  }
}

export function getPlaudApiBase(): string {
  const cfg = loadConfig();
  if (cfg.plaudRegion) {
    return REGION_API_BASES[cfg.plaudRegion] ?? DEFAULT_API_BASE;
  }
  return DEFAULT_API_BASE;
}

export class PlaudAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaudAuthError";
  }
}

export class PlaudApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = "PlaudApiError";
  }
}

type FetchInit = Omit<RequestInit, "headers"> & {
  headers?: Record<string, string>;
  authOverride?: string;
};

function getToken(): string {
  const cfg = loadConfig();
  if (!cfg.token) throw new PlaudAuthError("no token configured");
  return cfg.token;
}

const USER_AGENT = "applaud/0.1.0 (+https://github.com/rsteckler/applaud)";

export async function plaudFetch(pathOrUrl: string, init: FetchInit = {}): Promise<Response> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${getPlaudApiBase()}${pathOrUrl}`;
  const token = init.authOverride ?? getToken();
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": USER_AGENT,
    authorization: `Bearer ${token}`,
    ...init.headers,
  };
  // Default JSON content type for methods that likely send a body.
  if (init.body && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }

  const maxAttempts = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { ...init, headers });
      if (res.status === 401) {
        updateConfig({ setupComplete: true });
        throw new PlaudAuthError("Plaud returned 401 — token expired or revoked");
      }
      if (res.status >= 500 && attempt < maxAttempts) {
        const waitMs = attempt * 1000;
        logger.warn({ url, status: res.status, attempt }, "Plaud 5xx — retrying");
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      return res;
    } catch (err) {
      if (err instanceof PlaudAuthError) throw err;
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, attempt * 1000));
        continue;
      }
    }
  }
  throw new PlaudApiError(
    `network error after ${maxAttempts} attempts: ${String(lastErr)}`,
    0,
    "",
  );
}

/** Shape of Plaud's region-mismatch error response (status -302). */
interface PlaudRegionMismatch {
  status: -302;
  msg: string;
  data?: { domains?: { api?: string } };
}

function isRegionMismatch(body: unknown): body is PlaudRegionMismatch {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as PlaudRegionMismatch).status === -302 &&
    typeof (body as PlaudRegionMismatch).data?.domains?.api === "string"
  );
}

export async function plaudJson<T>(path: string, init: FetchInit = {}): Promise<T> {
  const res = await plaudFetch(path, init);
  const text = await res.text();
  if (!res.ok) {
    throw new PlaudApiError(
      `Plaud ${init.method ?? "GET"} ${path} → ${res.status}`,
      res.status,
      text.slice(0, 500),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new PlaudApiError(
      `Plaud ${path} returned non-JSON: ${String(err)}`,
      res.status,
      text.slice(0, 500),
    );
  }

  // Handle region mismatch: Plaud returns HTTP 200 with a JSON body
  // containing status -302 and the correct regional API domain.
  if (isRegionMismatch(parsed)) {
    const correctDomain = parsed.data!.domains!.api!;
    const correctRegion = resolveRegionFromDomain(correctDomain);

    // Only persist the corrected region when using the stored token
    // (not for one-off authOverride validation calls).
    if (!init.authOverride) {
      if (correctRegion) {
        logger.info({ correctDomain, correctRegion }, "Plaud region mismatch — updating config and retrying");
        updateConfig({ plaudRegion: correctRegion });
      } else {
        logger.warn({ correctDomain }, "Plaud region mismatch — unknown domain, cannot auto-correct");
        throw new PlaudApiError(
          `Plaud region mismatch: server says use ${correctDomain} but it's not a known endpoint`,
          200,
          text.slice(0, 500),
        );
      }
    } else {
      // For authOverride calls, persist the corrected region so the retry
      // (and any concurrent stored-token calls) hit the right endpoint.
      // The caller (e.g. /accept) is expected to overwrite plaudRegion
      // afterward based on its own decision — see `resolvedRegion` in the
      // /accept handler.
      if (correctRegion) {
        logger.info({ correctDomain, correctRegion }, "Plaud region mismatch during token validation — retrying");
        updateConfig({ plaudRegion: correctRegion });
      } else {
        // Without a region update, the retry would hit the same endpoint and
        // get the same -302 — silently returning the error body to the caller
        // typed as T. Fail fast instead.
        logger.warn(
          { correctDomain },
          "Plaud region mismatch during token validation — unknown domain, cannot auto-correct",
        );
        throw new PlaudApiError(
          `Plaud region mismatch: server says use ${correctDomain} but it's not a known endpoint`,
          200,
          text.slice(0, 500),
        );
      }
    }

    // Retry once with the corrected endpoint.
    const retryRes = await plaudFetch(path, init);
    const retryText = await retryRes.text();
    if (!retryRes.ok) {
      throw new PlaudApiError(
        `Plaud ${init.method ?? "GET"} ${path} → ${retryRes.status} (after region correction)`,
        retryRes.status,
        retryText.slice(0, 500),
      );
    }
    try {
      return JSON.parse(retryText) as T;
    } catch (err) {
      throw new PlaudApiError(
        `Plaud ${path} returned non-JSON after region correction: ${String(err)}`,
        retryRes.status,
        retryText.slice(0, 500),
      );
    }
  }

  return parsed as T;
}
