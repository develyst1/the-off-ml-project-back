import { Hono } from "hono";
import type { CaseStatus } from "../domain/types";
import { getLatestCustomerMessageAnalysis } from "../lib/analysis";
import { caseService } from "../services/case-service";
import { isSolutionReadyForAutoAnswer } from "../services/auto-answer-guardrail";
import { categoryKeyOf, categoryLabelOf } from "../lib/category";
import { store } from "../repositories/store";

export const analyticsRoutes = new Hono();

const SLA_MONITORED_STATUSES = new Set<CaseStatus>([
  "new",
  "analyzing",
  "awaiting_tech",
  "assigned",
  "in_progress",
  "analyzing_solution",
  "awaiting_tech_review",
  "reopened",
]);

function bucketConfidence(value: number) {
  if (value < 60) return "0-59%";
  if (value < 90) return "60-89%";
  if (value < 98) return "90-97%";
  return "98-100%";
}

function analyticsCategoryKey(category?: string) {
  const key = categoryKeyOf(category);
  // AI may return a new category before the product mapping knows its label.
  // Keep that feedback visible under Other instead of dropping it silently.
  return key.startsWith("AI_") ? "OTHER" : key;
}

function analyticsStartAt(range?: string) {
  const days = range === "today" ? 1 : range === "7d" ? 7 : 30;
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

function isSlaBreached(item: Awaited<ReturnType<typeof caseService.listCases>>[number]) {
  if (!SLA_MONITORED_STATUSES.has(item.status)) return false;
  const latestCustomerMessage = [...item.messages]
    .filter((message) => message.senderType === "CUSTOMER")
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0];
  const activityAt = latestCustomerMessage?.receivedAt ?? latestCustomerMessage?.createdAt ?? item.updatedAt;
  const activityTime = new Date(activityAt).getTime();
  return Number.isFinite(activityTime) && Date.now() - activityTime >= 4 * 60 * 60 * 1000;
}

analyticsRoutes.get("/summary", async (c) => {
  const allCases = await caseService.listCases();
  const cases = allCases.filter((item) => {
    const createdAt = new Date(item.createdAt).getTime();
    return Number.isFinite(createdAt) && createdAt >= analyticsStartAt(c.req.query("range"));
  });
  const feedback = await store.listAiReviewFeedback();
  const total = cases.length;
  const solved = cases.filter((item) => item.status === "resolved" || item.status === "sent_to_customer" || item.status === "closed").length;
  const overSla = cases.filter(isSlaBreached).length;
  const latestAnalysisByCase = new Map(cases.map((item) => (
    [item.id, getLatestCustomerMessageAnalysis(item.analyses)] as const
  )));
  const automationSettings = await store.getAutomationSettings().catch(() => ({
    caseUnderstandingThreshold: 98,
    caseDiscriminationThreshold: 98,
  }));
  const readyForAutoAnswer = cases.filter((item) => {
    const currentAnalysis = latestAnalysisByCase.get(item.id);
    return item.solutions.some((solution) => isSolutionReadyForAutoAnswer(
      currentAnalysis?.confidence ?? item.confidenceScore,
      solution,
      automationSettings,
    ));
  }).length;
  const resolvedCasePct = total ? Math.round((solved / total) * 100) : 0;

  const categoryCounts = new Map<string, {
    count: number;
    caseUnderstandingCorrect: number;
    caseUnderstandingReviewed: number;
    solutionSelectionCorrect: number;
    solutionSelectionReviewed: number;
  }>();
  const confidenceCounts = new Map<string, number>();
  const currentFeedback = new Map<string, typeof feedback[number]>();
  for (const item of feedback) {
    const analysis = latestAnalysisByCase.get(item.caseId);
    // Feedback is valid only when it points at the exact current analysis,
    // not merely the same case/version. This prevents an orphaned analysis id
    // from being counted in the current Analytics bucket.
    if (!analysis || analysis.analysisVersion !== item.analysisVersion || analysis.analysisId !== item.analysisId) continue;
    const key = `${item.caseId}:${item.analysisId}:${item.analysisVersion}:${item.feedbackType}`;
    const existing = currentFeedback.get(key);
    if (!existing || new Date(item.updatedAt).getTime() > new Date(existing.updatedAt).getTime()) {
      currentFeedback.set(key, item);
    }
  }

  for (const item of cases) {
    const analysis = latestAnalysisByCase.get(item.id);
    // Category and feedback must be from the same analysis version.
    const category = analyticsCategoryKey(analysis?.category ?? item.category);
    const current = categoryCounts.get(category) ?? {
      count: 0,
      caseUnderstandingCorrect: 0,
      caseUnderstandingReviewed: 0,
      solutionSelectionCorrect: 0,
      solutionSelectionReviewed: 0,
    };
    current.count += 1;
    const analysisVersion = analysis?.analysisVersion;
    const understanding = analysisVersion
      ? currentFeedback.get(`${item.id}:${analysis.analysisId}:${analysisVersion}:ISSUE_UNDERSTANDING`)
      : undefined;
    const solutionSelection = analysisVersion
      ? currentFeedback.get(`${item.id}:${analysis.analysisId}:${analysisVersion}:SOLUTION_SELECTION`)
      : undefined;
    // ai_review_feedback is the source of truth. Do not combine it with legacy
    // support_cases fields, otherwise migrated feedback would be double-counted.
    if (understanding) {
      current.caseUnderstandingReviewed += 1;
      if (understanding.result === "CORRECT") current.caseUnderstandingCorrect += 1;
    }
    if (solutionSelection) {
      current.solutionSelectionReviewed += 1;
      if (solutionSelection.result === "CORRECT") current.solutionSelectionCorrect += 1;
    }
    categoryCounts.set(category, current);
    const confidenceBucket = bucketConfidence(analysis?.confidence ?? item.confidenceScore ?? 0);
    confidenceCounts.set(confidenceBucket, (confidenceCounts.get(confidenceBucket) ?? 0) + 1);
  }

  const categories = [...categoryCounts.entries()].map(([key, statistics]) => ({
    key,
    label: categoryLabelOf(key),
    count: statistics.count,
    value: total ? Math.round((statistics.count / total) * 100) : 0,
    caseUnderstandingAccuracy: statistics.caseUnderstandingReviewed
      ? Math.round((statistics.caseUnderstandingCorrect / statistics.caseUnderstandingReviewed) * 100)
      : 0,
    solutionSelectionAccuracy: statistics.solutionSelectionReviewed
      ? Math.round((statistics.solutionSelectionCorrect / statistics.solutionSelectionReviewed) * 100)
      : 0,
    caseUnderstandingReviewedCount: statistics.caseUnderstandingReviewed,
    solutionSelectionReviewedCount: statistics.solutionSelectionReviewed,
  }));

  const confidenceDistribution = ["0-59%", "60-89%", "90-97%", "98-100%"].map((label) => ({
    label,
    value: total ? Math.round(((confidenceCounts.get(label) ?? 0) / total) * 100) : 0,
  }));

  return c.json({
    data: {
      total,
      resolvedCasePct,
      // Backward-compatible alias for existing clients. The value has always
      // represented resolved/closed cases, not verified solution reuse.
      solvedFromExistingSolutionPct: resolvedCasePct,
      overSla,
      readyForAutoAnswer,
      categories,
      confidenceDistribution,
    },
  });
});
