import { Hono } from "hono";
import type { CaseStatus } from "../domain/types";
import { readJsonObject, requiredString } from "../lib/request";
import { caseService } from "../services/case-service";

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

caseRoutes.get("/", async (c) => c.json({ data: await caseService.listCases() }));

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

  return c.json({
    data: await caseService.receiveTeamsReply({
      caseId: c.req.param("id"),
      text: requiredString(body, "text"),
      channel: "system",
    }),
  });
});

caseRoutes.post("/:id/close", async (c) => {
  const body = await readJsonObject(c);
  return c.json({
    data: await caseService.receiveTeamsReply({
      caseId: c.req.param("id"),
      text: requiredString(body, "text"),
      channel: "system",
      closeAfterReply: true,
    }),
  });
});

caseRoutes.patch("/:id/status", async (c) => {
  const body = await readJsonObject(c);
  const status = requiredString(body, "status");

  if (!statuses.includes(status as CaseStatus)) {
    return c.json({ error: "invalid_status", allowed: statuses }, 400);
  }

  return c.json({ data: await caseService.updateStatus(c.req.param("id"), status as CaseStatus) });
});
