import { describe, expect, test } from "bun:test";
import { isSolutionReadyForAutoAnswer } from "./auto-answer-guardrail";

const settings = {
  caseUnderstandingThreshold: 98,
  caseDiscriminationThreshold: 98,
};

describe("auto-answer guardrail", () => {
  test("requires both confidence levels and team validation", () => {
    expect(isSolutionReadyForAutoAnswer(98, { confidence: 98, validatedByTeam: true }, settings)).toBe(true);
    expect(isSolutionReadyForAutoAnswer(97, { confidence: 100, validatedByTeam: true }, settings)).toBe(false);
    expect(isSolutionReadyForAutoAnswer(100, { confidence: 97, validatedByTeam: true }, settings)).toBe(false);
    expect(isSolutionReadyForAutoAnswer(100, { confidence: 100, validatedByTeam: false }, settings)).toBe(false);
  });
});

