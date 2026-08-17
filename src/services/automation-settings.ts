import type { Solution } from "../domain/types";
import { store } from "../repositories/store";
import { isAutoAnswerRelevanceReady, isSolutionReadyForAutoAnswer } from "./auto-answer-guardrail";
import { evaluateLearnedReliabilityGate, type LearnedReliability, type LearnedReliabilityGateReason } from "./learned-reliability-service";

function learnedThresholdRatio(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value / 100 : 0.9;
}

export type AutoAnswerSolutionDecisionReason =
  | "AUTOMATION_DISABLED"
  | "EXISTING_GUARDRAIL_FAILED"
  | "AUTOMATION_SETTINGS_UNAVAILABLE"
  | LearnedReliabilityGateReason;

export type AutoAnswerSolutionDecision = {
  allowed: boolean;
  reason?: AutoAnswerSolutionDecisionReason;
  learnedReliability: LearnedReliability | null;
};

export async function evaluateAutoAnswerForSolution(
  _caseConfidence: number | undefined,
  solution: Pick<Solution, "confidence" | "solutionSteps" | "validatedByTeam" | "validatedAt">,
  options: { caseId?: string } = {},
): Promise<AutoAnswerSolutionDecision> {
  let settings;
  try {
    settings = await store.getAutomationSettings();
  } catch {
    return { allowed: false, reason: "AUTOMATION_SETTINGS_UNAVAILABLE", learnedReliability: null };
  }

  if (!settings.enabled) {
    return { allowed: false, reason: "AUTOMATION_DISABLED", learnedReliability: null };
  }
  if (!isSolutionReadyForAutoAnswer(_caseConfidence, solution, settings)) {
    return { allowed: false, reason: "EXISTING_GUARDRAIL_FAILED", learnedReliability: null };
  }

  const learnedReliability = await evaluateLearnedReliabilityGate({
    excludeCaseId: options.caseId,
    threshold: learnedThresholdRatio(settings.learnedReliabilityThreshold),
  });
  return {
    allowed: learnedReliability.allowed,
    reason: learnedReliability.reason,
    learnedReliability: learnedReliability.reliability,
  };
}

export async function isAutoAnswerAllowedForSolution(
  _caseConfidence: number | undefined,
  solution: Pick<Solution, "confidence" | "solutionSteps" | "validatedByTeam" | "validatedAt">,
  options: { caseId?: string } = {},
) {
  return (await evaluateAutoAnswerForSolution(_caseConfidence, solution, options)).allowed;
}

export async function getLearnedReliabilityForAutomation() {
  try {
    const settings = await store.getAutomationSettings();
    return evaluateLearnedReliabilityGate({ threshold: learnedThresholdRatio(settings.learnedReliabilityThreshold) });
  } catch {
    return { allowed: false, reason: "LEARNED_RELIABILITY_UNAVAILABLE" as const, reliability: null };
  }
}

export async function emergencyDisableAutoAnswer() {
  const current = await store.getAutomationSettings();
  if (!current.enabled && current.emergencyDisabledAt) {
    return { settings: current, duplicate: true };
  }
  const settings = await store.updateAutomationSettings({
    enabled: false,
    emergencyDisabledAt: new Date().toISOString(),
    updatedBy: "Tech Support Console",
  });
  return { settings, duplicate: false };
}

/* Keep the existing relevance guardrail available for callers that use it directly. */
export async function isAutoAnswerAllowedForRelevance(relevance: { relevant: boolean; confidence: number }) {
  try {
    const settings = await store.getAutomationSettings();
    return settings.enabled && isAutoAnswerRelevanceReady(relevance, settings);
  } catch {
    return false;
  }
}
