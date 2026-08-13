import { expect, mock, test } from "bun:test";
import { InMemoryStore } from "../repositories/in-memory-store";

let activeStore = new InMemoryStore();
const delegatedStore = new Proxy({} as InMemoryStore, {
  get: (_target, property) => {
    const value = (activeStore as unknown as Record<PropertyKey, unknown>)[property];
    return typeof value === "function" ? value.bind(activeStore) : value;
  },
});
mock.module("../repositories/store", () => ({ store: delegatedStore }));

const { evaluateLearnedReliabilityGate, evaluateLearnedReliabilitySnapshot, getLearnedReliability } = await import("./learned-reliability-service");

type FeedbackType = "ISSUE_UNDERSTANDING" | "SOLUTION_SELECTION";
type FeedbackResult = "CORRECT" | "INCORRECT";

async function addFeedback(type: FeedbackType, result: FeedbackResult, name: string, options: {
  analysisId?: string;
  analysisVersion?: number;
  analysisType?: "customer_message" | "tech_solution";
  reviewSource?: "CASE_DETAIL" | "CONFIDENCE_REVIEW";
} = {}) {
  const customer = await activeStore.upsertCustomer({ lineUserId: `U-reliability-${name}` });
  const supportCase = await activeStore.createCase({ customerId: customer.id, confidenceScore: 85 });
  let analysis = await activeStore.createAnalysis({ caseId: supportCase.id, analysisType: options.analysisType ?? "customer_message", confidence: 85, rawJson: {} });
  while ((options.analysisVersion ?? 1) > analysis.analysisVersion) {
    analysis = await activeStore.createAnalysis({ caseId: supportCase.id, analysisType: options.analysisType ?? "customer_message", confidence: 85, rawJson: {} });
  }
  await activeStore.upsertAiReviewFeedback({
    caseId: supportCase.id,
    analysisId: options.analysisId ?? analysis.analysisId,
    analysisVersion: options.analysisVersion ?? analysis.analysisVersion,
    feedbackType: type,
    result,
    reviewSource: options.reviewSource ?? "CONFIDENCE_REVIEW",
  });
  return { supportCase, analysis };
}

function resetStore() {
  activeStore = new InMemoryStore();
}

async function createAnalysisSequence(name: string, analysisTypes: Array<"customer_message" | "tech_solution">) {
  const customer = await activeStore.upsertCustomer({ lineUserId: `U-reliability-sequence-${name}` });
  const supportCase = await activeStore.createCase({ customerId: customer.id, confidenceScore: 85 });
  const analyses = [];
  for (const analysisType of analysisTypes) {
    analyses.push(await activeStore.createAnalysis({ caseId: supportCase.id, analysisType, confidence: 85, rawJson: {} }));
  }
  return { supportCase, analyses };
}

function saveAnalysisFeedback(input: {
  caseId: string;
  analysis: Awaited<ReturnType<InMemoryStore["createAnalysis"]>>;
  result: FeedbackResult;
  reviewSource?: "CASE_DETAIL" | "CONFIDENCE_REVIEW";
  feedbackType?: FeedbackType;
}) {
  return activeStore.upsertAiReviewFeedback({
    caseId: input.caseId,
    analysisId: input.analysis.analysisId,
    analysisVersion: input.analysis.analysisVersion,
    feedbackType: input.feedbackType ?? "ISSUE_UNDERSTANDING",
    result: input.result,
    reviewSource: input.reviewSource ?? "CONFIDENCE_REVIEW",
  });
}

test("returns READY and 1.0 for five correct understanding reviews", async () => {
  resetStore();
  for (let index = 0; index < 5; index += 1) await addFeedback("ISSUE_UNDERSTANDING", "CORRECT", `understanding-correct-${index}`);
  const result = await getLearnedReliability();
  expect(result.issueUnderstanding).toEqual({ correctCount: 5, incorrectCount: 0, sampleCount: 5, reliability: 1, status: "READY" });
});

