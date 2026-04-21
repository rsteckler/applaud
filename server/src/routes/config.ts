import { Router } from "express";
import { z } from "zod";
import {
  existsSync,
  mkdirSync,
  accessSync,
  constants,
  statfsSync,
} from "node:fs";
import path from "node:path";
import { loadConfig, updateConfig } from "../config.js";
import { testWebhook } from "../webhook/post.js";
import { poller } from "../sync/poller.js";
import { clearSyncIgnore } from "../sync/state.js";

export const configRouter = Router();

const SECRET_REDACTED = "***REDACTED***";

function redactConfig(cfg: ReturnType<typeof loadConfig>): ReturnType<typeof loadConfig> {
  return {
    ...cfg,
    token: cfg.token ? SECRET_REDACTED : null,
    webhook: cfg.webhook
      ? { ...cfg.webhook, ...(cfg.webhook.secret ? { secret: SECRET_REDACTED } : {}) }
      : cfg.webhook,
  };
}

configRouter.get("/", (_req, res) => {
  res.json({ config: redactConfig(loadConfig()) });
});

const PatchSchema = z.object({
  recordingsDir: z.string().min(1).optional(),
  webhook: z
    .object({
      url: z.string().url().or(z.literal("")),
      enabled: z.boolean().optional(),
      secret: z.string().optional(),
    })
    .nullable()
    .optional(),
  pollIntervalMinutes: z.number().int().min(1).max(120).optional(),
  bind: z
    .object({
      host: z.string(),
      port: z.number().int().min(1).max(65535),
    })
    .optional(),
  importPlaudDeleted: z.boolean().optional(),
});

configRouter.post("/", (req, res) => {
  const parsed = PatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const patch = parsed.data;
  const prev = loadConfig();
  const prevImportPlaudDeleted = prev.importPlaudDeleted;
  const normalized = {
    ...patch,
    webhook: patch.webhook
      ? {
          url: patch.webhook.url,
          enabled: patch.webhook.enabled ?? patch.webhook.url.length > 0,
          ...(patch.webhook.secret === undefined
            ? prev.webhook?.secret
              ? { secret: prev.webhook.secret }
              : {}
            : patch.webhook.secret === SECRET_REDACTED
              ? prev.webhook?.secret
                ? { secret: prev.webhook.secret }
                : {}
              : patch.webhook.secret.length > 0
                ? { secret: patch.webhook.secret }
                : {}),
        }
      : patch.webhook,
  };
  const next = updateConfig(normalized);
  if (patch.importPlaudDeleted === true && !prevImportPlaudDeleted) {
    void poller.trigger();
  }
  res.json({ config: redactConfig(next) });
});

const TestWebhookSchema = z.object({ url: z.string().url() });

configRouter.post("/test-webhook", async (req, res) => {
  const parsed = TestWebhookSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "invalid URL" });
    return;
  }
  const result = await testWebhook(parsed.data.url);
  res.json(result);
});

const ValidateDirSchema = z.object({ path: z.string().min(1) });

configRouter.post("/validate-recordings-dir", (req, res) => {
  const parsed = ValidateDirSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "invalid body" });
    return;
  }
  const p = path.resolve(parsed.data.path);
  try {
    const exists = existsSync(p);
    if (!exists) {
      try {
        mkdirSync(p, { recursive: true });
      } catch (err) {
        res.json({
          ok: false,
          absolutePath: p,
          exists: false,
          error: `cannot create: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
    }
    try {
      accessSync(p, constants.W_OK);
    } catch {
      res.json({ ok: false, absolutePath: p, exists: true, writable: false, error: "not writable" });
      return;
    }
    let freeBytes: number | undefined;
    try {
      const st = statfsSync(p);
      freeBytes = Number(st.bavail) * Number(st.bsize);
    } catch {
      /* ignore */
    }
    res.json({ ok: true, absolutePath: p, exists: true, writable: true, freeBytes });
  } catch (err) {
    res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

const CompleteSchema = z.object({});

configRouter.post("/clear-sync-ignore", (_req, res) => {
  const cleared = clearSyncIgnore();
  void poller.trigger();
  res.json({ ok: true, cleared });
});

configRouter.post("/complete-setup", (req, res) => {
  const parsed = CompleteSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid body" });
    return;
  }
  const cfg = loadConfig();
  if (!cfg.token) {
    res.status(400).json({ error: "no token configured" });
    return;
  }
  if (!cfg.recordingsDir) {
    res.status(400).json({ error: "recordingsDir not set" });
    return;
  }
  updateConfig({ setupComplete: true });
  poller.start();
  res.json({ ok: true });
});
