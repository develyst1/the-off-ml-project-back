import { Hono } from "hono";
import { readJsonObject, requiredString } from "../lib/request";
import { store } from "../repositories/store";
import { caseService } from "../services/case-service";
import { hasActionableSolutionSteps } from "../lib/solution-quality";
import { listAiReviewFeedbackForAnalysis, saveAiReviewFeedback, saveQualityReview } from "../services/ai-review-feedback-service";
import { getAnalysisSourceMessageIds, getAnalysisTechnicalTopic, getLatestCustomerMessageAnalysis } from "../lib/analysis";
import { categoryLabelOf } from "../lib/category";
import { analysisMessageIdentity } from "../repositories/case-message-normalizer";

export const confidenceRoutes = new Hono();

type ReviewStage = "QUALITY" | "AUTO_ANSWER";
type FeedbackResult = "CORRECT" | "INCORRECT";
type ReviewStatus = "LOW_CONFIDENCE" | "NEGATIVE_FEEDBACK" | "NOT_REVIEWED";

const REVIEW_THRESHOLD = 98;

function getReviewStage(caseConfidence: number, solutionConfidence?: number, hasSolution = true): ReviewStage {
  return hasSolution && caseConfidence >= REVIEW_THRESHOLD && (solutionConfidence ?? 0) >= REVIEW_THRESHOLD
    ? "AUTO_ANSWER"
    : "QUALITY";
}

function getFeedbackResult(value: unknown): FeedbackResult | undefined {
  return value === "CORRECT" || value === "INCORRECT" ? value : undefined;
}

function getLatestActionableSolution<T extends { createdAt: string; solutionSteps: string[] }>(solutions: T[]) {
  const latestSolution = [...solutions]
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime())
    .at(-1);
  return latestSolution && hasActionableSolutionSteps(latestSolution.solutionSteps)
    ? latestSolution
    : undefined;
}

function getCustomerMessageForAnalysis<T extends {
  id: string;
  initialCustomerMessageId?: string;
  latestCustomerMessageId?: string;
  messages: Array<{ id: string; senderType?: string; originalText: string; metadata?: Record<string, unknown> }>;
}>(item: T, analysis: Parameters<typeof getAnalysisSourceMessageIds>[0]) {
  const customerMessages = item.messages.filter((message) => message.senderType === "CUSTOMER");
  const sourceMessageIds = getAnalysisSourceMessageIds(analysis);
  for (const sourceId of [...sourceMessageIds].reverse()) {
    const match = customerMessages.find((message) => (
      message.id === sourceId || analysisMessageIdentity(message) === sourceId
    ));
    if (match) return match;
  }

  const currentMessageId = item.latestCustomerMessageId ?? item.initialCustomerMessageId;
  const currentMessage = currentMessageId
    ? customerMessages.find((message) => message.id === currentMessageId || analysisMessageIdentity(message) === currentMessageId)
    : undefined;
  if (currentMessage) return currentMessage;

  return customerMessages.filter((message) => message.metadata?.isCaseReference === true).at(-1)
    ?? customerMessages.at(-1);
}

