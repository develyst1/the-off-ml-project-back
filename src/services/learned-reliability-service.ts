import type { AiReviewFeedback } from "../domain/types";
import * as storeModule from "../repositories/store";

export const LEARNED_RELIABILITY_MINIMUM_SAMPLE = 5;
export const LEARNED_RELIABILITY_THRESHOLD = 0.9;

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

export type LearnedReliabilityGateReason =
  | "LEARNED_RELIABILITY_NO_DATA"
  | "LEARNED_RELIABILITY_INSUFFICIENT_DATA"
  | "UNDERSTANDING_RELIABILITY_BELOW_THRESHOLD"
  | "SOLUTION_RELIABILITY_BELOW_THRESHOLD"
  | "LEARNED_RELIABILITY_UNAVAILABLE";

export type LearnedReliabilityGate = {
  allowed: boolean;
  reason?: LearnedReliabilityGateReason;
  reliability: LearnedReliability | null;
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

export function evaluateLearnedReliabilitySnapshot(reliability: LearnedReliability): LearnedReliabilityGate {
  const dimensions = [reliability.issueUnderstanding, reliability.solutionSelection];

  if (dimensions.some((dimension) => dimension.status === "NO_DATA")) {
    return { allowed: false, reason: "LEARNED_RELIABILITY_NO_DATA", reliability };
  }
  if (dimensions.some((dimension) => dimension.status === "INSUFFICIENT_DATA")) {
    return { allowed: false, reason: "LEARNED_RELIABILITY_INSUFFICIENT_DATA", reliability };
  }
  if (reliability.issueUnderstanding.status !== "READY"
    || reliability.issueUnderstanding.reliability === null
    || !Number.isFinite(reliability.issueUnderstanding.reliability)
    || reliability.issueUnderstanding.reliability < LEARNED_RELIABILITY_THRESHOLD) {
    return { allowed: false, reason: "UNDERSTANDING_RELIABILITY_BELOW_THRESHOLD", reliability };
  }
  if (reliability.solutionSelection.status !== "READY"
    || reliability.solutionSelection.reliability === null
    || !Number.isFinite(reliability.solutionSelection.reliability)
    || reliability.solutionSelection.reliability < LEARNED_RELIABILITY_THRESHOLD) {
    return { allowed: false, reason: "SOLUTION_RELIABILITY_BELOW_THRESHOLD", reliability };
  }

  return { allowed: true, reliability };
}

export async function evaluateLearnedReliabilityGate(options: { excludeCaseId?: string } = {}): Promise<LearnedReliabilityGate> {
  try {
    return evaluateLearnedReliabilitySnapshot(await getLearnedReliability(options));
  } catch {
    return { allowed: false, reason: "LEARNED_RELIABILITY_UNAVAILABLE", reliability: null };
  }
}
