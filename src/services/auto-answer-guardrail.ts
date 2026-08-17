import type { Solution } from "../domain/types";
import { hasActionableSolutionSteps } from "../lib/solution-quality";

export type AutoAnswerGuardrailSettings = {
  caseUnderstandingThreshold: number;
  caseDiscriminationThreshold: number;
};

export function isSolutionReadyForAutoAnswer(
  _caseConfidence: number | undefined,
  solution: Pick<Solution, "confidence" | "validatedByTeam" | "validatedAt" | "solutionSteps">,
  settings: AutoAnswerGuardrailSettings,
) {
  // The live customer-message confidence is informational only. It changes
  // whenever a follow-up is re-analysed and must not remove an already
  // validated solution from the guardrail. Human feedback remains the source
  // for Learned Reliability through the existing closed-case/Formal Review flows.
  return (
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

