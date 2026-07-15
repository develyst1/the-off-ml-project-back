import { Hono } from "hono";
import { readJsonObject, optionalString, requiredString } from "../lib/request";
import { caseService } from "../services/case-service";

export const teamsWebhookRoutes = new Hono();

teamsWebhookRoutes.post("/", async (c) => {
  const body = await readJsonObject(c);
  const caseId = optionalString(body, "caseId");
  const caseNumberText = optionalString(body, "caseNumber");
  const caseNumber = caseNumberText ? Number(caseNumberText) : undefined;

  if (!caseId && (!caseNumberText || !Number.isInteger(caseNumber))) {
    return c.json({ error: "caseId_or_caseNumber_is_required" }, 400);
  }

  const resolvedCase = caseId
    ? await caseService.getCase(caseId)
    : await caseService.getCaseByNumber(caseNumber as number);

  if (!resolvedCase) {
    return c.json({ error: "case_not_found" }, 404);
  }

  const result = await caseService.receiveTeamsReply({
    caseId: resolvedCase.id,
    text: requiredString(body, "text"),
    externalMessageId: optionalString(body, "eventId"),
  });

  return c.json({ data: result });
});
