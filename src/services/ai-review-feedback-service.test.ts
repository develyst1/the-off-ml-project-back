import { expect, mock, test } from "bun:test";
import { InMemoryStore } from "../repositories/in-memory-store";

const store = new InMemoryStore();
mock.module("../repositories/store", () => ({ store }));

const { saveAiReviewFeedback } = await import("./ai-review-feedback-service");

test("updates the same feedback record for a case analysis version and feedback type", async () => {
  const customer = await store.upsertCustomer({ lineUserId: "U-ai-review-feedback" });
  const supportCase = await store.createCase({ customerId: customer.id, status: "closed" });
  const analysis = await store.createAnalysis({
    caseId: supportCase.id,
    analysisType: "customer_message",
    confidence: 90,
    rawJson: {},
  });

  const firstFeedback = await saveAiReviewFeedback({
    caseId: supportCase.id,
    analysisId: analysis.analysisId,
    analysisVersion: analysis.analysisVersion,
    feedbackType: "ISSUE_UNDERSTANDING",
    result: "CORRECT",
    reviewSource: "CASE_DETAIL",
    reviewedBy: "Tech Support",
  });
  const updatedFeedback = await saveAiReviewFeedback({
    caseId: supportCase.id,
    analysisId: analysis.analysisId,
    analysisVersion: analysis.analysisVersion,
    feedbackType: "ISSUE_UNDERSTANDING",
    result: "INCORRECT",
    reviewSource: "CONFIDENCE_REVIEW",
    reason: "สรุปอาการไม่ตรงกับข้อมูลที่แจ้ง",
  });

  expect(updatedFeedback.id).toBe(firstFeedback.id);
  expect(updatedFeedback.result).toBe("INCORRECT");
  expect(updatedFeedback.reviewSource).toBe("CONFIDENCE_REVIEW");
  expect(updatedFeedback.reason).toBe("สรุปอาการไม่ตรงกับข้อมูลที่แจ้ง");
});

test("rejects feedback that points to a different analysis version", async () => {
  const customer = await store.upsertCustomer({ lineUserId: "U-ai-review-invalid" });
  const supportCase = await store.createCase({ customerId: customer.id, status: "closed" });
  const analysis = await store.createAnalysis({
    caseId: supportCase.id,
    analysisType: "customer_message",
    confidence: 90,
    rawJson: {},
  });

  await expect(saveAiReviewFeedback({
    caseId: supportCase.id,
    analysisId: analysis.analysisId,
    analysisVersion: analysis.analysisVersion + 1,
    feedbackType: "SOLUTION_SELECTION",
    result: "CORRECT",
    reviewSource: "CASE_DETAIL",
  })).rejects.toThrow("Analysis does not match the selected case version");
});

test("keeps feedback separate when a case is analyzed again", async () => {
  const customer = await store.upsertCustomer({ lineUserId: "U-ai-review-reanalysis" });
  const supportCase = await store.createCase({ customerId: customer.id, status: "closed" });
  const firstAnalysis = await store.createAnalysis({
    caseId: supportCase.id,
    analysisType: "customer_message",
    confidence: 90,
    rawJson: {},
  });
  const firstFeedback = await saveAiReviewFeedback({
    caseId: supportCase.id,
    analysisId: firstAnalysis.analysisId,
    analysisVersion: firstAnalysis.analysisVersion,
    feedbackType: "ISSUE_UNDERSTANDING",
    result: "CORRECT",
    reviewSource: "CASE_DETAIL",
  });
  const secondAnalysis = await store.createAnalysis({
    caseId: supportCase.id,
    analysisType: "customer_message",
    confidence: 92,
    rawJson: {},
  });
  const secondFeedback = await saveAiReviewFeedback({
    caseId: supportCase.id,
    analysisId: secondAnalysis.analysisId,
    analysisVersion: secondAnalysis.analysisVersion,
    feedbackType: "ISSUE_UNDERSTANDING",
    result: "INCORRECT",
    reviewSource: "CASE_DETAIL",
  });

  expect(secondAnalysis.analysisVersion).toBe(firstAnalysis.analysisVersion + 1);
  expect(secondFeedback.id).not.toBe(firstFeedback.id);
  expect(firstFeedback.analysisVersion).toBe(firstAnalysis.analysisVersion);
  expect(secondFeedback.analysisVersion).toBe(secondAnalysis.analysisVersion);
});

test("clears an incorrect note when the same feedback is corrected", async () => {
  const customer = await store.upsertCustomer({ lineUserId: "U-ai-review-note-clear" });
  const supportCase = await store.createCase({ customerId: customer.id, status: "closed" });
  const analysis = await store.createAnalysis({
    caseId: supportCase.id,
    analysisType: "customer_message",
    confidence: 88,
    rawJson: {},
  });
  const incorrect = await saveAiReviewFeedback({
    caseId: supportCase.id,
    analysisId: analysis.analysisId,
    analysisVersion: analysis.analysisVersion,
    feedbackType: "ISSUE_UNDERSTANDING",
    result: "INCORRECT",
    reviewSource: "CASE_DETAIL",
    reason: "ใช้ข้อมูลคนละช่วงเวลา",
  });
  const corrected = await saveAiReviewFeedback({
    caseId: supportCase.id,
    analysisId: analysis.analysisId,
    analysisVersion: analysis.analysisVersion,
    feedbackType: "ISSUE_UNDERSTANDING",
    result: "CORRECT",
    reviewSource: "CASE_DETAIL",
  });

  expect(corrected.id).toBe(incorrect.id);
  expect(corrected.reason).toBeUndefined();
  expect((await store.getCaseDetail(supportCase.id))?.confidenceScore).toBeUndefined();
});

test("rejects Case Detail feedback before the case is closed", async () => {
  const customer = await store.upsertCustomer({ lineUserId: "U-ai-review-open-case" });
  const supportCase = await store.createCase({ customerId: customer.id, status: "assigned" });
  const analysis = await store.createAnalysis({
    caseId: supportCase.id,
    analysisType: "customer_message",
    confidence: 90,
    rawJson: {},
  });

  await expect(saveAiReviewFeedback({
    caseId: supportCase.id,
    analysisId: analysis.analysisId,
    analysisVersion: analysis.analysisVersion,
    feedbackType: "ISSUE_UNDERSTANDING",
    result: "CORRECT",
    reviewSource: "CASE_DETAIL",
  })).rejects.toThrow("กรุณาปิดเคสก่อนบันทึกผลการตรวจ AI");
  expect((await store.listAiReviewFeedback()).filter((item) => item.caseId === supportCase.id)).toHaveLength(0);
});

test("keeps Confidence Review available while the case is open", async () => {
  const customer = await store.upsertCustomer({ lineUserId: "U-ai-review-confidence-open-case" });
  const supportCase = await store.createCase({ customerId: customer.id, status: "assigned" });
  const analysis = await store.createAnalysis({
    caseId: supportCase.id,
    analysisType: "customer_message",
    confidence: 85,
    rawJson: {},
  });

  const feedback = await saveAiReviewFeedback({
    caseId: supportCase.id,
    analysisId: analysis.analysisId,
    analysisVersion: analysis.analysisVersion,
    feedbackType: "ISSUE_UNDERSTANDING",
    result: "INCORRECT",
    reviewSource: "CONFIDENCE_REVIEW",
    reason: "สรุปเคสไม่ตรง",
  });

  expect(feedback.reviewSource).toBe("CONFIDENCE_REVIEW");
  expect(feedback.result).toBe("INCORRECT");
});
