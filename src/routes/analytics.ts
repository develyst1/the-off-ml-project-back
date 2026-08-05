import { Hono } from "hono";
import { caseService } from "../services/case-service";
import { isSolutionReadyForAutoAnswer } from "../services/auto-answer-guardrail";
import { categoryKeyOf, categoryLabelOf } from "../lib/category";
import { store } from "../repositories/store";

export const analyticsRoutes = new Hono();

function bucketConfidence(value: number) {
  if (value < 60) return "0-59%";
  if (value < 90) return "60-89%";
  if (value < 98) return "90-97%";
  return "98-100%";
}

function categoryForCase(item: Awaited<ReturnType<typeof caseService.listCases>>[number]) {
  const latestCustomerAnalysis = [...item.analyses]
    .filter((analysis) => analysis.analysisType === "customer_message")
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0];

  return latestCustomerAnalysis?.category ?? item.category;
}

analyticsRoutes.get("/summary", async (c) => {
  const cases = await caseService.listCases();
  const feedback = await store.listAiReviewFeedback();
  const total = cases.length;
  const solved = cases.filter((item) => item.status === "resolved" || item.status === "sent_to_customer" || item.status === "closed").length;
  const overSla = 0;
  const readyForAutoAnswer = cases.filter((item) =>
    item.solutions.some((solution) => isSolutionReadyForAutoAnswer(
      item.confidenceScore,
      solution,
      { caseUnderstandingThreshold: 98, caseDiscriminationThreshold: 98 },
    )),
  ).length;
  const solvedFromExistingSolutionPct = total ? Math.round((solved / total) * 100) : 0;

  const categoryCounts = new Map<string, {
    count: number;
    caseUnderstandingCorrect: number;
    caseUnderstandingReviewed: number;
    solutionSelectionCorrect: number;
    solutionSelectionReviewed: number;
  }>();
  const confidenceCounts = new Map<string, number>();
  const latestAnalysisVersionByCase = new Map(cases.map((item) => [
    item.id,
    item.analyses.reduce((latest, analysis) => Math.max(latest, analysis.analysisVersion), 0),
  ]));
  const currentFeedback = new Map<string, typeof feedback[number]>();
  for (const item of feedback) {
    if (latestAnalysisVersionByCase.get(item.caseId) !== item.analysisVersion) continue;
    const key = `${item.caseId}:${item.analysisVersion}:${item.feedbackType}`;
    const existing = currentFeedback.get(key);
    if (!existing || new Date(item.updatedAt).getTime() > new Date(existing.updatedAt).getTime()) {
      currentFeedback.set(key, item);
    }
  }

  for (const item of cases) {
    const category = categoryKeyOf(categoryForCase(item));
    const current = categoryCounts.get(category) ?? {
      count: 0,
      caseUnderstandingCorrect: 0,
      caseUnderstandingReviewed: 0,
      solutionSelectionCorrect: 0,
      solutionSelectionReviewed: 0,
    };
    current.count += 1;
    const analysisVersion = latestAnalysisVersionByCase.get(item.id);
    const understanding = analysisVersion
      ? currentFeedback.get(`${item.id}:${analysisVersion}:ISSUE_UNDERSTANDING`)
      : undefined;
    const solutionSelection = analysisVersion
      ? currentFeedback.get(`${item.id}:${analysisVersion}:SOLUTION_SELECTION`)
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
    confidenceCounts.set(bucketConfidence(item.confidenceScore ?? 0), (confidenceCounts.get(bucketConfidence(item.confidenceScore ?? 0)) ?? 0) + 1);
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
      solvedFromExistingSolutionPct,
      overSla,
      readyForAutoAnswer,
      categories,
      confidenceDistribution,
    },
  });
});
