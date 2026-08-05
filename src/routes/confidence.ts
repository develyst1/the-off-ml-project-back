import { Hono } from "hono";
import { readJsonObject, requiredString } from "../lib/request";
import { store } from "../repositories/store";
import { caseService } from "../services/case-service";
import { hasActionableSolutionSteps } from "../lib/solution-quality";
import { saveAiReviewFeedback } from "../services/ai-review-feedback-service";

export const confidenceRoutes = new Hono();

type ReviewStage = "QUALITY" | "AUTO_ANSWER";
type FeedbackResult = "CORRECT" | "INCORRECT";

function getReviewStage(caseConfidence: number, solutionConfidence?: number): ReviewStage {
  return caseConfidence >= 98 && (solutionConfidence ?? 0) >= 98 ? "AUTO_ANSWER" : "QUALITY";
}

function getFeedbackResult(value: unknown): FeedbackResult | undefined {
  return value === "CORRECT" || value === "INCORRECT" ? value : undefined;
}

confidenceRoutes.get("/suggestions", async (c) => {
  const cases = await caseService.listCases();
  const suggestions = cases
    .flatMap((item) => {
      const customerMessage = item.messages.find((message) => message.senderType === "CUSTOMER");
      const latestSolution = [...item.solutions].reverse().find((solution) => hasActionableSolutionSteps(solution.solutionSteps));
      const currentAnalysis = [...item.analyses]
        .sort((left, right) => right.analysisVersion - left.analysisVersion || new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0];
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
        customerName: item.customer.displayName ?? "ผู้ใช้งาน LINE",
        suggestedSolutionId: latestSolution.id,
        category: item.category ?? "-",
        originalText: customerMessage?.originalText ?? "",
        solutionText: latestSolution.solutionSteps.join("\n"),
        caseUnderstandingConfidence: caseConfidence,
        caseDiscriminationConfidence: solutionConfidence,
        analysisId: currentAnalysis?.analysisId,
        analysisVersion: currentAnalysis?.analysisVersion,
        hasSuggestedSolution: Boolean(latestSolution),
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

  const hasCentralFeedbackPayload = body.analysisVersion !== undefined
    || body.understandingResult !== undefined
    || body.solutionResult !== undefined;

  if (hasCentralFeedbackPayload) {
    const analysisVersion = body.analysisVersion;
    const analysisId = typeof body.analysisId === "string" && body.analysisId.trim()
      ? body.analysisId.trim()
      : undefined;
    const understandingResult = getFeedbackResult(body.understandingResult);
    const solutionResult = getFeedbackResult(body.solutionResult);
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : undefined;

    if (typeof analysisVersion !== "number" || !Number.isInteger(analysisVersion) || analysisVersion < 1) {
      return c.json({ error: "invalid_analysis_version" }, 400);
    }
    if (!understandingResult && !solutionResult) {
      return c.json({ error: "feedback_result_is_required" }, 400);
    }
    if ((body.understandingResult !== undefined && !understandingResult)
      || (body.solutionResult !== undefined && !solutionResult)) {
      return c.json({ error: "invalid_feedback_result", allowed: ["CORRECT", "INCORRECT"] }, 400);
    }

    const detail = await caseService.getCase(caseId);
    if (!detail) return c.json({ error: "case_not_found" }, 404);

    const matchingAnalysis = detail.analyses.find((analysis) => (
      analysis.analysisVersion === analysisVersion
      && (!analysisId || analysis.analysisId === analysisId)
    ));
    if (!matchingAnalysis) {
      return c.json({ error: "analysis_not_found_for_case_version" }, 400);
    }

    const feedback = await Promise.all([
      understandingResult
        ? saveAiReviewFeedback({
          caseId,
          analysisId: matchingAnalysis.analysisId,
          analysisVersion,
          feedbackType: "ISSUE_UNDERSTANDING",
          result: understandingResult,
          reviewSource: "CONFIDENCE_REVIEW",
          reason,
          reviewedBy: "Tech Support Console",
        })
        : undefined,
      solutionResult
        ? saveAiReviewFeedback({
          caseId,
          analysisId: matchingAnalysis.analysisId,
          analysisVersion,
          feedbackType: "SOLUTION_SELECTION",
          result: solutionResult,
          reviewSource: "CONFIDENCE_REVIEW",
          reason,
          reviewedBy: "Tech Support Console",
        })
        : undefined,
    ]);
    const savedFeedback = feedback.filter((item): item is NonNullable<typeof item> => Boolean(item));
    const reviewedAt = new Date().toISOString();
    const confidenceReviewStatus = understandingResult === "INCORRECT" || solutionResult === "INCORRECT"
      ? "QUALITY_REJECTED"
      : understandingResult === "CORRECT" && solutionResult === "CORRECT"
        ? "QUALITY_APPROVED"
        : "PENDING";
    const reviewed = await store.updateCase(caseId, {
      confidenceReviewStatus,
      confidenceReviewedAt: reviewedAt,
      confidenceReviewedBy: "Tech Support Console",
    });

    return c.json({
      data: {
        id: c.req.param("id"),
        caseId,
        analysisId: matchingAnalysis.analysisId,
        analysisVersion,
        feedback: savedFeedback,
        case: reviewed,
      },
    });
  }

  const result = requiredString(body, "result");
  const solutionId = typeof body.solutionId === "string" && body.solutionId.trim() ? body.solutionId.trim() : undefined;
  const requestedStage = body.reviewStage === "QUALITY" || body.reviewStage === "AUTO_ANSWER" ? body.reviewStage : undefined;
  const rejectionReason = ["CASE_UNDERSTANDING", "SOLUTION_SELECTION", "INSUFFICIENT_CUSTOMER_INFO", "BETTER_SOLUTION"].includes(body.rejectionReason as string)
    ? body.rejectionReason as "CASE_UNDERSTANDING" | "SOLUTION_SELECTION" | "INSUFFICIENT_CUSTOMER_INFO" | "BETTER_SOLUTION"
    : undefined;
  const additionalExplanation = typeof body.additionalExplanation === "string" ? body.additionalExplanation.trim() : "";
  const correctedSolution = typeof body.correctedSolution === "string" ? body.correctedSolution.trim() : "";

  if (result !== "approved" && result !== "rejected") {
    return c.json({ error: "invalid_result", allowed: ["approved", "rejected"] }, 400);
  }
  if (result === "rejected" && !rejectionReason) {
    return c.json({ error: "rejection_reason_is_required" }, 400);
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

  if (result === "rejected" && suggestedSolution) {
    if (rejectionReason === "SOLUTION_SELECTION") {
      await store.updateSolution(suggestedSolution.id, {
        confidence: Math.max(0, suggestedSolution.confidence - 10),
        validatedByTeam: suggestedSolution.validatedByTeam,
        validatedAt: suggestedSolution.validatedAt,
        validatedBy: suggestedSolution.validatedBy,
        autoAnswerReviewResult: suggestedSolution.autoAnswerReviewResult,
        autoAnswerReviewedAt: suggestedSolution.autoAnswerReviewedAt,
        autoAnswerReviewedBy: suggestedSolution.autoAnswerReviewedBy,
      });
    }
    if (correctedSolution) {
      await store.createSolution({
        caseId,
        rawReplyText: correctedSolution,
        solutionSteps: correctedSolution.split(/\r?\n/).map((step) => step.trim()).filter(Boolean),
        rewrittenCustomerText: correctedSolution,
        confidence: suggestedSolution.confidence,
        validatedByTeam: true,
        validatedAt: reviewedAt,
        validatedBy: "Tech Support Console",
      });
    }
    const reasonLabel = {
      CASE_UNDERSTANDING: "AI เข้าใจปัญหาผิด",
      SOLUTION_SELECTION: "AI เลือกวิธีแก้ผิด",
      INSUFFICIENT_CUSTOMER_INFO: "ข้อมูลจากผู้ใช้งานไม่เพียงพอ",
      BETTER_SOLUTION: "มีวิธีแก้อื่นที่ถูกต้องกว่า",
    }[rejectionReason ?? "INSUFFICIENT_CUSTOMER_INFO"];
    await store.createMessage({
      caseId,
      direction: "INTERNAL",
      channel: "system",
      originalText: `ทีม Tech ระบุว่า AI ไม่ถูกต้อง: ${reasonLabel}`,
      displayText: `ทีม Tech ระบุว่า AI ไม่ถูกต้อง: ${reasonLabel}`,
      senderType: "SYSTEM",
      contentType: "SYSTEM_EVENT",
      messageType: "SYSTEM_EVENT",
      isVisibleToCustomer: false,
      deliveryStatus: "PROCESSED",
      metadata: { rejectionReason, additionalExplanation: additionalExplanation || undefined, correctedSolution: correctedSolution || undefined },
    });
  }

  const reviewed = await store.updateCase(caseId, {
    confidenceScore: detail.confidenceScore,
    confidenceReviewStatus: reviewStage === "AUTO_ANSWER"
      ? result === "approved" ? "AUTO_ANSWER_APPROVED" : "AUTO_ANSWER_REJECTED"
      : result === "approved" ? "QUALITY_APPROVED" : "QUALITY_REJECTED",
    confidenceReviewedAt: reviewedAt,
    confidenceReviewedBy: "Tech Support Console",
  });
  return c.json({ data: { id: c.req.param("id"), caseId, result, reviewStage, solutionId: suggestedSolution?.id, case: reviewed } });
});
