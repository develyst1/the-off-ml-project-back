import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { analyticsRoutes } from "./routes/analytics";
import { automationRoutes } from "./routes/automation";
import { caseRoutes } from "./routes/cases";
import { confidenceRoutes } from "./routes/confidence";
import { healthRoutes } from "./routes/health";
import { integrationRoutes } from "./routes/integrations";
import { inboxRoutes } from "./routes/inbox";
import { maintenanceRoutes } from "./routes/maintenance";
import { realtimeRoutes } from "./routes/realtime";
import { lineWebhookRoutes } from "./routes/webhooks-line";
import { teamsWebhookRoutes } from "./routes/webhooks-teams";

export const app = new Hono();

app.use("*", logger());
app.use("*", cors());

app.route("/health", healthRoutes);
app.route("/cases", caseRoutes);
app.route("/analytics", analyticsRoutes);
app.route("/confidence", confidenceRoutes);
app.route("/automation", automationRoutes);
app.route("/webhooks/line", lineWebhookRoutes);
app.route("/webhooks/teams", teamsWebhookRoutes);
app.route("/integrations", integrationRoutes);
app.route("/inbox", inboxRoutes);
app.route("/realtime", realtimeRoutes);
app.route("/maintenance", maintenanceRoutes);

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError((err, c) => {
  console.error(err);
  return c.json(
    {
      error: "internal_error",
      message: err instanceof Error ? err.message : "Unexpected error",
    },
    500,
  );
});
