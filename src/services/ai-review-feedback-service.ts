import type { AiReviewFeedback } from "../domain/types";
import { getLatestCustomerMessageAnalysis } from "../lib/analysis";
import { store } from "../repositories/store";

export type SaveAiReviewFeedbackInput = Omit<AiReviewFeedback, "id" | "analysisId" | "createdAt" | "updatedAt"> & {
  analysisId: string;
};

export async function listAiReviewFeedbackForAnalysis(input: {
  caseId: string;
  analysisId: string;
  analysisVersion: number;
}): Promise<AiReviewFeedback[]> {
  return (await store.listAiReviewFeedback()).filter((item) => (
    item.caseId === input.caseId
    && item.analysisId === input.analysisId
    && item.analysisVersion === input.analysisVersion
  ));
}

export async function saveAiReviewFeedback(input: SaveAiReviewFeedbackInput): Promise<AiReviewFeedback> {
  if (!Number.isInteger(input.analysisVersion) || input.analysisVersion < 1) {
    throw new Error("Analysis version must be a positive integer");
  }

  const caseDetail = await store.getCaseDetail(input.caseId);
  if (!caseDetail) {
    throw new Error("Case not found");
  }

  const analysis = caseDetail.analyses.find((item) => item.analysisId === input.analysisId);
  if (!analysis || analysis.analysisVersion !== input.analysisVersion) {
    throw new Error("Analysis does not match the selected case version");
  }

  if (input.reviewSource === "CASE_DETAIL"
    && caseDetail.status !== "closed"
    && caseDetail.status !== "resolved") {
    throw new Error("กรุณาปิดเคสก่อนบันทึกผลการตรวจ AI");
  }

  return store.upsertAiReviewFeedback({
    ...input,
    reason: input.result === "INCORRECT" ? input.reason?.trim() || undefined : undefined,
  });
}

export async function saveQualityReview(input: {
  caseId: string;
  analysisId: string;
  analysisVersion: number;
  understandingResult: AiReviewFeedback["result"];
  solutionResult?: AiReviewFeedback["result"];
  reason?: string;
  reviewedAt: string;
  reviewedBy: string;
}) {
  if (!Number.isInteger(input.analysisVersion) || input.analysisVersion < 1) {
    throw new Error("Analysis version must be a positive integer");
  }

  const caseDetail = await store.getCaseDetail(input.caseId);
  if (!caseDetail) throw new Error("Case not found");
  const analysis = getLatestCustomerMessageAnalysis(caseDetail.analyses);
  if (!analysis
    || analysis.analysisId !== input.analysisId
    || analysis.analysisVersion !== input.analysisVersion) {
    throw new Error("Analysis does not match the selected case version");
  }

  const reason = input.reason?.trim() || undefined;
  const feedback = [
    { feedbackType: "ISSUE_UNDERSTANDING" as const, result: input.understandingResult },
    ...(input.solutionResult ? [{ feedbackType: "SOLUTION_SELECTION" as const, result: input.solutionResult }] : []),
  ].map((item) => ({
    caseId: input.caseId,
    analysisId: input.analysisId,
    analysisVersion: input.analysisVersion,
    feedbackType: item.feedbackType,
    result: item.result,
    reviewSource: "CONFIDENCE_REVIEW" as const,
    reason: item.result === "INCORRECT" ? reason : undefined,
    reviewedBy: input.reviewedBy,
  }));

  return store.persistQualityReview({
    caseId: input.caseId,
    feedback,
    status: feedback.some((item) => item.result === "INCORRECT") ? "QUALITY_REJECTED" : "QUALITY_APPROVED",
    reviewedAt: input.reviewedAt,
    reviewedBy: input.reviewedBy,
  });
}
