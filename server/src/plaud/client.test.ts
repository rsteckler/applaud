import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AppConfig } from "@applaud/shared";

// Mock the config module BEFORE importing client.ts so that plaudJson sees
// our controlled loadConfig / updateConfig. vi.hoisted is required because
// vi.mock factories run before module imports.
const { loadConfig, updateConfig } = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  updateConfig: vi.fn(),
}));
vi.mock("../config.js", () => ({ loadConfig, updateConfig }));

// And silence the logger so the test output stays clean.
vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { plaudJson, PlaudApiError, PlaudAuthError, resolveRegionFromDomain } from "./client.js";
import { installFetchMock, type FetchMock } from "../test/fixtures/fetch.js";

const baseConfig: AppConfig = {
  version: 1,
  setupComplete: true,
  token: "test-token",
  tokenExp: null,
  tokenEmail: null,
  plaudRegion: null,
  recordingsDir: "/tmp/r",
  webhook: null,
  pollIntervalMinutes: 10,
  bind: { host: "127.0.0.1", port: 44471 },
  lanToken: null,
  importPlaudDeleted: false,
};

describe("resolveRegionFromDomain", () => {
  it("maps the EU central API host back to its region key", () => {
    expect(resolveRegionFromDomain("https://api-euc1.plaud.ai")).toBe("aws:eu-central-1");
  });

  it("maps the US default API host back to its region key", () => {
    expect(resolveRegionFromDomain("https://api.plaud.ai")).toBe("aws:us-west-2");
  });

  it("maps the AP southeast API host back to its region key", () => {
    expect(resolveRegionFromDomain("https://api-apse1.plaud.ai")).toBe("aws:ap-southeast-1");
  });

  it("returns null for an unknown hostname", () => {
    expect(resolveRegionFromDomain("https://api-rogue.plaud.ai")).toBeNull();
  });

  it("returns null for a malformed URL", () => {
    expect(resolveRegionFromDomain("not a url at all")).toBeNull();
  });
});

describe("plaudJson — region-mismatch retry (-302)", () => {
  let mock: FetchMock;

  beforeEach(() => {
    loadConfig.mockReset();
    updateConfig.mockReset();
    loadConfig.mockReturnValue(baseConfig);
    mock = installFetchMock();
  });

  afterEach(() => {
    mock.restore();
  });

  it("on -302 from default domain, persists corrected region and retries against the new endpoint", async () => {
    // First response: HTTP 200 with the -302 region-mismatch body.
    mock.enqueue({
      status: 200,
      body: JSON.stringify({
        status: -302,
        msg: "wrong region",
        data: { domains: { api: "https://api-euc1.plaud.ai" } },
      }),
    });
    // Second response (after retry): real payload.
    mock.enqueue({
      status: 200,
      body: JSON.stringify({ ok: true, items: [] }),
    });

    // After the first call, the next loadConfig() in plaudFetch() should see
    // the persisted region. Cycle the loadConfig mock to reflect that.
    loadConfig.mockImplementation(() => {
      const lastUpdate = updateConfig.mock.calls.at(-1)?.[0];
      return { ...baseConfig, ...(lastUpdate ?? {}) };
    });

    const out = await plaudJson<{ ok: boolean }>("/file/list");
    expect(out).toEqual({ ok: true, items: [] });

    // Two fetches: original (default base) + retry (EU central).
    expect(mock.calls.length).toBe(2);
    expect(mock.calls[0]!.url).toBe("https://api.plaud.ai/file/list");
    expect(mock.calls[1]!.url).toBe("https://api-euc1.plaud.ai/file/list");

    // Region was persisted with the right key.
    expect(updateConfig).toHaveBeenCalledWith({ plaudRegion: "aws:eu-central-1" });
  });

  it("throws PlaudApiError when -302 points at an unknown domain (no infinite retry)", async () => {
    mock.enqueue({
      status: 200,
      body: JSON.stringify({
        status: -302,
        msg: "wrong region",
        data: { domains: { api: "https://api-rogue.plaud.ai" } },
      }),
    });

    await expect(plaudJson("/file/list")).rejects.toBeInstanceOf(PlaudApiError);

    // Only the original call — no retry was attempted.
    expect(mock.calls.length).toBe(1);
    // No region update happened.
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("authOverride path persists region and retries using the override token (not the stored token)", async () => {
    mock.enqueue({
      status: 200,
      body: JSON.stringify({
        status: -302,
        msg: "wrong region",
        data: { domains: { api: "https://api-euc1.plaud.ai" } },
      }),
    });
    mock.enqueue({
      status: 200,
      body: JSON.stringify({ ok: true }),
    });

    loadConfig.mockImplementation(() => {
      const lastUpdate = updateConfig.mock.calls.at(-1)?.[0];
      return { ...baseConfig, ...(lastUpdate ?? {}) };
    });

    const out = await plaudJson<{ ok: boolean }>("/auth/validate", {
      method: "POST",
      body: "{}",
      authOverride: "candidate-token",
    });
    expect(out).toEqual({ ok: true });
    expect(updateConfig).toHaveBeenCalledWith({ plaudRegion: "aws:eu-central-1" });
    expect(mock.calls.length).toBe(2);
    // First call uses the override token; second uses it too (authOverride flows through retry).
    const auth1 = (mock.calls[0]!.init!.headers as Record<string, string>)["authorization"];
    const auth2 = (mock.calls[1]!.init!.headers as Record<string, string>)["authorization"];
    expect(auth1).toBe("Bearer candidate-token");
    expect(auth2).toBe("Bearer candidate-token");
  });

  it("authOverride path also throws PlaudApiError when -302 domain is unknown (no silent retry)", async () => {
    mock.enqueue({
      status: 200,
      body: JSON.stringify({
        status: -302,
        msg: "wrong region",
        data: { domains: { api: "https://api-rogue.plaud.ai" } },
      }),
    });
    await expect(
      plaudJson("/auth/validate", { method: "POST", body: "{}", authOverride: "candidate" }),
    ).rejects.toBeInstanceOf(PlaudApiError);
    // Single call — no retry against the same endpoint that would return the
    // same -302 body and get silently parsed as T.
    expect(mock.calls.length).toBe(1);
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("does NOT trigger -302 retry on a normal successful response", async () => {
    mock.enqueue({
      status: 200,
      body: JSON.stringify({ status: 0, items: ["x"] }),
    });
    const out = await plaudJson<{ status: number }>("/file/list");
    expect(out).toEqual({ status: 0, items: ["x"] });
    expect(mock.calls.length).toBe(1);
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("HTTP 401 throws PlaudAuthError without retrying for region", async () => {
    mock.enqueue({ status: 401, body: '{"err":"unauthorized"}' });
    await expect(plaudJson("/file/list")).rejects.toBeInstanceOf(PlaudAuthError);
    expect(mock.calls.length).toBe(1);
  });
});