test("returns READY and 0.0 for five incorrect understanding reviews", async () => {
  resetStore();
  for (let index = 0; index < 5; index += 1) await addFeedback("ISSUE_UNDERSTANDING", "INCORRECT", `understanding-incorrect-${index}`);
  const result = await getLearnedReliability();
  expect(result.issueUnderstanding).toEqual({ correctCount: 0, incorrectCount: 5, sampleCount: 5, reliability: 0, status: "READY" });
});

test("calculates mixed understanding reliability as 0.6", async () => {
  resetStore();
  for (let index = 0; index < 3; index += 1) await addFeedback("ISSUE_UNDERSTANDING", "CORRECT", `understanding-mixed-correct-${index}`);
  for (let index = 0; index < 2; index += 1) await addFeedback("ISSUE_UNDERSTANDING", "INCORRECT", `understanding-mixed-incorrect-${index}`);
  const result = await getLearnedReliability();
  expect(result.issueUnderstanding).toEqual({ correctCount: 3, incorrectCount: 2, sampleCount: 5, reliability: 0.6, status: "READY" });
});

test("returns NO_DATA without treating missing feedback as incorrect", async () => {
  resetStore();
  const result = await getLearnedReliability();
  expect(result.issueUnderstanding).toEqual({ correctCount: 0, incorrectCount: 0, sampleCount: 0, reliability: null, status: "NO_DATA" });
  expect(result.solutionSelection).toEqual(result.issueUnderstanding);
});

test("does not count correct or incorrect Case Detail feedback", async () => {
  resetStore();
  await addFeedback("ISSUE_UNDERSTANDING", "CORRECT", "case-detail-correct", { reviewSource: "CASE_DETAIL" });
  await addFeedback("ISSUE_UNDERSTANDING", "INCORRECT", "case-detail-incorrect", { reviewSource: "CASE_DETAIL" });
  const result = await getLearnedReliability();
  expect(result.issueUnderstanding).toEqual({ correctCount: 0, incorrectCount: 0, sampleCount: 0, reliability: null, status: "NO_DATA" });
});

test("counts only Confidence Review feedback when sources are mixed", async () => {
  resetStore();
  await addFeedback("ISSUE_UNDERSTANDING", "CORRECT", "mixed-case-detail", { reviewSource: "CASE_DETAIL" });
  await addFeedback("ISSUE_UNDERSTANDING", "INCORRECT", "mixed-confidence-review");
  const result = await getLearnedReliability();
  expect(result.issueUnderstanding).toEqual({ correctCount: 0, incorrectCount: 1, sampleCount: 1, reliability: null, status: "INSUFFICIENT_DATA" });
});

test("counts Confidence Review feedback only from customer analyses", async () => {
  resetStore();
  await addFeedback("ISSUE_UNDERSTANDING", "CORRECT", "customer-understanding");
  await addFeedback("SOLUTION_SELECTION", "CORRECT", "customer-solution");
  await addFeedback("ISSUE_UNDERSTANDING", "INCORRECT", "tech-understanding", { analysisType: "tech_solution" });
  await addFeedback("SOLUTION_SELECTION", "INCORRECT", "tech-solution", { analysisType: "tech_solution" });

  const result = await getLearnedReliability();

  expect(result.issueUnderstanding).toEqual({ correctCount: 1, incorrectCount: 0, sampleCount: 1, reliability: null, status: "INSUFFICIENT_DATA" });
  expect(result.solutionSelection).toEqual({ correctCount: 1, incorrectCount: 0, sampleCount: 1, reliability: null, status: "INSUFFICIENT_DATA" });
});

test("returns NO_DATA when only tech analysis has Confidence Review feedback", async () => {
  resetStore();
  await addFeedback("ISSUE_UNDERSTANDING", "CORRECT", "only-tech-understanding", { analysisType: "tech_solution" });
  await addFeedback("SOLUTION_SELECTION", "CORRECT", "only-tech-solution", { analysisType: "tech_solution" });

  const result = await getLearnedReliability();

  expect(result.issueUnderstanding).toEqual({ correctCount: 0, incorrectCount: 0, sampleCount: 0, reliability: null, status: "NO_DATA" });
  expect(result.solutionSelection).toEqual(result.issueUnderstanding);
});

