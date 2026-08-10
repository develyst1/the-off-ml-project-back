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

const { getLearnedReliability } = await import("./learned-reliability-service");

type FeedbackType = "ISSUE_UNDERSTANDING" | "SOLUTION_SELECTION";
type FeedbackResult = "CORRECT" | "INCORRECT";

async function addFeedback(type: FeedbackType, result: FeedbackResult, name: string, options: { analysisId?: string; analysisVersion?: number } = {}) {
  const customer = await activeStore.upsertCustomer({ lineUserId: `U-reliability-${name}` });
  const supportCase = await activeStore.createCase({ customerId: customer.id, confidenceScore: 85 });
  let analysis = await activeStore.createAnalysis({ caseId: supportCase.id, analysisType: "customer_message", confidence: 85, rawJson: {} });
  while ((options.analysisVersion ?? 1) > analysis.analysisVersion) {
    analysis = await activeStore.createAnalysis({ caseId: supportCase.id, analysisType: "customer_message", confidence: 85, rawJson: {} });
  }
  await activeStore.upsertAiReviewFeedback({
    caseId: supportCase.id,
    analysisId: options.analysisId ?? analysis.analysisId,
    analysisVersion: options.analysisVersion ?? analysis.analysisVersion,
    feedbackType: type,
    result,
    reviewSource: "CASE_DETAIL",
  });
  return { supportCase, analysis };
}

function resetStore() {
  activeStore = new InMemoryStore();
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

test("counts the latest upsert state once when CORRECT changes to INCORRECT", async () => {
  resetStore();
  const fixture = await addFeedback("ISSUE_UNDERSTANDING", "CORRECT", "update-state");
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

test("does not count duplicate upserts as multiple samples", async () => {
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
  expect(result.issueUnderstanding.sampleCount).toBe(1);
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
