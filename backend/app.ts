// Builds the Hono app (kept separate from main.ts so tests can import it without listening).
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { serveStatic } from "hono/deno";
import { errorBody, toAppError } from "./lib/errors.ts";
import { log } from "./lib/log.ts";
import { type AppEnv, csrfGuard, rateLimit } from "./middleware/auth.ts";
import { adminRoutes, authRoutes } from "./routes/auth.ts";
import { zohoRoutes } from "./routes/zoho.ts";
import { commandRoutes, deviceRoutes } from "./routes/devices.ts";
import { groupRoutes } from "./routes/groups.ts";
import { appRoutes, profileRoutes } from "./routes/profiles.ts";
import { announcementRoutes } from "./routes/announcements.ts";
import { eventRoutes, overviewRoutes } from "./routes/events.ts";
import { alertRoutes, locationRoutes, monitoringRoutes } from "./routes/monitoring.ts";
import { fineractWebhookRoutes } from "./routes/fineract.ts";
import { automationRoutes } from "./routes/automation.ts";

// Importing the services registers their executors.
import "./services/commands.ts";
import "./services/groups.ts";
import "./services/profiles.ts";
import "./services/apps.ts";
import "./services/announcements.ts";

export function buildApp(opts: { staticRoot?: string } = {}) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const id = crypto.randomUUID();
    c.set("requestId", id);
    const t = performance.now();
    await next();
    c.header("x-request-id", id);
    if (c.req.path.startsWith("/api")) {
      log("info", "http", { id, method: c.req.method, path: c.req.path, status: c.res.status, ms: Math.round(performance.now() - t) });
    }
  });

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        // unpkg: Leaflet library (map on the Locations page).
        scriptSrc: ["'self'", "https://unpkg.com"],
        // 'unsafe-inline' is needed by Leaflet, which positions tiles via inline style="" attributes.
        styleSrc: ["'self'", "https://unpkg.com", "'unsafe-inline'"],
        // OpenStreetMap tile servers (a/b/c subdomains).
        imgSrc: ["'self'", "data:", "blob:", "https://*.tile.openstreetmap.org"],
        // unpkg: Leaflet fetches its own sourcemap when DevTools is open.
        connectSrc: ["'self'", "https://unpkg.com"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
      },
      referrerPolicy: "same-origin",
    }),
  );

  // CSRF guard on /api/*, except the Fineract webhook — that endpoint is called
  // server-to-server by Fineract and is authenticated by HMAC on the raw body
  // (see routes/fineract.ts). Rate-limiting still applies.
  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/fineract/hooks") return next();
    return csrfGuard(c, next);
  }, rateLimit({ name: "api", windowMs: 60_000, max: 300 }));
  app.use("/api/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  app.get("/api/health", (c) => c.json({ ok: true, time: new Date().toISOString() }));
  app.route("/api/auth", authRoutes());
  app.route("/api/admins", adminRoutes());
  app.route("/api/zoho", zohoRoutes());
  app.route("/api/devices", deviceRoutes());
  app.route("/api/commands", commandRoutes());
  app.route("/api/groups", groupRoutes());
  app.route("/api/profiles", profileRoutes());
  app.route("/api/apps", appRoutes());
  app.route("/api/announcements", announcementRoutes());
  app.route("/api/events", eventRoutes());
  app.route("/api/monitoring", monitoringRoutes());
  app.route("/api/alerts", alertRoutes());
  app.route("/api/locations", locationRoutes());
  app.route("/api/fineract", fineractWebhookRoutes());
  app.route("/api/automation", automationRoutes());
  app.route("/api", overviewRoutes());

  app.notFound((c) => (c.req.path.startsWith("/api")
    ? c.json({ error: { code: "NOT_FOUND", message: "No such endpoint" } }, 404)
    : c.text("Not found", 404)));

  app.onError((e, c) => {
    const err = toAppError(e);
    if (err.status >= 500) log("error", "http.error", { id: c.get("requestId"), code: err.code, message: err.message, stack: e.stack });
    return c.json(errorBody(err), err.status as 400);
  });

  if (opts.staticRoot) {
    // Re-check the console's JS/CSS on every load so updates show without a hard refresh.
    app.use("/*", async (c, next) => {
      await next();
      if (!c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-cache");
    });
    app.use("/*", serveStatic({ root: opts.staticRoot }));
    app.get("*", serveStatic({ path: `${opts.staticRoot}/index.html` }));
  }
  return app;
}
