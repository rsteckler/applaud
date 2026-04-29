/**
 * Decode a JWT payload without verifying the signature.
 *
 * Used only to read `iat`/`exp` so the browser-detection picker can choose
 * the newest token among multiple profiles. We never trust this output for
 * authorization — Plaud's API is the source of truth.
 */

export interface JwtClaims {
  iat?: number;
  exp?: number;
  email?: string;
  [k: string]: unknown;
}

export function parseJwtClaims(jwt: string): JwtClaims | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  const payload = parts[1];
  if (!payload) return null;
  // base64url → base64 + restore stripped padding.
  // Buffer.from(str, "base64") never throws on bad input — it silently
  // skips invalid characters and returns whatever it managed to decode.
  // Any garbage bytes fall through to JSON.parse, which catches them.
  const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const json = Buffer.from(padded, "base64").toString("utf8");
  try {
    return JSON.parse(json) as JwtClaims;
  } catch {
    return null;
  }
}
