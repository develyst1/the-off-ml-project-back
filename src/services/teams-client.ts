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
    const latestCustomerMessage = [...caseDetail.messages]
      .filter((message) => message.direction === "inbound_customer")
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0];
    const latestAnalysis = [...caseDetail.analyses]
      .filter((analysis) => analysis.analysisType === "customer_message")
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0];

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
          { title: "Case ID", value: data.caseId },
          { title: "Category", value: data.category },
          { title: "AI confidence", value: `${data.confidence}%` },
        ] },
        { type: "TextBlock", wrap: true, text: `Customer message: ${data.originalText}` },
        { type: "TextBlock", wrap: true, text: `AI summary: ${data.summary}` },
        {
          type: "Input.Text",
          id: "techReplyText",
          label: "คำตอบจากทีม Tech Support",
          placeholder: "พิมพ์วิธีแก้ปัญหาหรือคำตอบให้ลูกค้า",
          isMultiline: true,
          maxLength: 4000,
        },
        {
          type: "Input.Text",
          id: "requestInfoText",
          label: "ข้อความขอข้อมูลเพิ่มเติมจากลูกค้า",
          placeholder: "เช่น รบกวนส่งภาพหน้าจอหรือข้อความแจ้งเตือนเพิ่มเติม",
          isMultiline: true,
          maxLength: 2000,
        },
      ],
      actions: [
        {
          type: "Action.Submit",
          title: "วิเคราะห์และส่งให้ลูกค้า",
          data: { action: "reply", caseId: data.caseId, caseNumber: data.caseNumber },
        },
        {
          type: "Action.Submit",
          title: "ขอข้อมูลเพิ่มเติม",
          data: { action: "request-info", caseId: data.caseId, caseNumber: data.caseNumber },
        },
        {
          type: "Action.OpenUrl",
          title: "เปิดเคสในระบบ",
          url: `${env.FRONTEND_BASE_URL}/?caseId=${encodeURIComponent(data.caseId)}`,
        },
        {
          type: "Action.OpenUrl",
          title: "รับเคส",
          url: `${env.FRONTEND_BASE_URL}/?caseId=${encodeURIComponent(data.caseId)}&action=accept`,
        },
        {
          type: "Action.OpenUrl",
          title: "ขอข้อมูลเพิ่ม",
          url: `${env.FRONTEND_BASE_URL}/?caseId=${encodeURIComponent(data.caseId)}&action=request-info`,
        },
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

    // The Power Automate flow posts the Body variable directly as an Adaptive Card.
    // Send the card as the webhook root so triggerBody() resolves to a valid card.
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(card),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Teams notification failed: ${response.status} ${errorBody}`);
    }

    return { delivered: true };
  },
};
