import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { caseRoutes } from "./routes/cases";
import { healthRoutes } from "./routes/health";
import { integrationRoutes } from "./routes/integrations";
import { lineWebhookRoutes } from "./routes/webhooks-line";
import { teamsWebhookRoutes } from "./routes/webhooks-teams";

export const app = new Hono();

app.use("*", logger());
app.use("*", cors());

app.route("/health", healthRoutes);
app.route("/cases", caseRoutes);
app.route("/webhooks/line", lineWebhookRoutes);
app.route("/webhooks/teams", teamsWebhookRoutes);
app.route("/integrations", integrationRoutes);

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
