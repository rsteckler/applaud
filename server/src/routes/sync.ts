import { Router } from "express";
import { poller } from "../sync/poller.js";
import { syncEvents } from "../sync/events.js";
import { countPendingAssets, countErrorsLast24h } from "../sync/state.js";
import type { SyncStatusResponse } from "@applaud/shared";

export const syncRouter = Router();

syncRouter.get("/status", (_req, res) => {
  const s = poller.status();
  const resp: SyncStatusResponse = {
    lastPollAt: s.lastPollAt,
    nextPollAt: s.nextPollAt,
    polling: s.polling,
    pendingTranscripts: countPendingAssets(),
    errorsLast24h: countErrorsLast24h(),
    lastError: s.lastError,
    authRequired: s.authRequired,
  };
  res.json(resp);
});

syncRouter.post("/trigger", async (_req, res) => {
  await poller.trigger();
  res.json({ ok: true });
});

syncRouter.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (payload: unknown): void => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  send({ type: "subscribed" });

  const unsub = syncEvents.onEvent(send);
  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 15_000);
  req.on("close", () => {
    unsub();
    clearInterval(heartbeat);
    res.end();
  });
});
