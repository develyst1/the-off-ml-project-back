import type { Analysis } from "../domain/types";

export function getLatestCustomerMessageAnalysis(analyses: readonly Analysis[]) {
  return [...analyses]
    .filter((analysis) => analysis.analysisType === "customer_message")
    .sort((left, right) => (
      right.analysisVersion - left.analysisVersion
      || new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
    ))[0];
}

export function normalizeTechnicalTopic(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || !/[\u0E01-\u0E5B]/u.test(normalized)) return undefined;
  return normalized.slice(0, 100).trimEnd();
}

export function getAnalysisTechnicalTopic(analysis?: Pick<Analysis, "rawJson">) {
  if (!analysis?.rawJson || typeof analysis.rawJson !== "object" || Array.isArray(analysis.rawJson)) return undefined;
  return normalizeTechnicalTopic((analysis.rawJson as { technicalTopic?: unknown }).technicalTopic);
}

export function getAnalysisSourceMessageIds(analysis?: Pick<Analysis, "rawJson">) {
  if (!analysis?.rawJson || typeof analysis.rawJson !== "object" || Array.isArray(analysis.rawJson)) return [];
  const rawJson = analysis.rawJson as {
    sourceMessageIds?: unknown;
    caseAnalysisContext?: { referenceMessages?: unknown };
  };
  const directIds = Array.isArray(rawJson.sourceMessageIds) ? rawJson.sourceMessageIds : [];
  const referenceMessages = Array.isArray(rawJson.caseAnalysisContext?.referenceMessages)
    ? rawJson.caseAnalysisContext.referenceMessages
    : [];
  const referenceIds = referenceMessages.map((item) => (
    item && typeof item === "object" && !Array.isArray(item)
      ? (item as { messageId?: unknown }).messageId
      : undefined
  ));
  const sourceIds = directIds.length > 0 ? directIds : referenceIds;
  return [...new Set(sourceIds
    .filter((id): id is string => typeof id === "string")
    .map((id) => id.trim())
    .filter(Boolean))];
}