test("does not count Case Detail customer feedback or Confidence Review tech feedback", async () => {
  resetStore();
  const customer = await activeStore.upsertCustomer({ lineUserId: "U-reliability-cross-type" });
  const supportCase = await activeStore.createCase({ customerId: customer.id, confidenceScore: 85 });
  const customerAnalysis = await activeStore.createAnalysis({ caseId: supportCase.id, analysisType: "customer_message", confidence: 85, rawJson: {} });
  const techAnalysis = await activeStore.createAnalysis({ caseId: supportCase.id, analysisType: "tech_solution", confidence: 85, rawJson: {} });
  for (const feedbackType of ["ISSUE_UNDERSTANDING", "SOLUTION_SELECTION"] as const) {
    await activeStore.upsertAiReviewFeedback({
      caseId: supportCase.id,
      analysisId: customerAnalysis.analysisId,
      analysisVersion: customerAnalysis.analysisVersion,
      feedbackType,
      result: "CORRECT",
      reviewSource: "CASE_DETAIL",
    });
    await activeStore.upsertAiReviewFeedback({
      caseId: supportCase.id,
      analysisId: techAnalysis.analysisId,
      analysisVersion: techAnalysis.analysisVersion,
      feedbackType,
      result: "CORRECT",
      reviewSource: "CONFIDENCE_REVIEW",
    });
  }

  const result = await getLearnedReliability();

  expect(result.issueUnderstanding.sampleCount).toBe(0);
  expect(result.solutionSelection.sampleCount).toBe(0);
});

test("counts a formally reviewed customer analysis when no newer customer version exists", async () => {
  resetStore();
  const fixture = await createAnalysisSequence("current-v1", ["customer_message"]);
  await saveAnalysisFeedback({ caseId: fixture.supportCase.id, analysis: fixture.analyses[0], result: "CORRECT" });

  const result = await getLearnedReliability();

  expect(result.issueUnderstanding).toEqual({ correctCount: 1, incorrectCount: 0, sampleCount: 1, reliability: null, status: "INSUFFICIENT_DATA" });
});

test("stops counting historical customer feedback after an unreviewed customer re-analysis", async () => {
  resetStore();
  const fixture = await createAnalysisSequence("historical-v1", ["customer_message"]);
  await saveAnalysisFeedback({ caseId: fixture.supportCase.id, analysis: fixture.analyses[0], result: "CORRECT" });
  await activeStore.createAnalysis({ caseId: fixture.supportCase.id, analysisType: "customer_message", confidence: 85, rawJson: {} });

  const result = await getLearnedReliability();

  expect(result.issueUnderstanding.sampleCount).toBe(0);
});

test("counts only the current formally reviewed customer analysis", async () => {
  resetStore();
  const fixture = await createAnalysisSequence("current-v2", ["customer_message", "customer_message"]);
  await saveAnalysisFeedback({ caseId: fixture.supportCase.id, analysis: fixture.analyses[0], result: "INCORRECT" });
  await saveAnalysisFeedback({ caseId: fixture.supportCase.id, analysis: fixture.analyses[1], result: "CORRECT" });

  const result = await getLearnedReliability();

  expect(result.issueUnderstanding).toEqual({ correctCount: 1, incorrectCount: 0, sampleCount: 1, reliability: null, status: "INSUFFICIENT_DATA" });
});

