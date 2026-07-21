import { Hono } from "hono";
import { readJsonObject, requiredString } from "../lib/request";
import { store } from "../repositories/store";
import { caseService } from "../services/case-service";
import { hasActionableSolutionSteps } from "../lib/solution-quality";

export const confidenceRoutes = new Hono();

type ReviewStage = "QUALITY" | "AUTO_ANSWER";

function getReviewStage(caseConfidence: number, solutionConfidence?: number): ReviewStage {
  return caseConfidence >= 98 && (solutionConfidence ?? 0) >= 98 ? "AUTO_ANSWER" : "QUALITY";
}

confidenceRoutes.get("/suggestions", async (c) => {
  const cases = await caseService.listCases();
  const suggestions = cases
    .flatMap((item) => {
      const customerMessage = item.messages.find((message) => message.senderType === "CUSTOMER");
      const latestSolution = [...item.solutions].reverse().find((solution) => hasActionableSolutionSteps(solution.solutionSteps));
      const caseConfidence = item.confidenceScore ?? 0;
      const solutionConfidence = latestSolution?.confidence ?? caseConfidence;
      const reviewStage = getReviewStage(caseConfidence, latestSolution?.confidence);
      const needsQualityReview = reviewStage === "QUALITY"
        && caseConfidence >= 90
        && (item.confidenceReviewStatus ?? "PENDING") === "PENDING";
      const needsAutoAnswerReview = reviewStage === "AUTO_ANSWER"
        && latestSolution?.autoAnswerReviewResult === undefined;

      if (!latestSolution || (!needsQualityReview && !needsAutoAnswerReview)) return [];

      return [{
        id: `match_${item.id}`,
        caseId: item.id,
        caseNumber: item.caseNumber,
        customerName: item.customer.displayName ?? "ลูกค้า LINE",
        suggestedSolutionId: latestSolution.id,
        category: item.category ?? "-",
        originalText: customerMessage?.originalText ?? "",
        solutionText: latestSolution.solutionSteps.join("\n"),
        caseUnderstandingConfidence: caseConfidence,
        caseDiscriminationConfidence: solutionConfidence,
        reviewStage,
        reviewHint: reviewStage === "AUTO_ANSWER"
          ? "ผ่านเกณฑ์คะแนนแล้ว รออนุมัติให้ตอบอัตโนมัติ"
          : "ใช้เพื่อตรวจคุณภาพ AI เท่านั้น ยังไม่เปิดตอบอัตโนมัติ",
      }];
    });

  return c.json({ data: suggestions });
});

confidenceRoutes.post("/suggestions/:id/review", async (c) => {
  const body = await readJsonObject(c);
  const caseId = requiredString(body, "caseId");
  const result = requiredString(body, "result");
  const solutionId = typeof body.solutionId === "string" && body.solutionId.trim() ? body.solutionId.trim() : undefined;
  const requestedStage = body.reviewStage === "QUALITY" || body.reviewStage === "AUTO_ANSWER" ? body.reviewStage : undefined;

  if (result !== "approved" && result !== "rejected") {
    return c.json({ error: "invalid_result", allowed: ["approved", "rejected"] }, 400);
  }

  const detail = await caseService.getCase(caseId);
  if (!detail) return c.json({ error: "case_not_found" }, 404);

  const suggestedSolution = solutionId
    ? detail.solutions.find((solution) => solution.id === solutionId)
    : undefined;
  const reviewStage = getReviewStage(detail.confidenceScore ?? 0, suggestedSolution?.confidence);
  if (requestedStage && requestedStage !== reviewStage) {
    return c.json({ error: "review_stage_changed", message: "คะแนนของเคสเปลี่ยน กรุณารีเฟรชรายการก่อนยืนยัน" }, 409);
  }

  if (reviewStage === "AUTO_ANSWER" && !suggestedSolution) {
    return c.json({ error: "solution_not_found", message: "ยังไม่มีวิธีแก้ที่พร้อมให้อนุมัติ Auto-answer" }, 400);
  }

  const reviewedAt = new Date().toISOString();
  if (reviewStage === "AUTO_ANSWER" && suggestedSolution) {
    await store.updateSolution(suggestedSolution.id, {
      validatedByTeam: result === "approved",
      validatedAt: result === "approved" ? reviewedAt : undefined,
      validatedBy: result === "approved" ? "Tech Support Console" : undefined,
      autoAnswerReviewResult: result === "approved" ? "APPROVED" : "REJECTED",
      autoAnswerReviewedAt: reviewedAt,
      autoAnswerReviewedBy: "Tech Support Console",
    });
  }

  const reviewed = await store.updateCase(caseId, {
    confidenceReviewStatus: reviewStage === "AUTO_ANSWER"
      ? result === "approved" ? "AUTO_ANSWER_APPROVED" : "AUTO_ANSWER_REJECTED"
      : result === "approved" ? "QUALITY_APPROVED" : "QUALITY_REJECTED",
    confidenceReviewedAt: reviewedAt,
    confidenceReviewedBy: "Tech Support Console",
  });
  return c.json({ data: { id: c.req.param("id"), caseId, result, reviewStage, solutionId: suggestedSolution?.id, case: reviewed } });
});
