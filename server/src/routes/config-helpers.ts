import type { AppConfig } from "@applaud/shared";

export const SECRET_REDACTED = "***REDACTED***";

/**
 * Returns a copy of the config with secret-class fields replaced by the
 * redaction sentinel. Used on the GET response so the browser never sees
 * the real `token` or `webhook.secret`.
 */
export function redactConfig(cfg: AppConfig): AppConfig {
  return {
    ...cfg,
    token: cfg.token ? SECRET_REDACTED : null,
    webhook: cfg.webhook
      ? { ...cfg.webhook, ...(cfg.webhook.secret ? { secret: SECRET_REDACTED } : {}) }
      : cfg.webhook,
  };
}

/**
 * Resolve the webhook secret to persist, given the previously-stored value
 * and the value the client just sent.
 *
 * Truth table (incoming × prev):
 *   undefined   × *      → preserve prev (field omitted from patch)
 *   REDACTED    × *      → preserve prev (UI didn't actually edit the field)
 *   ""          × *      → clear (user explicitly emptied or hit Clear)
 *   non-empty   × *      → store incoming (user typed or generated a value)
 */
export function mergeWebhookSecret(
  prev: string | undefined,
  incoming: string | undefined,
): string | undefined {
  if (incoming === undefined || incoming === SECRET_REDACTED) return prev;
  if (incoming === "") return undefined;
  return incoming;
}
