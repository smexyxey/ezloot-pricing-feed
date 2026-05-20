import type { HttpClient } from "../adapters/types.js";

const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

/** Sleep for ms milliseconds. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Basic HttpClient with exponential-backoff retry.
 * Retries on network errors and 429/503 responses.
 * Swap this out in AdapterContext to route through a proxy (v2).
 */
export function createHttpClient(opts: {
  maxRetries?: number;
  baseDelayMs?: number;
}): HttpClient {
  const { maxRetries = 3, baseDelayMs = 1000 } = opts;

  return {
    async fetch(url: string, init?: RequestInit): Promise<Response> {
      const headers = {
        ...DEFAULT_HEADERS,
        ...(init?.headers as Record<string, string> | undefined),
      };

      let attempt = 0;
      while (true) {
        attempt++;
        try {
          const res = await fetch(url, { ...init, headers });
          if (res.ok) return res;

          // Retryable HTTP errors
          if ((res.status === 429 || res.status === 503) && attempt <= maxRetries) {
            const delay = baseDelayMs * 2 ** (attempt - 1);
            await sleep(delay);
            continue;
          }

          // Non-retryable or exhausted retries
          throw new Error(`HTTP ${res.status} from ${url}`);
        } catch (err) {
          if (attempt > maxRetries) throw err;
          const delay = baseDelayMs * 2 ** (attempt - 1);
          await sleep(delay);
        }
      }
    },
  };
}
