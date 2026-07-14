import { env } from "../config/env";
import type { CaseDetail } from "../domain/types";

export const teamsClient = {
  isConfigured() {
    return Boolean(env.TEAMS_WEBHOOK_URL);
  },

  async notifyCase(caseDetail: CaseDetail): Promise<{ delivered: boolean; externalId?: string }> {
    const latestCustomerMessage = caseDetail.messages.find((message) => message.direction === "inbound_customer");
    const latestAnalysis = caseDetail.analyses.find((analysis) => analysis.analysisType === "customer_message");

    const text = [
      `New Off ML Project case: เคส ${caseDetail.caseNumber}`,
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
      body: JSON.stringify({
        "@type": "MessageCard",
        "@context": "https://schema.org/extensions",
        summary: `Off ML Project case ${caseDetail.caseNumber}`,
        themeColor: "0078D4",
        title: `Off ML Project - Case ${caseDetail.caseNumber}`,
        text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Teams notification failed: ${response.status}`);
    }

    return { delivered: true };
  },
};
