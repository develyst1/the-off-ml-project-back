import type { AiReviewFeedback, AiReviewFeedbackMemoryItem, Analysis } from "../domain/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function textValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function toAiReviewFeedbackMemoryItem(
  feedback: AiReviewFeedback,
  analysis: Pick<Analysis, "analysisId" | "analysisVersion" | "caseId" | "summary" | "category" | "rawJson">,
): AiReviewFeedbackMemoryItem {
  const raw = isRecord(analysis.rawJson) ? analysis.rawJson : {};
  const context = isRecord(raw.caseAnalysisContext)
    ? raw.caseAnalysisContext
    : { subject: analysis.summary ?? "", detail: "", referenceMessages: [] };
  const extractedSolution = textValue(raw.extractedSolution)
    || textValue(raw.aiSolution)
    || textValue(raw.solution);
  const aiOutput = feedback.feedbackType === "ISSUE_UNDERSTANDING"
    ? { category: analysis.category ?? "", summary: analysis.summary ?? "" }
    : { category: analysis.category ?? "", solution: extractedSolution };

  return {
    caseId: feedback.caseId,
    analysisId: analysis.analysisId,
    analysisVersion: analysis.analysisVersion,
    feedbackType: feedback.feedbackType,
    result: feedback.result,
    context: JSON.stringify(context),
    aiOutput: JSON.stringify(aiOutput),
    reason: feedback.reason ?? null,
    updatedAt: feedback.updatedAt,
  };
}
