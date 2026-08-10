import type { AiReviewFeedback } from "../domain/types";
import * as storeModule from "../repositories/store";

export const LEARNED_RELIABILITY_MINIMUM_SAMPLE = 5;

export type LearnedReliabilityStatus = "NO_DATA" | "INSUFFICIENT_DATA" | "READY";

export type LearnedReliabilityDimension = {
  correctCount: number;
  incorrectCount: number;
  sampleCount: number;
  reliability: number | null;
  status: LearnedReliabilityStatus;
};

export type LearnedReliability = {
  issueUnderstanding: LearnedReliabilityDimension;
  solutionSelection: LearnedReliabilityDimension;
};

function dimensionFromFeedback(feedback: AiReviewFeedback[]): LearnedReliabilityDimension {
  const correctCount = feedback.filter((item) => item.result === "CORRECT").length;
  const incorrectCount = feedback.filter((item) => item.result === "INCORRECT").length;
  const sampleCount = correctCount + incorrectCount;

  return {
    correctCount,
    incorrectCount,
    sampleCount,
    reliability: sampleCount >= LEARNED_RELIABILITY_MINIMUM_SAMPLE ? correctCount / sampleCount : null,
    status: sampleCount === 0
      ? "NO_DATA"
      : sampleCount < LEARNED_RELIABILITY_MINIMUM_SAMPLE
        ? "INSUFFICIENT_DATA"
        : "READY",
  };
}

/** Calculates global reliability from the latest persisted review state. */
export async function getLearnedReliability(options: { excludeCaseId?: string } = {}): Promise<LearnedReliability> {
  const feedback = await storeModule.store.listAiReviewFeedbackForReliability(options);
  const byType = (feedbackType: AiReviewFeedback["feedbackType"]) => feedback.filter((item) => item.feedbackType === feedbackType);

  return {
    issueUnderstanding: dimensionFromFeedback(byType("ISSUE_UNDERSTANDING")),
    solutionSelection: dimensionFromFeedback(byType("SOLUTION_SELECTION")),
  };
}
