import { env } from "../config/env";
import type { CaseDetail } from "../domain/types";
import { categoryLabelOf } from "../lib/category";
import { getAnalysisTechnicalTopic } from "../lib/analysis";

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
      .filter((message) => message.senderType === "CUSTOMER")
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0];
    const latestAnalysis = [...caseDetail.analyses]
      .filter((analysis) => analysis.analysisType === "customer_message")
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0];
    const technicalTopic = getAnalysisTechnicalTopic(latestAnalysis);

    if (!latestCustomerMessage?.originalText?.trim()) {
      throw new Error("DATA_INCOMPLETE: customer message is missing");
    }

    const text = [
      `New Off ML Project case: เคส ${caseDetail.caseNumber}`,
      `Case number: ${caseDetail.caseNumber}`,
      `Title: ${caseDetail.title ?? latestAnalysis?.summary ?? "-"}`,
      `Customer: ${caseDetail.customer.displayName ?? caseDetail.customer.lineUserId}`,
      `Original: ${latestCustomerMessage?.originalText ?? "-"}`,
      `Summary: ${caseDetail.aiStatus === "AI_FAILED" ? "AI วิเคราะห์ไม่สำเร็จ" : latestAnalysis?.summary ?? "-"}`,
      `หมวดหมู่: ${categoryLabelOf(latestAnalysis?.category)}`,
      ...(technicalTopic ? [`หัวข้อปัญหา: ${technicalTopic}`] : []),
      `Confidence: ${caseDetail.aiStatus === "AI_FAILED" ? "ไม่พร้อมใช้งาน" : `${latestAnalysis?.confidence ?? 0}%`}`,
    ].join("\n");

    const data = {
      caseNumber: caseDetail.caseNumber,
      caseTitle: caseDetail.title ?? latestAnalysis?.summary ?? "-",
      caseId: caseDetail.id,
      customerName: caseDetail.customer.displayName ?? caseDetail.customer.lineUserId,
      originalText: latestCustomerMessage?.originalText ?? "-",
      summary: caseDetail.aiStatus === "AI_FAILED" ? "AI วิเคราะห์ไม่สำเร็จ" : latestAnalysis?.summary ?? "-",
      category: categoryLabelOf(latestAnalysis?.category),
      technicalTopic,
      confidence: latestAnalysis?.confidence ?? 0,
      aiStatus: caseDetail.aiStatus ?? "AI_SUCCESS",
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
          { title: "Case title", value: data.caseTitle },
          { title: "หมวดหมู่", value: data.category },
          ...(data.technicalTopic ? [{ title: "หัวข้อปัญหา", value: data.technicalTopic }] : []),
          { title: "AI confidence", value: `${data.confidence}%` },
        ] },
        { type: "TextBlock", wrap: true, text: `Customer message: ${data.originalText}` },
        { type: "TextBlock", wrap: true, text: `AI summary: ${data.summary}` },
        {
          type: "Input.Text",
          id: "replyText",
          label: "คำตอบจากทีม Tech Support",
          placeholder: "พิมพ์วิธีแก้ปัญหาหรือคำตอบให้ผู้ใช้งาน",
          isMultiline: true,
          maxLength: 4000,
        },
        {
          type: "Input.Text",
          id: "additionalInfoRequest",
          label: "ข้อความขอข้อมูลเพิ่มเติมจากผู้ใช้งาน",
          placeholder: "เช่น รบกวนส่งภาพหน้าจอหรือข้อความแจ้งเตือนเพิ่มเติม",
          isMultiline: true,
          maxLength: 2000,
        },
      ],
      actions: [
        {
          type: "Action.Submit",
          title: "วิเคราะห์และส่งให้ผู้ใช้งาน",
          data: { action: "REPLY_CUSTOMER", caseId: data.caseId, caseNumber: data.caseNumber },
        },
        {
          type: "Action.Submit",
          title: "ขอข้อมูลเพิ่มเติม",
          data: { action: "REQUEST_MORE_INFO", caseId: data.caseId, caseNumber: data.caseNumber },
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
    card.actions = card.actions.filter((action) => !("url" in action && action.url?.includes("action=request-info")));

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

  async notifyAutoAnswer(input: {
    caseId: string;
    caseNumber: string;
    caseMessageId: string;
    customerName: string;
    lineUserId: string;
    answerText: string;
    solutionId: string;
    solutionText: string;
    analysisId?: string;
    analysisVersion?: number;
    sentAt: string;
    lineDeliveryStatus: string;
  }): Promise<{ delivered: boolean }> {
    const card = {
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      type: "AdaptiveCard",
      version: "1.2",
      body: [
        { type: "TextBlock", size: "Large", weight: "Bolder", text: `Auto-answer sent - ${input.caseNumber}` },
        { type: "FactSet", facts: [
          { title: "Customer", value: input.customerName },
          { title: "LINE user", value: input.lineUserId },
          { title: "Case", value: `${input.caseNumber} (${input.caseId})` },
          { title: "Audit message", value: input.caseMessageId },
          { title: "Solution", value: input.solutionId },
          { title: "Analysis", value: input.analysisId ? `${input.analysisId} v${input.analysisVersion ?? "-"}` : "-" },
          { title: "LINE status", value: input.lineDeliveryStatus },
          { title: "Sent at", value: input.sentAt },
        ] },
        { type: "TextBlock", weight: "Bolder", text: "Auto-answer" },
        { type: "TextBlock", wrap: true, text: input.answerText },
        { type: "TextBlock", weight: "Bolder", text: "Referenced solution" },
        { type: "TextBlock", wrap: true, text: input.solutionText },
      ],
      actions: [
        {
          type: "Action.Submit",
          title: "Emergency disable auto-answer",
          data: {
            action: "EMERGENCY_DISABLE_AUTO_ANSWER",
            caseId: input.caseId,
            caseNumber: input.caseNumber,
            caseMessageId: input.caseMessageId,
          },
        },
        {
          type: "Action.OpenUrl",
          title: "Open case",
          url: `${env.FRONTEND_BASE_URL}/?caseId=${encodeURIComponent(input.caseId)}`,
        },
      ],
    };

    const webhookUrl = this.getWebhookUrl();
    if (!webhookUrl) return { delivered: false };
    const status = this.getStatus();
    if (!status.valid) throw new Error(status.reason ?? "TEAMS_WEBHOOK_URL is invalid");

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(card),
    });
    if (!response.ok) {
      throw new Error(`Teams auto-answer notification failed: ${response.status}`);
    }
    return { delivered: true };
  },

  async notifyOutOfScope(input: {
    customerName: string;
    lineUserId: string;
    text: string;
    reason?: string;
    eventType?: string;
  }): Promise<{ delivered: boolean }> {
    const text = [
      "Off ML Project - OUT_OF_SCOPE_MESSAGE",
      `Customer: ${input.customerName}`,
      `LINE user: ${input.lineUserId}`,
      `Message: ${input.text}`,
      `Reason: ${input.reason ?? "-"}`,
    ].join("\n");
    const card = {
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      type: "AdaptiveCard",
      version: "1.2",
      body: [
        { type: "TextBlock", size: "Large", weight: "Bolder", text: "Off ML Project - OUT_OF_SCOPE_MESSAGE" },
        { type: "FactSet", facts: [
          { title: "Customer", value: input.customerName },
          { title: "LINE user", value: input.lineUserId },
          { title: "Event", value: input.eventType ?? "OUT_OF_SCOPE_MESSAGE" },
        ] },
        { type: "TextBlock", wrap: true, text: input.text },
        { type: "TextBlock", wrap: true, isSubtle: true, text: input.reason ?? "No case was created" },
      ],
    };
    const webhookUrl = this.getWebhookUrl();
    if (!webhookUrl) {
      console.log("[teams:mock]", text);
      return { delivered: false };
    }
    const status = this.getStatus();
    if (!status.valid) throw new Error(status.reason ?? "TEAMS_WEBHOOK_URL is invalid");
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(card),
    });
    if (!response.ok) {
      throw new Error(`Teams out-of-scope notification failed: ${response.status} ${await response.text()}`);
    }
    return { delivered: true };
  },
};
