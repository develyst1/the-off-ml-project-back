import { Hono, type Context } from "hono";
import { env } from "../config/env";
import { readJsonObject, optionalString, requiredString } from "../lib/request";
import { caseService } from "../services/case-service";

export const teamsWebhookRoutes = new Hono();

type TeamsAction = "REPLY_CUSTOMER" | "REQUEST_MORE_INFO" | "ACCEPT_CASE" | "CLOSE_CASE";

function normalizeAction(value?: string): TeamsAction | undefined {
  const normalized = value?.trim().toUpperCase().replace(/-/g, "_");
  if (normalized === "REPLY" || normalized === "REPLY_CUSTOMER") return "REPLY_CUSTOMER";
  if (normalized === "REQUEST_INFO" || normalized === "REQUEST_MORE_INFO") return "REQUEST_MORE_INFO";
  if (normalized === "ACCEPT" || normalized === "ACCEPT_CASE") return "ACCEPT_CASE";
  if (normalized === "CLOSE" || normalized === "CLOSE_CASE") return "CLOSE_CASE";
  return undefined;
}

function isAuthorized(c: Context) {
  const secret = env.TEAMS_ACTIONS_SECRET?.trim();
  if (!secret) return env.NODE_ENV !== "production";
  const authorization = c.req.header("authorization");
  const bearer = authorization?.replace(/^Bearer\s+/i, "");
  return bearer === secret || c.req.header("x-teams-actions-secret") === secret;
}

async function handleTeamsAction(c: Context) {
  if (!isAuthorized(c)) {
    return c.json({ success: false, error: "teams_actions_unauthorized" }, env.TEAMS_ACTIONS_SECRET ? 401 : 503);
  }

  const body = await readJsonObject(c);
  const action = normalizeAction(optionalString(body, "action"));
  const caseId = optionalString(body, "caseId");
  const caseNumber = optionalString(body, "caseNumber");
  const replyText = optionalString(body, "replyText");
  const additionalInfoRequest = optionalString(body, "additionalInfoRequest");
  const responderName = optionalString(body, "responderName");
  const requestId = optionalString(body, "requestId")
    ?? c.req.header("x-idempotency-key")
    ?? c.req.header("x-ms-workflow-run-id")
    ?? c.req.header("x-ms-client-tracking-id");

  if (!action) return c.json({ success: false, error: "invalid_action" }, 400);
  if (!caseId) return c.json({ success: false, error: "caseId_is_required" }, 400);

  const detail = await caseService.getCase(caseId);
  if (!detail) return c.json({ success: false, error: "case_not_found" }, 404);
  if (caseNumber && caseNumber !== detail.caseNumber) return c.json({ success: false, error: "case_number_mismatch" }, 400);

  console.info({
    event: "teams_action_received",
    action,
    caseId,
    caseNumber: detail.caseNumber,
    hasReplyText: Boolean(replyText),
    hasLineUserId: Boolean(detail.customer.lineUserId),
    requestId: requestId ?? null,
  });

  if (action === "REPLY_CUSTOMER" || action === "CLOSE_CASE") {
    if (!replyText) return c.json({ success: false, error: "replyText_is_required" }, 400);
    if (!requestId) return c.json({ success: false, error: "requestId_is_required" }, 400);
    try {
      await caseService.sendConsoleReply({
        caseId,
        text: replyText,
        closeCase: action === "CLOSE_CASE",
        closedBy: responderName,
        externalActionId: requestId,
      });
      console.info({ event: "teams_action_line_result", action, caseId, lineApiStatus: "SENT" });
      return c.json({ success: true, message: "Message sent to LINE" });
    } catch (error) {
      console.error({ event: "teams_action_line_result", action, caseId, lineApiStatus: "FAILED", message: String(error) });
      return c.json({ success: false, error: "line_delivery_failed", message: "ไม่สามารถส่งข้อความให้ลูกค้าได้" }, 502);
    }
  }

  if (action === "REQUEST_MORE_INFO") {
    if (!additionalInfoRequest) return c.json({ success: false, error: "additionalInfoRequest_is_required" }, 400);
    await caseService.requestAdditionalInfo(caseId, additionalInfoRequest);
    return c.json({ success: true, message: "Information request sent to LINE" });
  }

  await caseService.acceptCase(caseId);
  return c.json({ success: true, message: "Case accepted" });
}

teamsWebhookRoutes.post("/actions", handleTeamsAction);

teamsWebhookRoutes.post("/", async (c) => {
  const body = await readJsonObject(c);
  const nestedData = body.data && typeof body.data === "object" && !Array.isArray(body.data)
    ? body.data as Record<string, unknown>
    : undefined;
  const action = optionalString(body, "action") ?? (nestedData ? optionalString(nestedData, "action") : undefined);
  const caseId = optionalString(body, "caseId") ?? (nestedData ? optionalString(nestedData, "caseId") : undefined);
  const caseNumberText = optionalString(body, "caseNumber") ?? (nestedData ? optionalString(nestedData, "caseNumber") : undefined);
  const text = optionalString(body, "text")
    ?? optionalString(body, "techReplyText")
    ?? optionalString(body, "requestInfoText")
    ?? (nestedData ? optionalString(nestedData, "text") : undefined)
    ?? (nestedData ? optionalString(nestedData, "techReplyText") : undefined)
    ?? (nestedData ? optionalString(nestedData, "requestInfoText") : undefined);
  const requestInfoText = optionalString(body, "requestInfoText")
    ?? (nestedData ? optionalString(nestedData, "requestInfoText") : undefined);
  const contentTypeValue = optionalString(body, "contentType")
    ?? (nestedData ? optionalString(nestedData, "contentType") : undefined);
  const contentType = contentTypeValue === "IMAGE" || contentTypeValue === "FILE" ? contentTypeValue : "TEXT";

  if (!caseId && !caseNumberText) {
    return c.json({ error: "caseId_or_caseNumber_is_required" }, 400);
  }

  const resolvedCase = caseId
    ? await caseService.getCase(caseId)
    : await caseService.getCaseByNumber(caseNumberText as string);

  if (!resolvedCase) {
    return c.json({ error: "case_not_found" }, 404);
  }

  const result = action === "request-info"
    ? await caseService.requestAdditionalInfo(resolvedCase.id, requestInfoText ?? text ?? requiredString(body, "text"))
    : await caseService.receiveTeamsReply({
        caseId: resolvedCase.id,
        text: text ?? requiredString(body, "text"),
        externalMessageId: optionalString(body, "eventId"),
        contentType,
        attachmentUrl: optionalString(body, "attachmentUrl") ?? (nestedData ? optionalString(nestedData, "attachmentUrl") : undefined),
        closeAfterReply: action === "close",
      });

  return c.json({ data: result });
});
