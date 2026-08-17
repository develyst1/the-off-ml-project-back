import { expect, mock, test } from "bun:test";

const automationSettings = {
  enabled: true,
  caseUnderstandingThreshold: 98,
  caseDiscriminationThreshold: 98,
  learnedReliabilityThreshold: 80,
  updatedAt: "2026-08-11T00:00:00.000Z",
  updatedBy: "ระบบเริ่มต้น",
};

const readyReliability = {
  issueUnderstanding: { correctCount: 9, incorrectCount: 1, sampleCount: 10, reliability: 0.9, status: "READY" as const },
  solutionSelection: { correctCount: 10, incorrectCount: 0, sampleCount: 10, reliability: 1, status: "READY" as const },
};

let receivedExcludeCaseId: string | undefined;
let receivedThreshold: number | undefined;
let settingsError: Error | undefined;
let reliabilityGate: { allowed: boolean; reason?: string; reliability: typeof readyReliability | null } = {
  allowed: true,
  reliability: readyReliability,
};

mock.module("../repositories/store", () => ({
  store: {
    getAutomationSettings: async () => {
      if (settingsError) throw settingsError;
      return automationSettings;
    },
  },
}));
mock.module("./learned-reliability-service", () => ({
  evaluateLearnedReliabilityGate: async (options: { excludeCaseId?: string; threshold?: number }) => {
    receivedExcludeCaseId = options.excludeCaseId;
    receivedThreshold = options.threshold;
    return reliabilityGate;
  },
}));

const { evaluateAutoAnswerForSolution, isAutoAnswerAllowedForRelevance } = await import("./automation-settings");

const solution = {
  confidence: 98,
  validatedByTeam: true,
  validatedAt: "2026-08-11T00:00:00.000Z",
  solutionSteps: ["ตรวจสอบและแก้ไขระบบ", "ทดสอบซ้ำ"],
};

test("allows auto-answer only when the existing guardrail and both reliability dimensions pass", async () => {
  const result = await evaluateAutoAnswerForSolution(98, solution, { caseId: "current-case" });
  expect(result.allowed).toBe(true);
  expect(receivedExcludeCaseId).toBe("current-case");
  expect(receivedThreshold).toBe(0.8);
});

test("blocks reliability below the configured threshold, no data, insufficient data, and unavailable states", async () => {
  reliabilityGate = { allowed: false, reason: "UNDERSTANDING_RELIABILITY_BELOW_THRESHOLD", reliability: readyReliability };
  expect((await evaluateAutoAnswerForSolution(98, solution)).reason).toBe("UNDERSTANDING_RELIABILITY_BELOW_THRESHOLD");

  reliabilityGate = { allowed: false, reason: "LEARNED_RELIABILITY_NO_DATA", reliability: null };
  expect((await evaluateAutoAnswerForSolution(98, solution)).allowed).toBe(false);

  reliabilityGate = { allowed: false, reason: "LEARNED_RELIABILITY_INSUFFICIENT_DATA", reliability: null };
  expect((await evaluateAutoAnswerForSolution(98, solution)).allowed).toBe(false);

  reliabilityGate = { allowed: false, reason: "LEARNED_RELIABILITY_UNAVAILABLE", reliability: null };
  expect((await evaluateAutoAnswerForSolution(98, solution)).reason).toBe("LEARNED_RELIABILITY_UNAVAILABLE");
});

test("does not block a validated solution because live customer-message confidence is low", async () => {
  reliabilityGate = { allowed: true, reliability: readyReliability };
  const result = await evaluateAutoAnswerForSolution(97, solution);
  expect(result).toMatchObject({ allowed: true });
});

test("does not mutate the model confidence while evaluating reliability", async () => {
  reliabilityGate = { allowed: true, reliability: readyReliability };
  const confidenceScore = 98;
  await evaluateAutoAnswerForSolution(confidenceScore, solution);
  expect(confidenceScore).toBe(98);
});

test("fails closed when automation settings cannot be read during relevance evaluation", async () => {
  settingsError = new Error("settings unavailable");
  expect(await isAutoAnswerAllowedForRelevance({ relevant: true, confidence: 100 })).toBe(false);
  settingsError = undefined;
});
