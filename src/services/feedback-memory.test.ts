import { expect, mock, test } from "bun:test";
import { InMemoryStore } from "../repositories/in-memory-store";

const store = new InMemoryStore();
mock.module("../repositories/store", () => ({ store }));

const { feedbackExamplesForContext } = await import("./case-service");

const baseContext = (name: string) => ({
  subject: `ปัญหา ${name}`,
  detail: `รายละเอียด ${name}`,
  referenceMessages: [],
});

async function createFeedbackFixture(name: string, feedbackType: "ISSUE_UNDERSTANDING" | "SOLUTION_SELECTION", result: "CORRECT" | "INCORRECT") {
  const customer = await store.upsertCustomer({ lineUserId: `U-memory-${name}` });
  const supportCase = await store.createCase({ customerId: customer.id, status: "analyzing", confidenceScore: 77 });
  const context = baseContext(name);
  const analysis = await store.createAnalysis({
    caseId: supportCase.id,
    analysisType: "customer_message",
    summary: `สรุป ${name}`,
    category: "NETWORK_CONNECTION",
    confidence: 66,
    rawJson: { caseAnalysisContext: context, extractedSolution: `วิธีแก้ ${name}` },
  });
  const feedback = await store.upsertAiReviewFeedback({
    caseId: supportCase.id,
    analysisId: analysis.analysisId,
    analysisVersion: analysis.analysisVersion,
    feedbackType,
    result,
    reviewSource: "CASE_DETAIL",
    reason: `เหตุผล ${name}`,
  });
  return { supportCase, analysis, context, feedback };
}

test("stores positive understanding memory only in the understanding group", async () => {
  const fixture = await createFeedbackFixture("positive-understanding", "ISSUE_UNDERSTANDING", "CORRECT");
  const memory = await store.listAiReviewFeedbackForMemory({ feedbackType: "ISSUE_UNDERSTANDING", result: "CORRECT", limit: 5 });

  expect(memory).toEqual(expect.arrayContaining([
    expect.objectContaining({ caseId: fixture.supportCase.id, analysisId: fixture.analysis.analysisId, analysisVersion: fixture.analysis.analysisVersion, feedbackType: "ISSUE_UNDERSTANDING", result: "CORRECT" }),
  ]));
  expect(memory.find((item) => item.caseId === fixture.supportCase.id)?.context).toContain("positive-understanding");
});

test("stores negative understanding memory as a warning, not a solution example", async () => {
  const fixture = await createFeedbackFixture("negative-understanding", "ISSUE_UNDERSTANDING", "INCORRECT");
  const memory = await feedbackExamplesForContext(fixture.context);
  const item = memory.find((entry) => entry.context.includes("negative-understanding"));

  expect(item).toEqual(expect.objectContaining({ feedbackType: "ISSUE_UNDERSTANDING", value: "INCORRECT" }));
  expect(item?.feedbackType).not.toBe("SOLUTION_SELECTION");
});

test("stores positive solution memory separately from understanding memory", async () => {
  const fixture = await createFeedbackFixture("positive-solution", "SOLUTION_SELECTION", "CORRECT");
  const memory = await store.listAiReviewFeedbackForMemory({ feedbackType: "SOLUTION_SELECTION", result: "CORRECT", limit: 5 });

  expect(memory).toEqual(expect.arrayContaining([
    expect.objectContaining({ caseId: fixture.supportCase.id, feedbackType: "SOLUTION_SELECTION", result: "CORRECT" }),
  ]));
});

test("stores negative solution memory as a warning for solution selection only", async () => {
  const fixture = await createFeedbackFixture("negative-solution", "SOLUTION_SELECTION", "INCORRECT");
  const memory = await store.listAiReviewFeedbackForMemory({ feedbackType: "SOLUTION_SELECTION", result: "INCORRECT", limit: 5 });

  expect(memory).toEqual(expect.arrayContaining([
    expect.objectContaining({ caseId: fixture.supportCase.id, feedbackType: "SOLUTION_SELECTION", result: "INCORRECT" }),
  ]));
  expect(memory.find((item) => item.caseId === fixture.supportCase.id)?.aiOutput).toContain("negative-solution");
});

