import { env } from "../config/env";
import type { CaseDetail } from "../domain/types";

export const teamsClient = {
  async notifyCase(caseDetail: CaseDetail): Promise<{ delivered: boolean; externalId?: string }> {
    const latestCustomerMessage = caseDetail.messages.find((message) => message.direction === "inbound_customer");
    const latestAnalysis = caseDetail.analyses.find((analysis) => analysis.analysisType === "customer_message");

    const text = [
      `New Off Mai case: ${caseDetail.id}`,
      `Customer: ${caseDetail.customer.displayName ?? caseDetail.customer.lineUserId}`,
      `Original: ${latestCustomerMessage?.originalText ?? "-"}`,
      `Summary: ${latestAnalysis?.summary ?? "-"}`,
      `Category: ${latestAnalysis?.category ?? "-"}`,
      `Confidence: ${latestAnalysis?.confidence ?? 0}%`,
    ].join("\n");

    if (!env.TEAMS_WEBHOOK_URL) {
      console.log("[teams:mock]", text);
      return { delivered: false };
    }

    const response = await fetch(env.TEAMS_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      throw new Error(`Teams notification failed: ${response.status}`);
    }

    return { delivered: true };
  },
};
