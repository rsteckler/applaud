import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  pickLatestSetCookie,
  sessionFromCookies,
  isExpiryWithinSkew,
  refreshUserToken,
  listWorkspaces,
  pickPersonalWorkspaceId,
  mintWorkspaceToken,
  PlaudMintError,
  PlaudRelayError,
} from "./session.js";

// ---- helpers ----

/** Build an unsigned JWT with the given payload claims. */
function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}

interface MockResponse {
  status?: number;
  body?: string;
  /** Raw Set-Cookie header lines (multiple allowed). */
  setCookies?: string[];
  throws?: unknown;
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
    if (next.throws !== undefined) throw next.throws;
    const headers = new Headers({ "content-type": "application/json" });
    for (const c of next.setCookies ?? []) headers.append("set-cookie", c);
    return new Response(next.body ?? "", { status: next.status ?? 200, headers });
  }) as unknown as typeof globalThis.fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

describe("pickLatestSetCookie", () => {
  it("returns the last non-empty value, ignoring Max-Age=0 clearers that come first", () => {
    const h = new Headers();
    h.append("set-cookie", "pld_ut=; Max-Age=0; Path=/");
    h.append("set-cookie", "pld_ut=REAL_UT; Path=/; HttpOnly");
    expect(pickLatestSetCookie(h, "pld_ut")).toBe("REAL_UT");
  });

  it("ignores an epoch-expiry clearer", () => {
    const h = new Headers();
    h.append("set-cookie", "pld_urt=stale; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(pickLatestSetCookie(h, "pld_urt")).toBeNull();
  });

  it("returns null when the cookie is absent", () => {
    const h = new Headers();
    h.append("set-cookie", "other=x; Path=/");
    expect(pickLatestSetCookie(h, "pld_ut")).toBeNull();
  });
});

describe("sessionFromCookies", () => {
  it("reads expiry, region, and sid from the JWT claims", () => {
    const ut = jwt({ exp: 1000, region: "aws:eu-central-1", sid: "abc" });
    const urt = jwt({ exp: 2000 });
    const s = sessionFromCookies({ ut, urt });
    expect(s).toMatchObject({ ut, urt, utExp: 1000, urtExp: 2000, sid: "abc", region: "aws:eu-central-1" });
  });

  it("prefers an explicit region over the UT claim, and falls back to the default", () => {
    expect(sessionFromCookies({ ut: jwt({}), urt: jwt({}), region: "aws:ap-southeast-1" }).region).toBe(
      "aws:ap-southeast-1",
    );
    expect(sessionFromCookies({ ut: jwt({}), urt: jwt({}) }).region).toBe("aws:us-west-2");
  });
});

describe("isExpiryWithinSkew", () => {
  it("treats a missing expiry as refresh-now", () => {
    expect(isExpiryWithinSkew(null, 1000)).toBe(true);
  });
  it("is true when expiry is inside the skew window", () => {
    const soon = Math.floor(Date.now() / 1000) + 60;
    expect(isExpiryWithinSkew(soon, 5 * 60 * 1000)).toBe(true);
  });
  it("is false when expiry is comfortably in the future", () => {
    const later = Math.floor(Date.now() / 1000) + 3600;
    expect(isExpiryWithinSkew(later, 5 * 60 * 1000)).toBe(false);
  });
});

describe("refreshUserToken", () => {
  let mock: ReturnType<typeof installFetch>;
  afterEach(() => mock.restore());

  it("posts UT+URT as cookies and returns the rotated tokens from Set-Cookie", async () => {
    const newUt = jwt({ exp: 5000 });
    const newUrt = jwt({ exp: 9000 });
    mock = installFetch([
      {
        body: JSON.stringify({ status: 0 }),
        setCookies: [`pld_ut=${newUt}; Path=/; HttpOnly`, `pld_urt=${newUrt}; Path=/auth/refresh-user-token; HttpOnly`],
      },
    ]);
    const s = await refreshUserToken("OLD_URT", "OLD_UT", "aws:us-west-2");
    expect(s.ut).toBe(newUt);
    expect(s.urt).toBe(newUrt);
    expect(mock.calls[0]!.url).toBe("https://api.plaud.ai/auth/refresh-user-token");
    expect((mock.calls[0]!.init.headers as Record<string, string>).cookie).toBe("pld_ut=OLD_UT; pld_urt=OLD_URT");
  });

  it("falls back to the current tokens when Plaud only rotates one cookie", async () => {
    const newUt = jwt({ exp: 5000 });
    mock = installFetch([{ body: JSON.stringify({ status: 0 }), setCookies: [`pld_ut=${newUt}; Path=/`] }]);
    const s = await refreshUserToken("OLD_URT", "OLD_UT", "aws:us-west-2");
    expect(s.ut).toBe(newUt);
    expect(s.urt).toBe("OLD_URT");
  });

  it("throws a rejected PlaudRelayError on a non-zero envelope", async () => {
    mock = installFetch([{ body: JSON.stringify({ status: -1, msg: "bad" }) }]);
    await expect(refreshUserToken("u", "t", "aws:us-west-2")).rejects.toMatchObject({
      name: "PlaudRelayError",
      kind: "rejected",
    });
  });

  it("throws a transient PlaudRelayError on a 5xx", async () => {
    mock = installFetch([{ status: 502, body: "gateway" }]);
    await expect(refreshUserToken("u", "t", "aws:us-west-2")).rejects.toMatchObject({ kind: "transient" });
  });
});

describe("listWorkspaces / pickPersonalWorkspaceId", () => {
  let mock: ReturnType<typeof installFetch>;
  afterEach(() => mock.restore());

  it("parses the workspace list and picks the personal one", async () => {
    mock = installFetch([
      {
        body: JSON.stringify({
          status: 0,
          data: {
            workspaces: [
              { workspace_id: "team1", workspace_type: "1", workspace_name: "Team" },
              { workspace_id: "me", workspace_type: "0", workspace_name: "Personal" },
            ],
          },
        }),
      },
    ]);
    const { workspaces } = await listWorkspaces("UT", "aws:us-west-2");
    expect(workspaces).toHaveLength(2);
    expect(pickPersonalWorkspaceId(workspaces)).toBe("me");
    expect((mock.calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer UT");
  });

  it("follows a -302 region redirect once", async () => {
    mock = installFetch([
      { body: JSON.stringify({ status: -302, data: { domains: { api: "https://api-euc1.plaud.ai" } } }) },
      { body: JSON.stringify({ status: 0, data: { workspaces: [{ workspace_id: "me", workspace_type: "0" }] } }) },
    ]);
    const { workspaces, region } = await listWorkspaces("UT", "aws:us-west-2");
    expect(workspaces[0]!.workspace_id).toBe("me");
    expect(region).toBe("aws:eu-central-1");
    expect(mock.calls[1]!.url).toContain("api-euc1.plaud.ai");
  });

  it("falls back to the first workspace when none is personal", () => {
    expect(
      pickPersonalWorkspaceId([
        { workspace_id: "a", workspace_type: "1" },
        { workspace_id: "b", workspace_type: "2" },
      ]),
    ).toBe("a");
    expect(pickPersonalWorkspaceId([])).toBeNull();
  });
});

describe("mintWorkspaceToken", () => {
  let mock: ReturnType<typeof installFetch>;
  afterEach(() => mock.restore());

  it("returns the workspace token on a status=0 envelope", async () => {
    mock = installFetch([{ body: JSON.stringify({ status: 0, data: { workspace_token: "WT123" } }) }]);
    const { workspaceToken } = await mintWorkspaceToken("UT", "ws id/1", "aws:us-west-2");
    expect(workspaceToken).toBe("WT123");
    // workspace id must be URL-encoded in the path
    expect(mock.calls[0]!.url).toBe("https://api.plaud.ai/user-app/auth/workspace/token/ws%20id%2F1");
  });

  it("classifies a 401 as user_token_rejected (UT dead, no retry)", async () => {
    mock = installFetch([{ status: 401, body: "" }]);
    await expect(mintWorkspaceToken("UT", "ws", "aws:us-west-2")).rejects.toMatchObject({
      name: "PlaudMintError",
      kind: "user_token_rejected",
    });
  });

  it("classifies a non-zero envelope as stale", async () => {
    mock = installFetch([{ body: JSON.stringify({ status: -1, msg: "gone" }) }]);
    await expect(mintWorkspaceToken("UT", "ws", "aws:us-west-2")).rejects.toMatchObject({ kind: "stale" });
  });

  it("classifies a 5xx as transient", async () => {
    mock = installFetch([{ status: 503, body: "" }]);
    await expect(mintWorkspaceToken("UT", "ws", "aws:us-west-2")).rejects.toMatchObject({ kind: "transient" });
  });
});
