import { Hono } from "hono";
import { readJsonObject, optionalString, requiredString } from "../lib/request";
import { caseService } from "../services/case-service";

export const lineWebhookRoutes = new Hono();

lineWebhookRoutes.post("/", async (c) => {
  const body = await readJsonObject(c);

  const result = await caseService.intakeLineMessage({
    lineUserId: requiredString(body, "lineUserId"),
    displayName: optionalString(body, "displayName"),
    text: requiredString(body, "text"),
    externalMessageId: optionalString(body, "eventId"),
  });

  return c.json({ data: result }, 201);
});
