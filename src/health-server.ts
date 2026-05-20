/**
 * Minimal HTTP server exposing:
 *   GET /health  — public, returns last run + per-adapter status
 *   POST /run    — admin-token-gated, triggers an immediate scrape
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { runAll, runState } from "./orchestrator.js";
import { getConfig } from "./config.js";
import { logger } from "./logger.js";

function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function getBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString()));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export function startHealthServer(port: number) {
  const config = getConfig();

  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    // GET /health — always public
    if (url === "/health" && method === "GET") {
      const lastRun = runState.lastRun;
      const adapterSummary = lastRun?.adapters.map((a) => ({
        id: a.adapterId,
        status: a.status,
        rows_inserted: a.importResult?.inserted ?? 0,
        error: a.error ?? null,
        duration_ms: a.durationMs,
      })) ?? null;

      send(res, 200, {
        ok: true,
        running: runState.running,
        last_run_at: lastRun?.finishedAt ?? null,
        last_run_duration_ms: lastRun?.durationMs ?? null,
        last_run_inserted: lastRun?.totalInserted ?? null,
        adapters: adapterSummary,
      });
      return;
    }

    // POST /run — admin-gated
    if (url === "/run" && method === "POST") {
      await getBody(req); // drain body
      const authHeader = req.headers["authorization"] ?? "";
      const token = authHeader.replace(/^Bearer\s+/i, "");
      if (token !== config.EZLOOT_IMPORT_TOKEN) {
        send(res, 401, { error: "Unauthorized" });
        return;
      }

      if (runState.running) {
        send(res, 409, { error: "Run already in progress" });
        return;
      }

      logger.info("Manual /run triggered via HTTP");
      // Start in background — respond immediately
      send(res, 202, { ok: true, message: "Run started" });
      runAll().catch((err) =>
        logger.error({ error: String(err) }, "Manual run failed")
      );
      return;
    }

    send(res, 404, { error: "Not found" });
  });

  server.listen(port, () => {
    logger.info({ port }, "Health server listening");
  });

  return server;
}