test("does not mix feedback types or duplicate an updated record", async () => {
  const fixture = await createFeedbackFixture("type-separation", "ISSUE_UNDERSTANDING", "CORRECT");
  await store.upsertAiReviewFeedback({
    caseId: fixture.supportCase.id,
    analysisId: fixture.analysis.analysisId,
    analysisVersion: fixture.analysis.analysisVersion,
    feedbackType: "ISSUE_UNDERSTANDING",
    result: "INCORRECT",
    reviewSource: "CONFIDENCE_REVIEW",
  });
  const understanding = await store.listAiReviewFeedbackForMemory({ feedbackType: "ISSUE_UNDERSTANDING", limit: 20 });
  const solution = await store.listAiReviewFeedbackForMemory({ feedbackType: "SOLUTION_SELECTION", limit: 20 });

  expect(understanding.filter((item) => item.caseId === fixture.supportCase.id)).toHaveLength(1);
  expect(solution.some((item) => item.caseId === fixture.supportCase.id)).toBe(false);
});

test("does not use an old version as the current case memory", async () => {
  const customer = await store.upsertCustomer({ lineUserId: "U-memory-version" });
  const supportCase = await store.createCase({ customerId: customer.id, status: "analyzing" });
  const first = await store.createAnalysis({ caseId: supportCase.id, analysisType: "customer_message", confidence: 60, rawJson: { caseAnalysisContext: baseContext("old-version") } });
  await store.upsertAiReviewFeedback({ caseId: supportCase.id, analysisId: first.analysisId, analysisVersion: first.analysisVersion, feedbackType: "ISSUE_UNDERSTANDING", result: "INCORRECT", reviewSource: "CASE_DETAIL" });
  const second = await store.createAnalysis({ caseId: supportCase.id, analysisType: "customer_message", confidence: 90, rawJson: { caseAnalysisContext: baseContext("new-version") } });
  const currentMemory = await feedbackExamplesForContext(baseContext("new-version"), supportCase.id);

  expect(second.analysisVersion).toBe(first.analysisVersion + 1);
  expect(currentMemory.some((item) => item.context.includes("old-version"))).toBe(false);
});

test("skips feedback with an invalid analysis reference and handles no feedback", async () => {
  const customer = await store.upsertCustomer({ lineUserId: "U-memory-invalid" });
  const supportCase = await store.createCase({ customerId: customer.id, status: "analyzing" });
  const analysis = await store.createAnalysis({ caseId: supportCase.id, analysisType: "customer_message", confidence: 80, rawJson: { caseAnalysisContext: baseContext("invalid") } });
  await store.upsertAiReviewFeedback({ caseId: supportCase.id, analysisId: "analysis-does-not-exist", analysisVersion: analysis.analysisVersion, feedbackType: "ISSUE_UNDERSTANDING", result: "CORRECT", reviewSource: "CASE_DETAIL" });

  const memory = await store.listAiReviewFeedbackForMemory({ limit: 20 });
  const empty = await feedbackExamplesForContext({
    subject: "ปัญหา invalid",
    detail: "รายละเอียด invalid",
    referenceMessages: [],
  }, supportCase.id);

  expect(memory.some((item) => item.caseId === supportCase.id)).toBe(false);
  expect(empty.some((item) => item.context.includes("invalid"))).toBe(false);
});

test("feedback memory does not change case or analysis confidence", async () => {
  const fixture = await createFeedbackFixture("confidence-integrity", "SOLUTION_SELECTION", "INCORRECT");
  const detail = await store.getCaseDetail(fixture.supportCase.id);
  const analysis = detail?.analyses.find((item) => item.analysisId === fixture.analysis.analysisId);

  expect(detail?.confidenceScore).toBe(77);
  expect(analysis?.confidence).toBe(66);
});
