import { Hono } from "hono";
import { readJsonObject, requiredString } from "../lib/request";
import { store } from "../repositories/store";
import { caseService } from "../services/case-service";

export const confidenceRoutes = new Hono();

confidenceRoutes.get("/suggestions", async (c) => {
  const cases = await caseService.listCases();
  const suggestions = cases
    .filter((item) => (item.confidenceReviewStatus ?? "PENDING") === "PENDING")
    .filter((item) => item.status === "awaiting_confirmation" || (item.confidenceScore ?? 0) >= 90)
    .map((item) => {
      const customerMessage = item.messages.find((message) => message.senderType === "CUSTOMER");
      const latestSolution = item.solutions.at(-1);

      return {
        id: `match_${item.id}`,
        caseId: item.id,
        caseNumber: item.caseNumber,
        customerName: item.customer.displayName ?? "ลูกค้า LINE",
        suggestedSolutionId: latestSolution?.id ?? "-",
        category: item.category ?? "-",
        originalText: customerMessage?.originalText ?? "",
        solutionText: latestSolution?.solutionSteps.join("\n") || latestSolution?.rewrittenCustomerText || "ยังไม่มี solution ที่ยืนยันแล้ว",
        caseUnderstandingConfidence: item.confidenceScore ?? 0,
        caseDiscriminationConfidence: latestSolution?.confidence ?? item.confidenceScore ?? 0,
      };
    });

  return c.json({ data: suggestions });
});

confidenceRoutes.post("/suggestions/:id/review", async (c) => {
  const body = await readJsonObject(c);
  const caseId = requiredString(body, "caseId");
  const result = requiredString(body, "result");

  if (result !== "approved" && result !== "rejected") {
    return c.json({ error: "invalid_result", allowed: ["approved", "rejected"] }, 400);
  }

  const status = result === "approved" ? "resolved" : "awaiting_tech";
  const reviewed = await store.updateCase(caseId, {
    status,
    confidenceReviewStatus: result === "approved" ? "APPROVED" : "REJECTED",
    confidenceReviewedAt: new Date().toISOString(),
    confidenceReviewedBy: "Tech Support Console",
  });
  return c.json({ data: { id: c.req.param("id"), caseId, result, case: reviewed } });
});
