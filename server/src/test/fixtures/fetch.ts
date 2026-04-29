import { vi } from "vitest";

export interface QueuedResponse {
  status?: number;
  body?: string;
  /** If set, the mock throws this on the matching call (network error simulation). */
  throws?: unknown;
}

export interface FetchMock {
  /** Vitest mock function installed on globalThis.fetch. */
  fn: ReturnType<typeof vi.fn>;
  /** Captured (url, init) pairs in call order. */
  calls: Array<{ url: string; init?: RequestInit }>;
  /** Push another response onto the FIFO queue. */
  enqueue(r: QueuedResponse): void;
  /** Restore the original fetch and clear queue. */
  restore(): void;
}

/**
 * Install a vitest fetch mock on `globalThis.fetch`. Responses are served
 * FIFO from the enqueued list; if the queue is empty the mock throws so a
 * test bug shows up loudly instead of as a hang or an undefined response.
 */
export function installFetchMock(): FetchMock {
  const queue: QueuedResponse[] = [];
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const original = globalThis.fetch;

  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    calls.push({ url: urlStr, init });
    const next = queue.shift();
    if (!next) {
      throw new Error(`fetch mock queue exhausted (call ${calls.length} to ${urlStr})`);
    }
    if (next.throws !== undefined) throw next.throws;
    const status = next.status ?? 200;
    const body = next.body ?? "";
    return new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    });
  });

  globalThis.fetch = fn as unknown as typeof globalThis.fetch;

  return {
    fn,
    calls,
    enqueue: (r) => queue.push(r),
    restore: () => {
      globalThis.fetch = original;
      queue.length = 0;
      calls.length = 0;
    },
  };
}
