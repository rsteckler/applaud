import { describe, it, expect } from "vitest";
import { parseJwtClaims } from "./jwt.js";

function makeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}

describe("parseJwtClaims", () => {
  it("decodes a typical Plaud-shaped JWT", () => {
    const jwt = makeJwt({ iat: 1_700_000_000, exp: 1_730_000_000, sub: "user-1" });
    const claims = parseJwtClaims(jwt);
    expect(claims).toMatchObject({ iat: 1_700_000_000, exp: 1_730_000_000, sub: "user-1" });
  });

  it("returns null for a token with the wrong number of segments", () => {
    expect(parseJwtClaims("only-one-segment")).toBeNull();
    expect(parseJwtClaims("two.segments")).toBeNull();
    expect(parseJwtClaims("a.b.c.d")).toBeNull();
  });

  it("returns null when the payload segment is empty", () => {
    expect(parseJwtClaims("a..c")).toBeNull();
  });

  it("returns null when the payload isn't valid base64-decoded JSON", () => {
    // base64url of "not-json"
    const garbage = `header.${Buffer.from("not-json").toString("base64url")}.sig`;
    expect(parseJwtClaims(garbage)).toBeNull();
  });

  it("handles base64url with no padding (the canonical JWT form)", () => {
    // Crafted so the base64 representation of {"x":1} has length not divisible by 4.
    const jwt = makeJwt({ x: 1 });
    const claims = parseJwtClaims(jwt);
    expect(claims).toEqual({ x: 1 });
  });

  it("translates base64url chars (- and _) to standard base64 (+ and /)", () => {
    // Force a payload that contains '-' and '_' after base64url encoding.
    // {"data":"hi"} → base64 → eyJkYXRhIjoiaGkifQ — no special chars yet.
    // Use a binary-ish claim to maximize chance of - or _: many strings → eyJ contains _ in long form.
    const claims = { msg: "????>>>>////" };
    const jwt = makeJwt(claims);
    expect(parseJwtClaims(jwt)).toEqual(claims);
  });

  it("returns claims object even when iat/exp are missing", () => {
    const jwt = makeJwt({ sub: "user-2" });
    const claims = parseJwtClaims(jwt);
    expect(claims).toEqual({ sub: "user-2" });
    expect(claims?.iat).toBeUndefined();
    expect(claims?.exp).toBeUndefined();
  });

  it("does not throw on a totally malformed input", () => {
    expect(() => parseJwtClaims("")).not.toThrow();
    expect(parseJwtClaims("")).toBeNull();
  });
});
