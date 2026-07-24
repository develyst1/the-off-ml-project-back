import { Hono } from "hono";
import type { CaseStatus } from "../domain/types";
import { readJsonObject, requiredString } from "../lib/request";
import { caseService } from "../services/case-service";
import { categoryKeyOf } from "../lib/category";

const statuses: CaseStatus[] = [
  "new",
  "analyzing",
  "awaiting_tech",
  "assigned",
  "tech_replied",
  "analyzing_solution",
  "resolved",
  "sent_to_customer",
  "closed",
  "reopened",
  "in_progress",
  "awaiting_confirmation",
  "awaiting_customer_info",
  "awaiting_tech_review",
];

export const caseRoutes = new Hono();

const CLOSED_CASE_STATUSES = new Set<CaseStatus>(["resolved", "sent_to_customer", "closed"]);
const SLA_MONITORED_STATUSES = new Set<CaseStatus>([
  "new",
  "analyzing",
  "awaiting_tech",
  "assigned",
  "in_progress",
  "analyzing_solution",
  "awaiting_tech_review",
  "reopened",
]);

function categoryForCase(item: Awaited<ReturnType<typeof caseService.listCases>>[number]) {
  const latestCustomerAnalysis = [...item.analyses]
    .filter((analysis) => analysis.analysisType === "customer_message")
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0];

  return latestCustomerAnalysis?.category ?? item.category;
}

function isSlaBreached(item: Awaited<ReturnType<typeof caseService.listCases>>[number]) {
  if (!SLA_MONITORED_STATUSES.has(item.status)) return false;
  const latestCustomerMessage = [...item.messages]
    .filter((message) => message.senderType === "CUSTOMER")
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0];
  const activityAt = latestCustomerMessage?.receivedAt ?? latestCustomerMessage?.createdAt ?? item.updatedAt;
  const activityTime = new Date(activityAt).getTime();
  return Number.isFinite(activityTime) && Date.now() - activityTime >= 4 * 60 * 60 * 1000;
}

function isClosedThisMonth(item: Awaited<ReturnType<typeof caseService.listCases>>[number]) {
  if (!CLOSED_CASE_STATUSES.has(item.status)) return false;
  const closedAt = item.closedAt ? new Date(item.closedAt) : undefined;
  const now = new Date();
  return Boolean(closedAt && closedAt.getFullYear() === now.getFullYear() && closedAt.getMonth() === now.getMonth());
}

function matchesKpi(item: Awaited<ReturnType<typeof caseService.listCases>>[number], kpi?: string) {
  if (!kpi) return true;
  if (kpi === "waiting-tech") return item.status === "awaiting_tech";
  if (kpi === "awaiting-confirmation") return item.status === "awaiting_confirmation";
  if (kpi === "sla") return isSlaBreached(item);
  if (kpi === "closed-this-month") return isClosedThisMonth(item);
  return true;
}

caseRoutes.get("/", async (c) => {
  const category = c.req.query("category")?.trim();
  const kpi = c.req.query("kpi")?.trim();
  const cases = await caseService.listCases();
  return c.json({ data: cases.filter((item) => (
    (!category || categoryKeyOf(categoryForCase(item)) === category)
    && matchesKpi(item, kpi)
  )) });
});

caseRoutes.get("/:id/messages", async (c) => {
  const detail = await caseService.getCase(c.req.param("id"));
  if (!detail) return c.json({ error: "case_not_found" }, 404);
  return c.json({ data: detail.messages });
});

caseRoutes.get("/:id", async (c) => {
  const detail = await caseService.getCase(c.req.param("id"));

  if (!detail) {
    return c.json({ error: "case_not_found" }, 404);
  }

  return c.json({ data: detail });
});

caseRoutes.post("/:id/accept", async (c) => {
  return c.json({ data: await caseService.acceptCase(c.req.param("id")) });
});

caseRoutes.post("/:id/request-info", async (c) => {
  const body = await readJsonObject(c);
  const text = requiredString(body, "text");
  const sourceMessageId = typeof body.sourceMessageId === "string" && body.sourceMessageId.trim()
    ? body.sourceMessageId.trim()
    : undefined;

  return c.json({ data: await caseService.requestAdditionalInfo(c.req.param("id"), text, sourceMessageId) });
});

