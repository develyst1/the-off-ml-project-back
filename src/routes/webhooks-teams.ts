import { Hono } from "hono";
import { readJsonObject, optionalString, requiredString } from "../lib/request";
import { caseService } from "../services/case-service";

export const teamsWebhookRoutes = new Hono();

teamsWebhookRoutes.post("/", async (c) => {
  const body = await readJsonObject(c);

  const result = await caseService.receiveTeamsReply({
    caseId: requiredString(body, "caseId"),
    text: requiredString(body, "text"),
    externalMessageId: optionalString(body, "eventId"),
  });

  return c.json({ data: result });
});
