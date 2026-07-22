import type { Solution } from "../domain/types";
import { store } from "../repositories/store";
import { isAutoAnswerRelevanceReady, isSolutionReadyForAutoAnswer } from "./auto-answer-guardrail";

export async function isAutoAnswerAllowedForSolution(caseConfidence: number | undefined, solution: Pick<Solution, "confidence" | "solutionSteps" | "validatedByTeam" | "validatedAt">) {
  const settings = await store.getAutomationSettings();
  return settings.enabled && isSolutionReadyForAutoAnswer(caseConfidence, solution, settings);
}

export async function isAutoAnswerAllowedForRelevance(relevance: { relevant: boolean; confidence: number }) {
  const settings = await store.getAutomationSettings();
  return settings.enabled && isAutoAnswerRelevanceReady(relevance, settings);
}
