import type { Solution } from "../domain/types";
import { hasActionableSolutionSteps } from "../lib/solution-quality";

export type AutoAnswerGuardrailSettings = {
  caseUnderstandingThreshold: number;
  caseDiscriminationThreshold: number;
};

export function isSolutionReadyForAutoAnswer(
  caseConfidence: number | undefined,
  solution: Pick<Solution, "confidence" | "validatedByTeam" | "validatedAt" | "solutionSteps">,
  settings: AutoAnswerGuardrailSettings,
) {
  return (
    (caseConfidence ?? 0) >= settings.caseUnderstandingThreshold &&
    solution.confidence >= settings.caseDiscriminationThreshold &&
    solution.validatedByTeam &&
    Boolean(solution.validatedAt) &&
    hasActionableSolutionSteps(solution.solutionSteps)
  );
}

export function isAutoAnswerRelevanceReady(
  relevance: Pick<{ relevant: boolean; confidence: number }, "relevant" | "confidence">,
  settings: AutoAnswerGuardrailSettings,
) {
  return relevance.relevant && relevance.confidence >= settings.caseDiscriminationThreshold;
}