caseRoutes.post("/:id/rewrite-request-info", async (c) => {
  const body = await readJsonObject(c);
  try {
    return c.json({ data: await caseService.rewriteAdditionalInfoRequest(c.req.param("id"), requiredString(body, "text")) });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "AI ไม่สามารถเรียบเรียงข้อความได้ในขณะนี้" }, 503);
  }
});

caseRoutes.post("/:id/reply", async (c) => {
  const body = await readJsonObject(c);
  return c.json({ data: await caseService.sendConsoleReply({ caseId: c.req.param("id"), text: requiredString(body, "text") }) });
});

caseRoutes.post("/:id/generate-more-info", async (c) => {
  const body = await readJsonObject(c);
  const requestedInformation = typeof body.requestedInformation === "string" ? body.requestedInformation : undefined;
  return c.json({ data: await caseService.generateMoreInfoRequest(c.req.param("id"), requestedInformation) });
});

caseRoutes.post("/:id/ai-compose", async (c) => {
  const body = await readJsonObject(c);
  const mode = body.mode === "REQUEST_MORE_INFO" ? "REQUEST_MORE_INFO" : body.mode === "CUSTOMER_REPLY" ? "CUSTOMER_REPLY" : undefined;
  if (!mode) return c.json({ error: "mode_must_be_CUSTOMER_REPLY_or_REQUEST_MORE_INFO" }, 400);
  const supportInstruction = typeof body.supportInstruction === "string" ? body.supportInstruction : undefined;
  const requestedInformation = typeof body.requestedInformation === "string" ? body.requestedInformation : undefined;
  try {
    return c.json({ data: await caseService.composeAiMessage({ caseId: c.req.param("id"), mode, supportInstruction, requestedInformation }) });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "AI ไม่สามารถสร้างร่างข้อความได้ในขณะนี้" }, 422);
  }
});

caseRoutes.post("/:id/close", async (c) => {
  const body = await readJsonObject(c);
  return c.json({ data: await caseService.sendConsoleReply({
    caseId: c.req.param("id"),
    text: requiredString(body, "text"),
    closeCase: true,
    closedBy: typeof body.closedBy === "string" && body.closedBy.trim() ? body.closedBy.trim() : undefined,
    closedWithoutTechConfirmation: body.closedWithoutTechConfirmation === true,
    closeSummary: body.closeSummary && typeof body.closeSummary === "object"
      && typeof (body.closeSummary as Record<string, unknown>).cause === "string"
      && typeof (body.closeSummary as Record<string, unknown>).resolution === "string"
      && typeof (body.closeSummary as Record<string, unknown>).prevention === "string"
      ? {
        cause: (body.closeSummary as Record<string, string>).cause,
        resolution: (body.closeSummary as Record<string, string>).resolution,
        prevention: (body.closeSummary as Record<string, string>).prevention,
      }
      : undefined,
  }) });
});

caseRoutes.post("/:id/rewrite-reply", async (c) => {
  const body = await readJsonObject(c);
  const mode = body.mode === "CLOSING_REPLY" ? "CLOSING_REPLY" : "NORMAL_REPLY";
  return c.json({ data: await caseService.rewriteCustomerReply(c.req.param("id"), requiredString(body, "text"), mode) });
});

caseRoutes.post("/:id/reopen", async (c) => {
  const body = await readJsonObject(c);
  return c.json({ data: await caseService.reopenCaseFromConsole(
    c.req.param("id"),
    typeof body.reopenedBy === "string" && body.reopenedBy.trim() ? body.reopenedBy.trim() : undefined,
    typeof body.reopenReason === "string" && body.reopenReason.trim() ? body.reopenReason.trim() : undefined,
  ) });
});

caseRoutes.patch("/:id/status", async (c) => {
  const body = await readJsonObject(c);
  const status = requiredString(body, "status");

  if (!statuses.includes(status as CaseStatus)) {
    return c.json({ error: "invalid_status", allowed: statuses }, 400);
  }

  return c.json({ data: await caseService.updateStatus(c.req.param("id"), status as CaseStatus) });
});
