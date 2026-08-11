import type { AiReviewFeedback } from "../domain/types";
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

  return store.upsertAiReviewFeedback({
    ...input,
    reason: input.result === "INCORRECT" ? input.reason?.trim() || undefined : undefined,
  });
}
