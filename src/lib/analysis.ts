import type { Analysis } from "../domain/types";

export function getLatestCustomerMessageAnalysis(analyses: readonly Analysis[]) {
  return [...analyses]
    .filter((analysis) => analysis.analysisType === "customer_message")
    .sort((left, right) => (
      right.analysisVersion - left.analysisVersion
      || new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
    ))[0];
}
