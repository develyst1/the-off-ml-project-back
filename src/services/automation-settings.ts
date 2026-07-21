import type { Solution } from "../domain/types";
import { store } from "../repositories/store";
import { isSolutionReadyForAutoAnswer } from "./auto-answer-guardrail";

export async function isAutoAnswerAllowedForSolution(caseConfidence: number | undefined, solution: Pick<Solution, "confidence" | "validatedByTeam" | "validatedAt">) {
  const settings = await store.getAutomationSettings();
  return settings.enabled && isSolutionReadyForAutoAnswer(caseConfidence, solution, settings);
}
