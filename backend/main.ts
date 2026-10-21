// HTTP server: API + the static dashboard from ./frontend.
//   deno task dev      (watch mode)
//   deno task start
// Scheduling:
//   - On Deno Deploy (DENO_DEPLOYMENT_ID is set), register Deno.cron() to tick
//     every minute. Zoho→Supabase sync, event retries and monitoring all run
//     without an admin pressing "Sync now".
//   - Locally, set RUN_WORKER_INLINE=true to start the setInterval-based worker
//     in this process. (Deno.cron doesn't fire in dev reliably.)
import { getConfig } from "./config.ts";
import { buildApp } from "./app.ts";
import { log } from "./lib/log.ts";
import { startWorker, tick } from "./worker.ts";

const cfg = getConfig();
const app = buildApp({ staticRoot: "./frontend" });

const onDenoDeploy = Deno.env.get("DENO_DEPLOYMENT_ID") !== undefined;
if (onDenoDeploy && typeof (Deno as unknown as { cron?: unknown }).cron === "function") {
  // Every minute. tick() has its own guard against overlapping runs and only
  // fires the periodic sync once per SYNC_INTERVAL_MINUTES (default 15 min).
  (Deno as unknown as { cron: (n: string, s: string, h: () => Promise<void>) => void }).cron(
    "mdm-worker-tick",
    "* * * * *",
    async () => {
      try { await tick(); } catch (e) { log("error", "cron.tick_failed", { error: String(e) }); }
    },
  );
  log("info", "cron.registered", { schedule: "* * * * *", sync_every_min: cfg.syncIntervalMinutes });
} else if (Deno.env.get("RUN_WORKER_INLINE") === "true") {
  startWorker();
}

Deno.serve({ port: cfg.port, onListen: ({ port }) => log("info", "server.listening", { port, env: cfg.env }) }, app.fetch);
