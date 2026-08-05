import { expect, test } from "bun:test";
import { InMemoryStore } from "./in-memory-store";

test("assigns an increasing analysis version for each case independently", async () => {
  const store = new InMemoryStore();
  const customer = await store.upsertCustomer({ lineUserId: "U-analysis-version", displayName: "Test user" });
  const firstCase = await store.createCase({ customerId: customer.id, status: "analyzing" });
  const secondCase = await store.createCase({ customerId: customer.id, status: "analyzing" });

  const firstAnalysis = await store.createAnalysis({
    caseId: firstCase.id,
    analysisType: "customer_message",
    confidence: 80,
    rawJson: {},
  });
  const secondAnalysis = await store.createAnalysis({
    caseId: firstCase.id,
    analysisType: "tech_solution",
    confidence: 82,
    rawJson: {},
  });
  const otherCaseAnalysis = await store.createAnalysis({
    caseId: secondCase.id,
    analysisType: "customer_message",
    confidence: 75,
    rawJson: {},
  });

  expect(firstAnalysis.analysisVersion).toBe(1);
  expect(firstAnalysis.analysisId).toBe(firstAnalysis.id);
  expect(secondAnalysis.analysisVersion).toBe(2);
  expect(otherCaseAnalysis.analysisVersion).toBe(1);
});