test("resolves latest customer across interleaved tech analysis versions", async () => {
  resetStore();
  const fixture = await createAnalysisSequence("interleaved", ["customer_message", "tech_solution", "customer_message"]);
  await saveAnalysisFeedback({ caseId: fixture.supportCase.id, analysis: fixture.analyses[0], result: "INCORRECT" });
  await saveAnalysisFeedback({ caseId: fixture.supportCase.id, analysis: fixture.analyses[1], result: "INCORRECT" });
  await saveAnalysisFeedback({ caseId: fixture.supportCase.id, analysis: fixture.analyses[2], result: "CORRECT" });

  const result = await getLearnedReliability();

  expect(fixture.analyses[2].analysisVersion).toBe(3);
  expect(result.issueUnderstanding).toEqual({ correctCount: 1, incorrectCount: 0, sampleCount: 1, reliability: null, status: "INSUFFICIENT_DATA" });
});

test("counts neither historical formal feedback nor current Case Detail feedback", async () => {
  resetStore();
  const fixture = await createAnalysisSequence("current-case-detail", ["customer_message", "customer_message"]);
  await saveAnalysisFeedback({ caseId: fixture.supportCase.id, analysis: fixture.analyses[0], result: "CORRECT" });
  await saveAnalysisFeedback({ caseId: fixture.supportCase.id, analysis: fixture.analyses[1], result: "CORRECT", reviewSource: "CASE_DETAIL" });

  const result = await getLearnedReliability();

  expect(result.issueUnderstanding.sampleCount).toBe(0);
});

test("replaces a historical formal sample with one current formal sample", async () => {
  resetStore();
  const fixture = await createAnalysisSequence("formal-replacement", ["customer_message", "customer_message"]);
  await saveAnalysisFeedback({ caseId: fixture.supportCase.id, analysis: fixture.analyses[0], result: "INCORRECT" });
  await saveAnalysisFeedback({ caseId: fixture.supportCase.id, analysis: fixture.analyses[1], result: "CORRECT" });

  const result = await getLearnedReliability();

  expect(result.issueUnderstanding.correctCount).toBe(1);
  expect(result.issueUnderstanding.incorrectCount).toBe(0);
  expect(result.issueUnderstanding.sampleCount).toBe(1);
});

test("excludeCaseId excludes feedback on the latest customer identity", async () => {
  resetStore();
  const excluded = await createAnalysisSequence("excluded-latest", ["customer_message", "customer_message"]);
  const included = await createAnalysisSequence("included-latest", ["customer_message"]);
  await saveAnalysisFeedback({ caseId: excluded.supportCase.id, analysis: excluded.analyses[1], result: "INCORRECT" });
  await saveAnalysisFeedback({ caseId: included.supportCase.id, analysis: included.analyses[0], result: "CORRECT" });

  const result = await getLearnedReliability({ excludeCaseId: excluded.supportCase.id });

  expect(result.issueUnderstanding).toEqual({ correctCount: 1, incorrectCount: 0, sampleCount: 1, reliability: null, status: "INSUFFICIENT_DATA" });
});

test("does not count OFF-00056-equivalent V3 feedback after unreviewed customer V12", async () => {
  resetStore();
  const types = Array.from({ length: 12 }, (_, index) => (
    index === 2 || index === 11 ? "customer_message" as const : "tech_solution" as const
  ));
  const fixture = await createAnalysisSequence("off-00056", types);
  await saveAnalysisFeedback({ caseId: fixture.supportCase.id, analysis: fixture.analyses[2], result: "INCORRECT" });

  const result = await getLearnedReliability();

  expect(fixture.analyses[2].analysisVersion).toBe(3);
  expect(fixture.analyses[11].analysisVersion).toBe(12);
  expect(result.issueUnderstanding.sampleCount).toBe(0);
});

test("keeps one to four samples as INSUFFICIENT_DATA and fifth as READY", async () => {
  resetStore();
  for (let index = 0; index < 4; index += 1) await addFeedback("ISSUE_UNDERSTANDING", "CORRECT", `understanding-low-${index}`);
  const insufficient = await getLearnedReliability();
  expect(insufficient.issueUnderstanding).toEqual({ correctCount: 4, incorrectCount: 0, sampleCount: 4, reliability: null, status: "INSUFFICIENT_DATA" });
  await addFeedback("ISSUE_UNDERSTANDING", "CORRECT", "understanding-low-fifth");
  const ready = await getLearnedReliability();
  expect(ready.issueUnderstanding.status).toBe("READY");
  expect(ready.issueUnderstanding.reliability).toBe(1);
});

