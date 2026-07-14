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

    const data = {
      caseNumber: caseDetail.caseNumber,
      caseId: caseDetail.id,
      customerName: caseDetail.customer.displayName ?? caseDetail.customer.lineUserId,
      originalText: latestCustomerMessage?.originalText ?? "-",
      summary: latestAnalysis?.summary ?? "-",
      category: latestAnalysis?.category ?? "-",
      confidence: latestAnalysis?.confidence ?? 0,
    };

    const card = {
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      type: "AdaptiveCard",
      version: "1.2",
      body: [
        { type: "TextBlock", size: "Large", weight: "Bolder", text: `Off ML Project - Case ${data.caseNumber}` },
        { type: "FactSet", facts: [
          { title: "Customer", value: data.customerName },
          { title: "Category", value: data.category },
          { title: "AI confidence", value: `${data.confidence}%` },
        ] },
        { type: "TextBlock", wrap: true, text: `Customer message: ${data.originalText}` },
        { type: "TextBlock", wrap: true, text: `AI summary: ${data.summary}` },
      ],
    };

    if (!env.TEAMS_WEBHOOK_URL) {
      console.log("[teams:mock]", text);
      return { delivered: false };
    }

    const response = await fetch(env.TEAMS_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "off_ml_project_case_created",
        text,
        data,
        card,
      }),
    });

    if (!response.ok) {
      throw new Error(`Teams notification failed: ${response.status}`);
    }

    return { delivered: true };
  },
};
