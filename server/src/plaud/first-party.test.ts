import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type { AppConfig } from "@applaud/shared";
import { DEFAULT_CONFIG } from "@applaud/shared";

const { loadConfig, updateConfig } = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  updateConfig: vi.fn(),
}));
vi.mock("../config.js", () => ({ loadConfig, updateConfig }));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { bootstrapFirstPartySession, ensureFreshWorkspaceToken } from "./first-party.js";
import { PlaudAuthError } from "./client.js";

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}
const soonSec = () => Math.floor(Date.now() / 1000) + 30; // inside refresh skew
const laterSec = () => Math.floor(Date.now() / 1000) + 3600; // outside skew

interface MockResponse {
  status?: number;
  body?: string;
  setCookies?: string[];
}
function installFetch(responses: MockResponse[]): {
  calls: Array<{ url: string; init: RequestInit }>;
  restore: () => void;
} {
  const queue = [...responses];
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    calls.push({ url: urlStr, init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error(`fetch mock exhausted at call ${calls.length} to ${urlStr}`);
    const headers = new Headers({ "content-type": "application/json" });
    for (const c of next.setCookies ?? []) headers.append("set-cookie", c);
    return new Response(next.body ?? "", { status: next.status ?? 200, headers });
  }) as unknown as typeof globalThis.fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const wsListOk = JSON.stringify({
  status: 0,
  data: { workspaces: [{ workspace_id: "me", workspace_type: "0" }] },
});
const mintOk = (wt: string) => JSON.stringify({ status: 0, data: { workspace_token: wt } });

describe("bootstrapFirstPartySession", () => {
  let mock: ReturnType<typeof installFetch>;
  afterEach(() => mock.restore());

  it("lists, mints, probes email, and returns a first-party patch (fresh UT skips refresh)", async () => {
    const ut = jwt({ exp: laterSec(), region: "aws:us-west-2" });
    const urt = jwt({ exp: laterSec() });
    const wt = jwt({ exp: laterSec() });
    mock = installFetch([
      { body: wsListOk },
      { body: mintOk(wt) },
      { body: JSON.stringify({ status: 0, data_user: { email: "u@example.com" } }) },
    ]);
    const r = await bootstrapFirstPartySession({ ut, urt });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.patch).toMatchObject({
      authMode: "first_party",
      token: wt,
      ut,
      urt,
      plaudWorkspaceId: "me",
      plaudRegion: "aws:us-west-2",
      tokenEmail: "u@example.com",
    });
    // no refresh call — first call is the workspace list
    expect(mock.calls[0]!.url).toContain("/team-app/workspaces/list");
  });

  it("preflight-refreshes a stale UT before listing", async () => {
    const staleUt = jwt({ exp: soonSec() });
    const urt = jwt({ exp: laterSec() });
    const freshUt = jwt({ exp: laterSec() });
    const wt = jwt({ exp: laterSec() });
    mock = installFetch([
      { body: JSON.stringify({ status: 0 }), setCookies: [`pld_ut=${freshUt}`, `pld_urt=${urt}`] },
      { body: wsListOk },
      { body: mintOk(wt) },
      { body: JSON.stringify({ status: 0, data_user: {} }) },
    ]);
    const r = await bootstrapFirstPartySession({ ut: staleUt, urt });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(mock.calls[0]!.url).toContain("/auth/refresh-user-token");
    expect(r.patch.ut).toBe(freshUt); // refreshed UT persisted
    expect(r.patch.tokenEmail).toBeNull();
  });

  it("returns an error for an account with no workspaces", async () => {
    const ut = jwt({ exp: laterSec() });
    mock = installFetch([{ body: JSON.stringify({ status: 0, data: { workspaces: [] } }) }]);
    const r = await bootstrapFirstPartySession({ ut, urt: jwt({ exp: laterSec() }) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/no workspaces/i);
  });

  it("surfaces a mint rejection as an error result rather than throwing", async () => {
    const ut = jwt({ exp: laterSec() });
    mock = installFetch([{ body: wsListOk }, { status: 401, body: "" }]);
    const r = await bootstrapFirstPartySession({ ut, urt: jwt({ exp: laterSec() }) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/user_token_rejected/);
  });
});

describe("ensureFreshWorkspaceToken", () => {
  let mock: ReturnType<typeof installFetch>;
  const base = (over: Partial<AppConfig>): AppConfig => ({ ...DEFAULT_CONFIG, ...over });
  beforeEach(() => {
    updateConfig.mockReset();
    loadConfig.mockReset();
  });
  afterEach(() => mock?.restore());

  it("is a no-op for legacy installs", async () => {
    loadConfig.mockReturnValue(base({ authMode: "legacy", token: "legacy-jwt" }));
    mock = installFetch([]); // no calls expected
    await ensureFreshWorkspaceToken();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("is a no-op when the cached WT is still fresh", async () => {
    loadConfig.mockReturnValue(base({ authMode: "first_party", token: "wt", tokenExp: laterSec() }));
    mock = installFetch([]);
    await ensureFreshWorkspaceToken();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("mints a fresh WT (UT still fresh) and persists it", async () => {
    loadConfig.mockReturnValue(
      base({
        authMode: "first_party",
        token: "old-wt",
        tokenExp: soonSec(),
        ut: jwt({ exp: laterSec() }),
        utExp: laterSec(),
        urt: jwt({ exp: laterSec() }),
        plaudWorkspaceId: "me",
        plaudRegion: "aws:us-west-2",
      }),
    );
    const newWt = jwt({ exp: laterSec() });
    mock = installFetch([{ body: mintOk(newWt) }]);
    await ensureFreshWorkspaceToken();
    expect(mock.calls[0]!.url).toContain("/user-app/auth/workspace/token/me");
    expect(updateConfig).toHaveBeenCalledWith(expect.objectContaining({ token: newWt }));
  });

  it("refreshes a stale UT then mints, persisting both", async () => {
    loadConfig.mockReturnValue(
      base({
        authMode: "first_party",
        token: "old-wt",
        tokenExp: soonSec(),
        ut: jwt({ exp: soonSec() }),
        utExp: soonSec(),
        urt: jwt({ exp: laterSec() }),
        plaudWorkspaceId: "me",
        plaudRegion: "aws:us-west-2",
      }),
    );
    const freshUt = jwt({ exp: laterSec() });
    const rotatedUrt = jwt({ exp: laterSec() });
    const newWt = jwt({ exp: laterSec() });
    mock = installFetch([
      { body: JSON.stringify({ status: 0 }), setCookies: [`pld_ut=${freshUt}`, `pld_urt=${rotatedUrt}`] },
      { body: mintOk(newWt) },
    ]);
    await ensureFreshWorkspaceToken();
    expect(mock.calls[0]!.url).toContain("/auth/refresh-user-token");
    expect(updateConfig).toHaveBeenCalledWith(expect.objectContaining({ ut: freshUt, urt: rotatedUrt }));
    expect(updateConfig).toHaveBeenCalledWith(expect.objectContaining({ token: newWt }));
  });

  it("throws PlaudAuthError when the user token is rejected", async () => {
    loadConfig.mockReturnValue(
      base({
        authMode: "first_party",
        token: "old-wt",
        tokenExp: soonSec(),
        ut: jwt({ exp: laterSec() }),
        utExp: laterSec(),
        urt: jwt({ exp: laterSec() }),
        plaudWorkspaceId: "me",
        plaudRegion: "aws:us-west-2",
      }),
    );
    mock = installFetch([{ status: 401, body: "" }]);
    await expect(ensureFreshWorkspaceToken()).rejects.toBeInstanceOf(PlaudAuthError);
  });

  it("throws PlaudAuthError when first-party tokens are missing", async () => {
    loadConfig.mockReturnValue(base({ authMode: "first_party", token: null, tokenExp: null }));
    mock = installFetch([]);
    await expect(ensureFreshWorkspaceToken()).rejects.toBeInstanceOf(PlaudAuthError);
  });
});
