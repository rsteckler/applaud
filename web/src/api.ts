import type {
  AuthDetectResponse,
  AuthValidateResponse,
  ConfigResponse,
  RecordingsListResponse,
  RecordingDetail,
  SyncStatusResponse,
  SetupStatusResponse,
  WebhookTestResponse,
  RecordingsDirValidateResponse,
  AppConfig,
  ClearSyncIgnoreResponse,
  SyncBlocklistResponse,
} from "@applaud/shared";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ApiError(body || `HTTP ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

export const api = {
  setupStatus: () => jsonFetch<SetupStatusResponse>("/api/setup/status"),
  authDetect: () =>
    jsonFetch<AuthDetectResponse>("/api/auth/detect", { method: "POST", body: "{}" }),
  authAccept: (token: string, email?: string) =>
    jsonFetch<{ ok: boolean; email?: string; exp?: number; error?: string }>(
      "/api/auth/accept",
      {
        method: "POST",
        body: JSON.stringify({ token, ...(email ? { email } : {}) }),
      },
    ),
  /** First-party: submit a captured `pld_ut` / `pld_urt` cookie pair. */
  authAcceptCookies: (ut: string, urt: string) =>
    jsonFetch<{ ok: boolean; email?: string; exp?: number; error?: string }>(
      "/api/auth/accept",
      {
        method: "POST",
        body: JSON.stringify({ ut, urt }),
      },
    ),
  authValidate: (token: string) =>
    jsonFetch<AuthValidateResponse>("/api/auth/validate", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
  authStartWatch: () =>
    jsonFetch<{ watchId: string }>("/api/auth/watch", { method: "POST", body: "{}" }),
  config: () => jsonFetch<ConfigResponse>("/api/config"),
  updateConfig: (patch: Partial<AppConfig>) =>
    jsonFetch<ConfigResponse>("/api/config", {
      method: "POST",
      body: JSON.stringify(patch),
    }),
  testWebhook: (url: string) =>
    jsonFetch<WebhookTestResponse>("/api/config/test-webhook", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  validateRecordingsDir: (pathStr: string) =>
    jsonFetch<RecordingsDirValidateResponse>("/api/config/validate-recordings-dir", {
      method: "POST",
      body: JSON.stringify({ path: pathStr }),
    }),
  completeSetup: () =>
    jsonFetch<{ ok: boolean }>("/api/config/complete-setup", {
      method: "POST",
      body: "{}",
    }),
  listRecordings: (params: { limit?: number; offset?: number; search?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    if (params.search) qs.set("search", params.search);
    return jsonFetch<RecordingsListResponse>(`/api/recordings?${qs.toString()}`);
  },
  listTrashRecordings: (params: { limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    return jsonFetch<RecordingsListResponse>(`/api/recordings/trash?${qs.toString()}`);
  },
  syncBlocklist: () => jsonFetch<SyncBlocklistResponse>("/api/recordings/sync-blocklist"),
  recordingDetail: (id: string) =>
    jsonFetch<{ recording: RecordingDetail; mediaBase: string }>(`/api/recordings/${id}`),
  deleteRecording: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/recordings/${id}`, { method: "DELETE" }),
  restoreRecording: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/recordings/${id}/restore`, { method: "POST", body: "{}" }),
  purgeRecordingFromTrash: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/recordings/${id}/purge`, { method: "POST", body: "{}" }),
  clearSyncIgnore: () =>
    jsonFetch<ClearSyncIgnoreResponse>("/api/config/clear-sync-ignore", { method: "POST", body: "{}" }),
  syncStatus: () => jsonFetch<SyncStatusResponse>("/api/sync/status"),
  syncTrigger: () =>
    jsonFetch<{ ok: boolean }>("/api/sync/trigger", { method: "POST", body: "{}" }),
};
