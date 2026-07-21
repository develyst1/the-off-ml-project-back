import { describe, expect, test } from "bun:test";
import { isAutoAnswerRelevanceReady, isSolutionReadyForAutoAnswer } from "./auto-answer-guardrail";

const settings = {
  caseUnderstandingThreshold: 98,
  caseDiscriminationThreshold: 98,
};

describe("auto-answer guardrail", () => {
  test("requires both confidence levels and team validation", () => {
    expect(isSolutionReadyForAutoAnswer(98, { confidence: 98, validatedByTeam: true, validatedAt: "2026-07-21T00:00:00.000Z" }, settings)).toBe(true);
    expect(isSolutionReadyForAutoAnswer(97, { confidence: 100, validatedByTeam: true, validatedAt: "2026-07-21T00:00:00.000Z" }, settings)).toBe(false);
    expect(isSolutionReadyForAutoAnswer(100, { confidence: 97, validatedByTeam: true, validatedAt: "2026-07-21T00:00:00.000Z" }, settings)).toBe(false);
    expect(isSolutionReadyForAutoAnswer(100, { confidence: 100, validatedByTeam: false, validatedAt: undefined }, settings)).toBe(false);
    expect(isSolutionReadyForAutoAnswer(100, { confidence: 100, validatedByTeam: true, validatedAt: undefined }, settings)).toBe(false);
  });

  test("requires a high-confidence relevance match before sending an approved solution", () => {
    expect(isAutoAnswerRelevanceReady({ relevant: true, confidence: 98 }, settings)).toBe(true);
    expect(isAutoAnswerRelevanceReady({ relevant: true, confidence: 97 }, settings)).toBe(false);
    expect(isAutoAnswerRelevanceReady({ relevant: false, confidence: 100 }, settings)).toBe(false);
  });
});

