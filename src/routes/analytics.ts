import { Hono } from "hono";
import { caseService } from "../services/case-service";
import { isSolutionReadyForAutoAnswer } from "../services/auto-answer-guardrail";
import { categoryKeyOf, categoryLabelOf } from "../lib/category";

export const analyticsRoutes = new Hono();

function bucketConfidence(value: number) {
  if (value < 60) return "0-59%";
  if (value < 90) return "60-89%";
  if (value < 98) return "90-97%";
  return "98-100%";
}

analyticsRoutes.get("/summary", async (c) => {
  const cases = await caseService.listCases();
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

  const categoryCounts = new Map<string, number>();
  const confidenceCounts = new Map<string, number>();

  for (const item of cases) {
    const category = categoryKeyOf(item.category);
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    confidenceCounts.set(bucketConfidence(item.confidenceScore ?? 0), (confidenceCounts.get(bucketConfidence(item.confidenceScore ?? 0)) ?? 0) + 1);
  }

  const categories = [...categoryCounts.entries()].map(([key, count]) => ({
    key,
    label: categoryLabelOf(key),
    count,
    value: total ? Math.round((count / total) * 100) : 0,
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
