import type { Solution } from "../domain/types";

export type AutoAnswerGuardrailSettings = {
  caseUnderstandingThreshold: number;
  caseDiscriminationThreshold: number;
};

export function isSolutionReadyForAutoAnswer(
  caseConfidence: number | undefined,
  solution: Pick<Solution, "confidence" | "validatedByTeam" | "validatedAt">,
  settings: AutoAnswerGuardrailSettings,
) {
  return (
    (caseConfidence ?? 0) >= settings.caseUnderstandingThreshold &&
    solution.confidence >= settings.caseDiscriminationThreshold &&
    solution.validatedByTeam &&
    Boolean(solution.validatedAt)
  );
}

