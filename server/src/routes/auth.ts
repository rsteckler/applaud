import { Router } from "express";
import { z } from "zod";
import { findToken } from "../auth/chrome-leveldb.js";
import { startBrowserWatch, subscribeWatch } from "../auth/browser-watch.js";
import { plaudFetch, PlaudAuthError, resolveRegionFromDomain } from "../plaud/client.js";
import { loadConfig, updateConfig } from "../config.js";
import { logger } from "../logger.js";
import type { AuthDetectResponse, AuthValidateResponse } from "@applaud/shared";

export const authRouter = Router();

function extractJwt(raw: string): string | null {
  const trimmed = raw.trim();
  // Accept either a raw JWT or the `PLADU_bearer eyJ...` storage key format
  const m = trimmed.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  return m ? m[0] : null;
}

function parseJwt(jwt: string): { iat: number | null; exp: number | null; email: string | null; region: string | null } {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return { iat: null, exp: null, email: null, region: null };
    const payload = parts[1];
    if (!payload) return { iat: null, exp: null, email: null, region: null };
    const json = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as { iat?: number; exp?: number; email?: string; region?: string };
    return { iat: json.iat ?? null, exp: json.exp ?? null, email: json.email ?? null, region: json.region ?? null };
  } catch {
    return { iat: null, exp: null, email: null, region: null };
  }
}

async function validateToken(token: string): Promise<AuthValidateResponse & { resolvedRegion?: string }> {
  const testPath = "/file/simple/web?skip=0&limit=1&is_trash=2&sort_by=start_time&is_desc=true";
  try {
    const res = await plaudFetch(testPath, { authOverride: token });
    if (res.status !== 200) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Plaud returned HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    const body = (await res.json()) as { msg?: string; status?: number; data?: { domains?: { api?: string } } };

    // Handle region mismatch: Plaud tells us the correct API domain.
    if (body.status === -302 && body.data?.domains?.api) {
      const correctDomain = body.data.domains.api;
      const correctRegion = resolveRegionFromDomain(correctDomain);
      if (correctRegion) {
        logger.info({ correctDomain, correctRegion }, "region mismatch during token validation — retrying");
        // Temporarily set the correct region so the retry hits the right endpoint.
        updateConfig({ plaudRegion: correctRegion });
        const retryRes = await plaudFetch(testPath, { authOverride: token });
        if (retryRes.status !== 200) {
          const retryBody = await retryRes.text().catch(() => "");
          return { ok: false, error: `Plaud returned HTTP ${retryRes.status} after region correction: ${retryBody.slice(0, 200)}` };
        }
        const retryBody = (await retryRes.json()) as { msg?: string; status?: number };
        if (retryBody.status !== 0) {
          return { ok: false, error: `Plaud returned msg=${retryBody.msg} after region correction` };
        }
        const { exp } = parseJwt(token);
        return { ok: true, exp: exp ?? undefined, resolvedRegion: correctRegion };
      }
      return { ok: false, error: `Plaud region mismatch: server says use ${correctDomain} but it's not a known endpoint` };
    }

    if (body.status !== 0) {
      return { ok: false, error: `Plaud returned msg=${body.msg}` };
    }
    const { exp } = parseJwt(token);
    return { ok: true, exp: exp ?? undefined };
  } catch (err) {
    if (err instanceof PlaudAuthError) return { ok: false, error: err.message };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

authRouter.post("/detect", async (_req, res) => {
  try {
    const found = await findToken();
    if (!found) {
      const r: AuthDetectResponse = { found: false };
      res.json(r);
      return;
    }
    const r: AuthDetectResponse = {
      found: true,
      token: found.token,
      profile: found.profile,
      browser: found.browser,
      email: found.email ?? undefined,
    };
    res.json(r);
  } catch (err) {
    logger.error({ err }, "auth detect failed");
    const r: AuthDetectResponse = {
      found: false,
      error: err instanceof Error ? err.message : String(err),
    };
    res.status(500).json(r);
  }
});

const AcceptSchema = z.object({
  token: z.string().min(10),
  email: z.string().optional(),
});

authRouter.post("/accept", async (req, res) => {
  const parsed = AcceptSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid body" });
    return;
  }
  const jwt = extractJwt(parsed.data.token);
  if (!jwt) {
    res.status(400).json({ error: "no JWT found in the provided string" });
    return;
  }
  // Extract region from JWT and store it before validation so plaudFetch
  // hits the correct regional API endpoint. If validation discovers a
  // different region (via Plaud's -302 redirect), that takes precedence.
  const { email: jwtEmail, exp, region: jwtRegion } = parseJwt(jwt);
  if (jwtRegion) updateConfig({ plaudRegion: jwtRegion });

  const v = await validateToken(jwt);
  if (!v.ok) {
    res.status(400).json({ ok: false, error: v.error });
    return;
  }
  // Use the region that actually worked, not necessarily the JWT claim.
  const effectiveRegion = v.resolvedRegion ?? loadConfig().plaudRegion ?? jwtRegion;
  // Prefer client-provided email (comes from LevelDB scan in the detect flow);
  // fall back to anything the JWT itself carries.
  const email = parsed.data.email ?? jwtEmail ?? null;
  updateConfig({ token: jwt, tokenExp: exp, tokenEmail: email, plaudRegion: effectiveRegion });
  res.json({ ok: true, email, exp });
});

authRouter.post("/validate", async (req, res) => {
  const parsed = AcceptSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "invalid body" });
    return;
  }
  const jwt = extractJwt(parsed.data.token);
  if (!jwt) {
    res.json({ ok: false, error: "no JWT found" });
    return;
  }
  res.json(await validateToken(jwt));
});

authRouter.post("/watch", async (_req, res) => {
  try {
    const id = await startBrowserWatch(true);
    res.json({ watchId: id });
  } catch (err) {
    logger.error({ err }, "failed to start browser watch");
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

authRouter.get("/watch/:id/events", (req, res) => {
  const id = req.params.id;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data: unknown): void => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  send({ type: "subscribed" });

  const unsub = subscribeWatch(id, (e) => {
    send(e);
    if (e.type === "found") {
      // Persist the found token immediately so the UI can advance.
      // Note: the JWT region claim may not match the user's actual region
      // (Plaud can migrate accounts). The first sync or validate call
      // will auto-correct via the -302 redirect handler.
      const t = e.token;
      const { email, exp, region } = parseJwt(t.token);
      updateConfig({
        token: t.token,
        tokenExp: exp,
        tokenEmail: email ?? t.email,
        plaudRegion: region,
      });
    }
  });

  if (!unsub) {
    send({ type: "error", message: "watch id not found" });
    res.end();
    return;
  }

  req.on("close", () => {
    unsub();
    res.end();
  });
});