test("keeps understanding and solution dimensions separate", async () => {
  resetStore();
  for (let index = 0; index < 5; index += 1) await addFeedback("ISSUE_UNDERSTANDING", "CORRECT", `separate-understanding-${index}`);
  for (let index = 0; index < 5; index += 1) await addFeedback("SOLUTION_SELECTION", "INCORRECT", `separate-solution-${index}`);
  const result = await getLearnedReliability();
  expect(result.issueUnderstanding.reliability).toBe(1);
  expect(result.solutionSelection.reliability).toBe(0);
});

test("starts counting once Case Detail feedback is confirmed in Confidence Review", async () => {
  resetStore();
  const fixture = await addFeedback("ISSUE_UNDERSTANDING", "CORRECT", "update-state", { reviewSource: "CASE_DETAIL" });
  await activeStore.upsertAiReviewFeedback({
    caseId: fixture.supportCase.id,
    analysisId: fixture.analysis.analysisId,
    analysisVersion: fixture.analysis.analysisVersion,
    feedbackType: "ISSUE_UNDERSTANDING",
    result: "INCORRECT",
    reviewSource: "CONFIDENCE_REVIEW",
  });
  const result = await getLearnedReliability();
  expect(result.issueUnderstanding).toEqual({ correctCount: 0, incorrectCount: 1, sampleCount: 1, reliability: null, status: "INSUFFICIENT_DATA" });
});

test("stops counting when Confidence Review feedback is updated from Case Detail", async () => {
  resetStore();
  const fixture = await addFeedback("ISSUE_UNDERSTANDING", "CORRECT", "duplicate");
  await activeStore.upsertAiReviewFeedback({
    caseId: fixture.supportCase.id,
    analysisId: fixture.analysis.analysisId,
    analysisVersion: fixture.analysis.analysisVersion,
    feedbackType: "ISSUE_UNDERSTANDING",
    result: "CORRECT",
    reviewSource: "CASE_DETAIL",
  });
  const result = await getLearnedReliability();
  expect(result.issueUnderstanding.sampleCount).toBe(0);
});

test("rejects analysisId mismatch and excludes the current case", async () => {
  resetStore();
  const valid = await addFeedback("ISSUE_UNDERSTANDING", "CORRECT", "valid-historical");
  await addFeedback("ISSUE_UNDERSTANDING", "CORRECT", "mismatch", { analysisId: "wrong-analysis-id" });
  const current = await addFeedback("ISSUE_UNDERSTANDING", "CORRECT", "current");
  const result = await getLearnedReliability({ excludeCaseId: current.supportCase.id });
  expect(result.issueUnderstanding.sampleCount).toBe(1);
  expect(valid.supportCase.id).not.toBe(current.supportCase.id);
});

test("preserves confidenceScore while calculating reliability", async () => {
  resetStore();
  const fixture = await addFeedback("SOLUTION_SELECTION", "INCORRECT", "confidence-unchanged");
  const before = (await activeStore.getCaseDetail(fixture.supportCase.id))?.confidenceScore;
  await getLearnedReliability();
  const after = (await activeStore.getCaseDetail(fixture.supportCase.id))?.confidenceScore;
  expect(before).toBe(85);
  expect(after).toBe(85);
});

function readyDimension(reliability: number) {
  return {
    correctCount: Math.round(reliability * 10),
    incorrectCount: 10 - Math.round(reliability * 10),
    sampleCount: 10,
    reliability,
    status: "READY" as const,
  };
}

