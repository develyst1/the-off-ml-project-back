import { Hono } from "hono";
import { readJsonObject, optionalString, requiredString } from "../lib/request";
import { caseService } from "../services/case-service";

export const teamsWebhookRoutes = new Hono();

teamsWebhookRoutes.post("/", async (c) => {
  const body = await readJsonObject(c);
  const nestedData = body.data && typeof body.data === "object" && !Array.isArray(body.data)
    ? body.data as Record<string, unknown>
    : undefined;
  const action = optionalString(body, "action") ?? (nestedData ? optionalString(nestedData, "action") : undefined);
  const caseId = optionalString(body, "caseId") ?? (nestedData ? optionalString(nestedData, "caseId") : undefined);
  const caseNumberText = optionalString(body, "caseNumber") ?? (nestedData ? optionalString(nestedData, "caseNumber") : undefined);
  const caseNumber = caseNumberText ? Number(caseNumberText) : undefined;
  const text = optionalString(body, "text")
    ?? optionalString(body, "techReplyText")
    ?? optionalString(body, "requestInfoText")
    ?? (nestedData ? optionalString(nestedData, "text") : undefined)
    ?? (nestedData ? optionalString(nestedData, "techReplyText") : undefined)
    ?? (nestedData ? optionalString(nestedData, "requestInfoText") : undefined);
  const requestInfoText = optionalString(body, "requestInfoText")
    ?? (nestedData ? optionalString(nestedData, "requestInfoText") : undefined);

  if (!caseId && (!caseNumberText || !Number.isInteger(caseNumber))) {
    return c.json({ error: "caseId_or_caseNumber_is_required" }, 400);
  }

  const resolvedCase = caseId
    ? await caseService.getCase(caseId)
    : await caseService.getCaseByNumber(caseNumber as number);

  if (!resolvedCase) {
    return c.json({ error: "case_not_found" }, 404);
  }

  const result = action === "request-info"
    ? await caseService.requestAdditionalInfo(resolvedCase.id, requestInfoText ?? text ?? requiredString(body, "text"))
    : await caseService.receiveTeamsReply({
        caseId: resolvedCase.id,
        text: text ?? requiredString(body, "text"),
        externalMessageId: optionalString(body, "eventId"),
      });

  return c.json({ data: result });
});
