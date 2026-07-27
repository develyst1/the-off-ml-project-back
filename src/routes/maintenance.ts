import { Hono } from "hono";
import { env } from "../config/env";
import { readJsonObject } from "../lib/request";
import { chatRetentionService } from "../services/chat-retention-service";

function isAuthorized(authorization: string | undefined, secret: string | undefined) {
  const expected = secret?.trim();
  if (!expected) return false;
  return authorization?.replace(/^Bearer\s+/i, "") === expected;
}

export const maintenanceRoutes = new Hono();

maintenanceRoutes.post("/chat-retention", async (c) => {
  if (!env.CHAT_RETENTION_SECRET?.trim()) {
    return c.json({ error: "chat_retention_secret_not_configured" }, 503);
  }
  if (!isAuthorized(c.req.header("authorization") ?? c.req.header("x-chat-retention-secret"), env.CHAT_RETENTION_SECRET)) {
    return c.json({ error: "chat_retention_unauthorized" }, 401);
  }

  const body = await readJsonObject(c);
  const dryRun = body.dryRun !== false;
  const batchSize = typeof body.batchSize === "number" ? body.batchSize : undefined;
  return c.json({ data: await chatRetentionService.deleteExpiredRawMessages({ dryRun, batchSize }) });
});