test("allows the learned gate only when both dimensions are at least 90%", () => {
  expect(evaluateLearnedReliabilitySnapshot({
    issueUnderstanding: readyDimension(0.9),
    solutionSelection: readyDimension(0.9),
  }).allowed).toBe(true);
  expect(evaluateLearnedReliabilitySnapshot({
    issueUnderstanding: readyDimension(1),
    solutionSelection: readyDimension(0.9),
  }).allowed).toBe(true);
  expect(evaluateLearnedReliabilitySnapshot({
    issueUnderstanding: readyDimension(0.89),
    solutionSelection: readyDimension(1),
  }).reason).toBe("UNDERSTANDING_RELIABILITY_BELOW_THRESHOLD");
  expect(evaluateLearnedReliabilitySnapshot({
    issueUnderstanding: readyDimension(1),
    solutionSelection: readyDimension(0.89),
  }).reason).toBe("SOLUTION_RELIABILITY_BELOW_THRESHOLD");
});

test("blocks NO_DATA, INSUFFICIENT_DATA, and invalid reliability states", () => {
  const noData = { correctCount: 0, incorrectCount: 0, sampleCount: 0, reliability: null, status: "NO_DATA" as const };
  const insufficient = { correctCount: 4, incorrectCount: 0, sampleCount: 4, reliability: null, status: "INSUFFICIENT_DATA" as const };
  expect(evaluateLearnedReliabilitySnapshot({ issueUnderstanding: noData, solutionSelection: readyDimension(1) }).reason).toBe("LEARNED_RELIABILITY_NO_DATA");
  expect(evaluateLearnedReliabilitySnapshot({ issueUnderstanding: readyDimension(1), solutionSelection: noData }).reason).toBe("LEARNED_RELIABILITY_NO_DATA");
  expect(evaluateLearnedReliabilitySnapshot({ issueUnderstanding: insufficient, solutionSelection: readyDimension(1) }).reason).toBe("LEARNED_RELIABILITY_INSUFFICIENT_DATA");
  expect(evaluateLearnedReliabilitySnapshot({ issueUnderstanding: readyDimension(1), solutionSelection: insufficient }).reason).toBe("LEARNED_RELIABILITY_INSUFFICIENT_DATA");
  expect(evaluateLearnedReliabilitySnapshot({
    issueUnderstanding: { ...readyDimension(Number.NaN), reliability: Number.NaN },
    solutionSelection: readyDimension(1),
  }).reason).toBe("UNDERSTANDING_RELIABILITY_BELOW_THRESHOLD");
});

test("fails closed when the reliability query throws", async () => {
  resetStore();
  const original = activeStore.listAiReviewFeedbackForReliability;
  activeStore.listAiReviewFeedbackForReliability = async () => {
    throw new Error("database unavailable");
  };
  const result = await evaluateLearnedReliabilityGate();
  activeStore.listAiReviewFeedbackForReliability = original;
  expect(result).toEqual({ allowed: false, reason: "LEARNED_RELIABILITY_UNAVAILABLE", reliability: null });
});

test("a Case Detail update removes the prior Confidence Review sample without mutating model confidence", async () => {
  resetStore();
  const dimensions = ["ISSUE_UNDERSTANDING", "SOLUTION_SELECTION"] as const;
  const fixtures = [];
  for (const type of dimensions) {
    for (let index = 0; index < 5; index += 1) {
      fixtures.push(await addFeedback(type, "CORRECT", `gate-transition-${type}-${index}`));
    }
  }
  expect((await evaluateLearnedReliabilityGate()).allowed).toBe(true);
  const target = fixtures[0];
  await activeStore.upsertAiReviewFeedback({
    caseId: target.supportCase.id,
    analysisId: target.analysis.analysisId,
    analysisVersion: target.analysis.analysisVersion,
    feedbackType: "ISSUE_UNDERSTANDING",
    result: "INCORRECT",
    reviewSource: "CASE_DETAIL",
  });
  const after = await evaluateLearnedReliabilityGate({ excludeCaseId: "case-that-is-not-current" });
  expect(after.allowed).toBe(false);
  expect(after.reason).toBe("LEARNED_RELIABILITY_INSUFFICIENT_DATA");
  expect((await activeStore.getCaseDetail(target.supportCase.id))?.confidenceScore).toBe(85);
});
