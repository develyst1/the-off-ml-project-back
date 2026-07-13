import { Hono } from "hono";
import type { CaseStatus } from "../domain/types";
import { readJsonObject, requiredString } from "../lib/request";
import { caseService } from "../services/case-service";

const statuses: CaseStatus[] = [
  "new",
  "analyzing",
  "awaiting_tech",
  "tech_replied",
  "analyzing_solution",
  "resolved",
  "sent_to_customer",
  "closed",
  "awaiting_confirmation",
];

export const caseRoutes = new Hono();

caseRoutes.get("/", async (c) => c.json({ data: await caseService.listCases() }));

caseRoutes.get("/:id", async (c) => {
  const detail = await caseService.getCase(c.req.param("id"));

  if (!detail) {
    return c.json({ error: "case_not_found" }, 404);
  }

  return c.json({ data: detail });
});

caseRoutes.patch("/:id/status", async (c) => {
  const body = await readJsonObject(c);
  const status = requiredString(body, "status");

  if (!statuses.includes(status as CaseStatus)) {
    return c.json({ error: "invalid_status", allowed: statuses }, 400);
  }

  return c.json({ data: await caseService.updateStatus(c.req.param("id"), status as CaseStatus) });
});