confidenceRoutes.get("/suggestions", async (c) => {
  const cases = await caseService.listCases();
  const suggestions = (await Promise.all(cases
    .map(async (item) => {
      const latestSolution = getLatestActionableSolution(item.solutions);
      const currentAnalysis = getLatestCustomerMessageAnalysis(item.analyses);
      if (!currentAnalysis) return [];
      const customerMessage = getCustomerMessageForAnalysis(item, currentAnalysis);
      const caseConfidence = item.confidenceScore ?? 0;
      const solutionConfidence = latestSolution?.confidence;
      const baseReviewStage = getReviewStage(caseConfidence, latestSolution?.confidence, Boolean(latestSolution));
      const currentFeedback = await listAiReviewFeedbackForAnalysis({
        caseId: item.id,
        analysisId: currentAnalysis.analysisId,
        analysisVersion: currentAnalysis.analysisVersion,
      });
      const understandingFeedback = currentFeedback.find((entry) => entry.feedbackType === "ISSUE_UNDERSTANDING");
      const solutionFeedback = currentFeedback.find((entry) => entry.feedbackType === "SOLUTION_SELECTION");
      const hasNegativeFeedback = understandingFeedback?.result === "INCORRECT" || solutionFeedback?.result === "INCORRECT";
      const hasReviewedUnderstanding = understandingFeedback?.reviewSource === "CONFIDENCE_REVIEW";
      const hasReviewedSolution = solutionFeedback?.reviewSource === "CONFIDENCE_REVIEW";
      const hasCompletedQualityReview = Boolean(latestSolution) && hasReviewedUnderstanding && hasReviewedSolution;
      const reviewStage = hasNegativeFeedback ? "QUALITY" : baseReviewStage;
      const reviewStatus: ReviewStatus = caseConfidence < REVIEW_THRESHOLD
        || (solutionConfidence !== undefined && solutionConfidence < REVIEW_THRESHOLD)
        ? "LOW_CONFIDENCE"
        : hasNegativeFeedback
          ? "NEGATIVE_FEEDBACK"
          : "NOT_REVIEWED";
      const needsQualityReview = reviewStage === "QUALITY" && !hasCompletedQualityReview;
      const needsAutoAnswerReview = reviewStage === "AUTO_ANSWER"
        && latestSolution?.autoAnswerReviewResult === undefined;

      if (!needsQualityReview && !needsAutoAnswerReview) return [];

      return [{
        id: `match_${item.id}`,
        caseId: item.id,
        caseNumber: item.caseNumber,
        customerName: item.customer.displayName ?? "ผู้ใช้งาน LINE",
        suggestedSolutionId: latestSolution?.id ?? "",
        category: categoryLabelOf(currentAnalysis.category ?? item.category),
        technicalTopic: getAnalysisTechnicalTopic(currentAnalysis),
        originalText: customerMessage?.originalText ?? "",
        solutionText: latestSolution?.solutionSteps.join("\n") ?? "—",
        caseUnderstandingConfidence: caseConfidence,
        caseDiscriminationConfidence: solutionConfidence,
        analysisId: currentAnalysis?.analysisId,
        analysisVersion: currentAnalysis?.analysisVersion,
        hasSuggestedSolution: Boolean(latestSolution),
        understandingResult: hasReviewedUnderstanding ? understandingFeedback.result : undefined,
        solutionResult: hasReviewedSolution ? solutionFeedback.result : undefined,
        reviewReason: hasReviewedUnderstanding && understandingFeedback.result === "INCORRECT"
          ? understandingFeedback.reason
          : hasReviewedSolution && solutionFeedback.result === "INCORRECT"
            ? solutionFeedback.reason
            : undefined,
        reviewStage,
        reviewStatus,
        reviewHint: reviewStage === "AUTO_ANSWER"
          ? "ผ่านเกณฑ์คะแนนแล้ว รออนุมัติให้ตอบอัตโนมัติ"
          : "ใช้เพื่อตรวจคุณภาพ AI เท่านั้น ยังไม่เปิดตอบอัตโนมัติ",
      }];
    }))).flat();

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
    const requestedStage = body.reviewStage === "QUALITY" || body.reviewStage === "AUTO_ANSWER"
      ? body.reviewStage
      : undefined;
    const solutionId = typeof body.solutionId === "string" && body.solutionId.trim()
      ? body.solutionId.trim()
      : undefined;
    const decision = body.decision === "APPROVED" || body.decision === "REJECTED"
      ? body.decision
      : undefined;
    const understandingResult = getFeedbackResult(body.understandingResult);
    const solutionResult = getFeedbackResult(body.solutionResult);
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : undefined;

    if (typeof analysisVersion !== "number" || !Number.isInteger(analysisVersion) || analysisVersion < 1) {
      return c.json({ error: "invalid_analysis_version" }, 400);
    }
    if (!analysisId) {
      return c.json({ error: "analysis_id_is_required" }, 400);
    }
    if (body.reviewStage !== undefined && !requestedStage) {
      return c.json({ error: "invalid_review_stage", allowed: ["QUALITY", "AUTO_ANSWER"] }, 400);
    }
    if (body.decision !== undefined && !decision) {
      return c.json({ error: "invalid_review_decision", allowed: ["APPROVED", "REJECTED"] }, 400);
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

    const currentAnalysis = getLatestCustomerMessageAnalysis(detail.analyses);
    if (!currentAnalysis
      || currentAnalysis.analysisId !== analysisId
      || currentAnalysis.analysisVersion !== analysisVersion) {
      return c.json({ error: "review_context_changed", message: "Analysis changed. Reload Confidence Review and try again." }, 409);
    }

    const latestSolution = getLatestActionableSolution(detail.solutions);
    if (solutionId && latestSolution?.id !== solutionId) {
      return c.json({ error: "review_context_changed", message: "Suggested solution changed. Reload Confidence Review and try again." }, 409);
    }

    const currentFeedback = await listAiReviewFeedbackForAnalysis({ caseId, analysisId, analysisVersion });
    const hasNegativeFeedback = currentFeedback.some((entry) => entry.result === "INCORRECT");
    const calculatedStage = hasNegativeFeedback
      ? "QUALITY"
      : getReviewStage(detail.confidenceScore ?? 0, latestSolution?.confidence, Boolean(latestSolution));
    if (requestedStage && requestedStage !== calculatedStage) {
      return c.json({ error: "review_stage_changed", message: "Review stage changed. Reload Confidence Review and try again." }, 409);
    }

    const reviewStage = requestedStage ?? "QUALITY";
    if (reviewStage === "AUTO_ANSWER") {
      if (!latestSolution || !solutionId || latestSolution.id !== solutionId) {
        return c.json({ error: "review_context_changed", message: "Suggested solution changed. Reload Confidence Review and try again." }, 409);
      }
      if (!decision) {
        return c.json({ error: "review_decision_is_required" }, 400);
      }
      if (decision === "APPROVED" && (understandingResult !== "CORRECT" || solutionResult !== "CORRECT")) {
        return c.json({ error: "approved_feedback_must_be_correct" }, 400);
      }
      if (decision === "REJECTED"
        && (understandingResult === "CORRECT" || solutionResult === "CORRECT"
          || (understandingResult !== "INCORRECT" && solutionResult !== "INCORRECT"))) {
        return c.json({ error: "rejected_feedback_must_identify_an_incorrect_dimension" }, 400);
      }
    }

    if (reviewStage === "QUALITY") {
      if (!latestSolution) {
        return c.json({ error: "quality_solution_is_required" }, 400);
      }
      if (!understandingResult) {
        return c.json({ error: "quality_understanding_result_is_required" }, 400);
      }
      if (!solutionId) {
        return c.json({ error: "solution_id_is_required" }, 400);
      }
      if (!solutionResult) {
        return c.json({ error: "quality_solution_result_is_required" }, 400);
      }

      const reviewedAt = new Date().toISOString();
      const persisted = await saveQualityReview({
        caseId,
        analysisId: currentAnalysis.analysisId,
        analysisVersion,
        understandingResult,
        solutionResult,
        reason,
        reviewedAt,
        reviewedBy: "Tech Support Console",
      });
      return c.json({
        data: {
          id: c.req.param("id"),
          caseId,
          analysisId: currentAnalysis.analysisId,
          analysisVersion,
          reviewStage,
          solutionId: latestSolution?.id,
          feedback: persisted.feedback,
          case: persisted.supportCase,
        },
      });
    }

    const feedback = await Promise.all([
      understandingResult
        ? saveAiReviewFeedback({
          caseId,
          analysisId: currentAnalysis.analysisId,
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
          analysisId: currentAnalysis.analysisId,
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
    if (reviewStage === "AUTO_ANSWER" && latestSolution && decision) {
      await store.updateSolution(latestSolution.id, {
        validatedByTeam: decision === "APPROVED",
        validatedAt: decision === "APPROVED" ? reviewedAt : undefined,
        validatedBy: decision === "APPROVED" ? "Tech Support Console" : undefined,
        autoAnswerReviewResult: decision,
        autoAnswerReviewedAt: reviewedAt,
        autoAnswerReviewedBy: "Tech Support Console",
      });
    }
    const reviewed = await store.updateCase(caseId, {
      confidenceReviewStatus: decision === "APPROVED" ? "AUTO_ANSWER_APPROVED" : "AUTO_ANSWER_REJECTED",
      confidenceReviewedAt: reviewedAt,
      confidenceReviewedBy: "Tech Support Console",
    });

    return c.json({
      data: {
        id: c.req.param("id"),
        caseId,
        analysisId: currentAnalysis.analysisId,
        analysisVersion,
        reviewStage,
        decision,
        solutionId: latestSolution?.id,
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
  const reviewStage = getReviewStage(detail.confidenceScore ?? 0, suggestedSolution?.confidence, Boolean(suggestedSolution));
  if (requestedStage && requestedStage !== reviewStage) {
    return c.json({ error: "review_stage_changed", message: "คะแนนของเคสเปลี่ยน กรุณารีเฟรชรายการก่อนยืนยัน" }, 409);
  }

  if (reviewStage === "AUTO_ANSWER" && !suggestedSolution) {
    return c.json({ error: "solution_not_found", message: "ยังไม่มีวิธีแก้ที่พร้อมให้อนุมัติ Auto-answer" }, 400);
  }

  const reviewedAt = new Date().toISOString();
  const currentAnalysis = getLatestCustomerMessageAnalysis(detail.analyses);

  if (currentAnalysis && reviewStage === "QUALITY") {
    const feedbackType = result === "approved"
      ? ["ISSUE_UNDERSTANDING", "SOLUTION_SELECTION"] as const
      : rejectionReason === "CASE_UNDERSTANDING"
        ? ["ISSUE_UNDERSTANDING"] as const
        : rejectionReason === "SOLUTION_SELECTION" || rejectionReason === "BETTER_SOLUTION"
          ? ["SOLUTION_SELECTION"] as const
          : [] as const;

    await Promise.all(feedbackType.map((type) => saveAiReviewFeedback({
      caseId,
      analysisId: currentAnalysis.analysisId,
      analysisVersion: currentAnalysis.analysisVersion,
      feedbackType: type,
      result: result === "approved" ? "CORRECT" : "INCORRECT",
      reviewSource: "CONFIDENCE_REVIEW",
      reason: additionalExplanation || rejectionReason,
      reviewedBy: "Tech Support Console",
    })));
  }

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
