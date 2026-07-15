import { env } from "../config/env";
import type { CaseDetail } from "../domain/types";

export const teamsClient = {
  getWebhookUrl() {
    const value = env.TEAMS_WEBHOOK_URL?.trim();
    if (!value) return undefined;
    return value.replace(/^("|')|("|')$/g, "");
  },

  getStatus() {
    const value = this.getWebhookUrl();
    if (!value) {
      return { connected: false, valid: false, mode: "mock" as const, reason: "TEAMS_WEBHOOK_URL is empty" };
    }

    try {
      const url = new URL(value);
      if (url.protocol !== "https:") {
        return { connected: true, valid: false, mode: "incoming_webhook" as const, reason: "TEAMS_WEBHOOK_URL must use HTTPS" };
      }

      return { connected: true, valid: true, mode: "incoming_webhook" as const, host: url.host };
    } catch {
      return { connected: true, valid: false, mode: "incoming_webhook" as const, reason: "TEAMS_WEBHOOK_URL is not a valid URL" };
    }
  },

  isConfigured() {
    return this.getStatus().valid;
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

    const webhookUrl = this.getWebhookUrl();
    if (!webhookUrl) {
      console.log("[teams:mock]", text);
      return { delivered: false };
    }

    if (!this.getStatus().valid) {
      throw new Error(this.getStatus().reason ?? "TEAMS_WEBHOOK_URL is invalid");
    }

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        "@type": "MessageCard",
        "@context": "https://schema.org/extensions",
        summary: `Off ML Project case ${caseDetail.caseNumber}`,
        themeColor: "0078D4",
        title: `Off ML Project - Case ${caseDetail.caseNumber}`,
        event: "off_ml_project_case_created",
        text,
        data,
        card,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Teams notification failed: ${response.status} ${errorBody}`);
    }

    return { delivered: true };
  },
};
