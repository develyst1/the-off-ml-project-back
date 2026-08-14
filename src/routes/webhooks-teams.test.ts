import { describe, expect, mock, test } from "bun:test";
import { InMemoryStore } from "../repositories/in-memory-store";

const store = new InMemoryStore();
let lineShouldFail = false;
let lineSendCount = 0;
let aiAnalysisShouldFail = false;
type CapturedCustomerAnalysisInput = {
  text: string;
  conversationContext?: string[];
  latestUserClarification?: { content: string; createdAt: string };
  caseAnalysisContext?: unknown;
};
let lastCustomerAnalysisInput: CapturedCustomerAnalysisInput | undefined;
type CapturedTechSolutionInput = { techReplyText: string; originalCustomerText?: string };
let lastTechSolutionInput: CapturedTechSolutionInput | undefined;

mock.module("../repositories/store", () => ({ store }));
mock.module("../services/line-client", () => ({
  lineClient: {
    getProfile: async () => undefined,
    reply: async () => {
      lineSendCount += 1;
      if (lineShouldFail) throw new Error("LINE token rejected");
      return { delivered: true };
    },
    replyToToken: async () => ({ delivered: true }),
  },
}));
mock.module("../services/teams-client", () => ({
  teamsClient: {
    notifyCase: async () => ({ delivered: true }),
    notifyAutoAnswer: async () => ({ delivered: true }),
  },
}));
mock.module("../services/ai-center-client", () => ({
  aiCenterClient: {
    analyzeCustomerMessage: async (input: CapturedCustomerAnalysisInput) => {
      lastCustomerAnalysisInput = input;
      return aiAnalysisShouldFail
        ? ({ status: "AI_FAILED", summary: "failed", caseTitle: "title", category: "category", urgency: "medium", confidence: 50, missingInformation: [] })
        : ({ status: "AI_SUCCESS", summary: "summary", caseTitle: "title", category: "category", urgency: "medium", confidence: 85, missingInformation: [] });
    },
    analyzeCaseRelation: async () => ({ related: true, confidence: 100, reason: "test" }),
    extractPendingInformation: async () => ({ values: {} }),
    generateLineContinuationReply: async () => "รับทราบค่ะ",
    rewriteCustomerReply: async ({ rawSupportMessage }: { rawSupportMessage: string }) => ({ rewrittenMessage: rawSupportMessage }),
    rewriteAdditionalInfoRequest: async () => ({ rewrittenMessage: "ขอข้อมูลเพิ่มค่ะ" }),
    generateMoreInfoRequest: async () => ({ suggestedMessage: "รบกวนแจ้งภาพหน้าจอเพิ่มเติมนะคะ", requestedFields: ["ภาพหน้าจอ"], reason: "ยังขาดภาพหน้าจอ" }),
    composeCustomerReply: async ({ supportInstruction }: { supportInstruction?: string }) => ({
      suggestedMessage: supportInstruction ? `ร่างคำตอบตามแนวทาง: ${supportInstruction}` : "ขอบคุณสำหรับข้อมูลล่าสุดค่ะ เดี๋ยวช่วยตรวจสอบต่อให้นะคะ",
      suggestedMode: "CUSTOMER_REPLY",
      missingInformation: [],
      reason: "ใช้ข้อความล่าสุดของลูกค้าและประวัติเคส",
    }),
    analyzeTechSolution: async (input: CapturedTechSolutionInput) => {
      lastTechSolutionInput = input;
      return {
        solutionSteps: [],
        teamActions: ["รีเซ็ตข้อมูลในระบบแล้ว"],
        rewrittenCustomerText: "",
      };
    },
    reviewTechMessageForCustomer: async () => ({ shouldSendToCustomer: false, reviewFailed: false }),
  },
}));

const { app } = await import("../app");

let sequence = 0;

async function createCase(confidenceScore?: number) {
  sequence += 1;
  const customer = await store.upsertCustomer({ lineUserId: `U-teams-${sequence}`, displayName: `Teams customer ${sequence}` });
  return store.createCase({ customerId: customer.id, status: "assigned", title: "Teams action test", confidenceScore });
}

function postAction(body: Record<string, unknown>) {
  return app.fetch(new Request("http://localhost/webhooks/teams/actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

function postCompose(caseId: string, body: Record<string, unknown>) {
  return app.fetch(new Request(`http://localhost/cases/${caseId}/ai-compose`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

function postRefreshSolution(caseId: string) {
  return app.fetch(new Request(`http://localhost/cases/${caseId}/refresh-solution`, {
    method: "POST",
  }));
}

function getCase(caseId: string) {
  return app.fetch(new Request(`http://localhost/cases/${caseId}`, {
    method: "GET",
  }));
}

function patchAiFeedback(caseId: string, body: Record<string, unknown>) {
  return app.fetch(new Request(`http://localhost/cases/${caseId}/ai-feedback`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

function openInboxCase(customerId: string, body: Record<string, unknown>) {
  return app.fetch(new Request(`http://localhost/inbox/${customerId}/open-case`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

function postConfidenceReview(body: Record<string, unknown>, suggestionId: string) {
  return app.fetch(new Request(`http://localhost/confidence/suggestions/${suggestionId}/review`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function createMixedAnalysisReviewFixture(options: { customerFeedbackSource?: "CASE_DETAIL" | "CONFIDENCE_REVIEW" } = {}) {
  const supportCase = await createCase(85);
  const customerAnalysis = await store.createAnalysis({
    caseId: supportCase.id,
    analysisType: "customer_message",
    confidence: 85,
    rawJson: {},
  });
  const solution = await store.createSolution({
    caseId: supportCase.id,
    rawReplyText: "restart service",
    solutionSteps: ["restart service"],
    rewrittenCustomerText: "restart service",
    confidence: 95,
    validatedByTeam: false,
  });
  await store.createAnalysis({
    caseId: supportCase.id,
    analysisType: "tech_solution",
    confidence: 95,
    rawJson: {},
  });
  const latestTechAnalysis = await store.createAnalysis({
    caseId: supportCase.id,
    analysisType: "tech_solution",
    confidence: 95,
    rawJson: {},
  });

  if (options.customerFeedbackSource) {
    for (const feedbackType of ["ISSUE_UNDERSTANDING", "SOLUTION_SELECTION"] as const) {
      await store.upsertAiReviewFeedback({
        caseId: supportCase.id,
        analysisId: customerAnalysis.analysisId,
        analysisVersion: customerAnalysis.analysisVersion,
        feedbackType,
        result: feedbackType === "SOLUTION_SELECTION" && options.customerFeedbackSource === "CASE_DETAIL" ? "INCORRECT" : "CORRECT",
        reviewSource: options.customerFeedbackSource,
      });
    }
  }

  for (const feedbackType of ["ISSUE_UNDERSTANDING", "SOLUTION_SELECTION"] as const) {
    await store.upsertAiReviewFeedback({
      caseId: supportCase.id,
      analysisId: latestTechAnalysis.analysisId,
      analysisVersion: latestTechAnalysis.analysisVersion,
      feedbackType,
      result: "CORRECT",
      reviewSource: "CONFIDENCE_REVIEW",
    });
  }

  return { supportCase, customerAnalysis, latestTechAnalysis, solution };
}

describe("POST /webhooks/teams/actions", () => {
  test("re-analysis creates a new customer analysis from the latest case messages", async () => {
    const supportCase = await createCase(75);
    const initialInboxMessageId = `inbox-initial-${sequence}`;
    const initialMessage = await store.createMessage({
      caseId: supportCase.id,
      direction: "INBOUND",
      channel: "line",
      originalText: "ไฟล์ขนาด 30 MB อัปโหลดไม่ได้",
      senderType: "CUSTOMER",
      messageType: "CUSTOMER_MESSAGE",
      deliveryStatus: "RECEIVED",
      metadata: { sourceInboxMessageId: initialInboxMessageId },
    });
    const initialAnalysis = await store.createAnalysis({
      caseId: supportCase.id,
      messageId: initialMessage.id,
      analysisType: "customer_message",
      summary: "ปัญหาไฟล์",
      category: "ปัญหาการอัปโหลด",
      confidence: 75,
      rawJson: { sourceMessageIds: [initialInboxMessageId] },
    });
    await store.upsertAiReviewFeedback({
      caseId: supportCase.id,
      analysisId: initialAnalysis.analysisId,
      analysisVersion: initialAnalysis.analysisVersion,
      feedbackType: "ISSUE_UNDERSTANDING",
      result: "CORRECT",
      reviewSource: "CASE_DETAIL",
    });
    const newInboxMessageId = `inbox-new-${sequence}`;
    const newMessage = await store.createMessage({
      caseId: supportCase.id,
      direction: "INBOUND",
      channel: "line",
      originalText: "ทีม Tech รีสตาร์ต service แล้ว ไฟล์เริ่มประมวลผลใหม่",
      senderType: "TECH",
      messageType: "TECH_REPLY",
      deliveryStatus: "SENT",
      metadata: { sourceInboxMessageId: newInboxMessageId },
    });

    const response = await postRefreshSolution(supportCase.id);
    const body = await response.json() as { data: { currentAnalysis?: { id: string; analysisVersion: number; createdAt: string; summary?: string; sourceMessageIds?: string[] }; analyses: Array<{ analysisId: string; analysisVersion: number; analysisType: string; confidence: number; createdAt: string; summary?: string; rawJson: unknown }>; aiFeedback?: { analysisId?: string; analysisVersion?: number; issueUnderstanding?: string; issueUnderstandingReason?: string } } };
    const reanalysis = body.data.analyses.find((analysis) => analysis.analysisType === "customer_message" && analysis.analysisVersion > initialAnalysis.analysisVersion);
    const rawJson = reanalysis?.rawJson as { sourceMessageIds?: string[] } | undefined;

    expect(response.status).toBe(200);
    expect(reanalysis).toBeDefined();
    expect(reanalysis?.analysisId).not.toBe(initialAnalysis.analysisId);
    expect(reanalysis?.analysisVersion).toBe(initialAnalysis.analysisVersion + 1);
    expect(reanalysis?.createdAt).not.toBe(initialAnalysis.createdAt);
    expect(rawJson?.sourceMessageIds).toContain(initialInboxMessageId);
    expect(rawJson?.sourceMessageIds).toContain(newInboxMessageId);
    expect(body.data.currentAnalysis?.id).toBe(reanalysis?.analysisId);
    expect(body.data.currentAnalysis?.analysisVersion).toBe(reanalysis?.analysisVersion);
    expect(body.data.currentAnalysis?.summary).toBe(reanalysis?.summary);
    expect(body.data.currentAnalysis?.sourceMessageIds).toContain(initialInboxMessageId);
    expect(body.data.currentAnalysis?.sourceMessageIds).toContain(newInboxMessageId);
    expect(body.data.aiFeedback?.analysisId).toBe(reanalysis?.analysisId);
    expect(body.data.aiFeedback?.analysisVersion).toBe(reanalysis?.analysisVersion);
    expect(body.data.aiFeedback?.issueUnderstanding).toBeUndefined();
    expect(body.data.aiFeedback?.issueUnderstandingReason).toBeUndefined();
    expect((await store.getCaseDetail(supportCase.id))?.analyses.find((analysis) => analysis.analysisId === initialAnalysis.analysisId)?.confidence).toBe(75);
  });

  test("re-analysis keeps the latest conflicting clarification in the AI context", async () => {
    const supportCase = await createCase(75);
    const initialCreatedAt = new Date(Date.now() + 1_000).toISOString();
    const latestCreatedAt = new Date(Date.now() + 2_000).toISOString();
    const initialInboxMessageId = `inbox-size-old-${sequence}`;
    const initialMessage = await store.createMessage({
      caseId: supportCase.id,
      direction: "INBOUND",
      channel: "line",
      originalText: "The upload fails for a file around 50 MB.",
      senderType: "CUSTOMER",
      messageType: "CUSTOMER_MESSAGE",
      deliveryStatus: "RECEIVED",
      receivedAt: initialCreatedAt,
      metadata: { sourceInboxMessageId: initialInboxMessageId },
    });
    await store.createAnalysis({
      caseId: supportCase.id,
      messageId: initialMessage.id,
      analysisType: "customer_message",
      summary: "Upload size issue",
      category: "SOFTWARE_APPLICATION",
      confidence: 75,
      rawJson: { sourceMessageIds: [initialInboxMessageId] },
    });
    const latestInboxMessageId = `inbox-size-latest-${sequence}`;
    const latestMessage = await store.createMessage({
      caseId: supportCase.id,
      direction: "INBOUND",
      channel: "line",
      originalText: "Latest clarification: the issue occurs with a 100 MB file.",
      senderType: "CUSTOMER",
      messageType: "CUSTOMER_MESSAGE",
      deliveryStatus: "RECEIVED",
      receivedAt: latestCreatedAt,
      metadata: { sourceInboxMessageId: latestInboxMessageId },
    });

    lastCustomerAnalysisInput = undefined;
    const response = await postRefreshSolution(supportCase.id);
    const capturedInput = lastCustomerAnalysisInput as CapturedCustomerAnalysisInput | undefined;
    const body = await response.json() as {
      data: { analyses: Array<{ analysisType: string; analysisVersion: number; rawJson: unknown }> };
    };
    const reanalysis = body.data.analyses
      .filter((analysis) => analysis.analysisType === "customer_message")
      .sort((left, right) => right.analysisVersion - left.analysisVersion)[0];
    const rawJson = reanalysis?.rawJson as {
      caseAnalysisContext?: { referenceMessages?: Array<{ messageId: string; content: string }> };
      sourceMessageIds?: string[];
    } | undefined;
    const contextMessages = rawJson?.caseAnalysisContext?.referenceMessages ?? [];

    expect(response.status).toBe(200);
    expect(contextMessages.map((message) => message.messageId)).toContain(initialMessage.id);
    expect(contextMessages.map((message) => message.messageId)).toContain(latestMessage.id);
    expect(rawJson?.sourceMessageIds).toContain(initialInboxMessageId);
    expect(rawJson?.sourceMessageIds).toContain(latestInboxMessageId);
    expect(contextMessages.some((message) => message.content.includes("50 MB"))).toBe(true);
    expect(contextMessages.some((message) => message.content.includes("100 MB"))).toBe(true);
    expect(contextMessages.find((message) => message.messageId === latestMessage.id)?.content).toContain("100 MB");
    expect(contextMessages.find((message) => message.messageId === latestMessage.id)?.messageId).toBe(latestMessage.id);
    expect(capturedInput?.caseAnalysisContext).toBeUndefined();
    expect(capturedInput?.text).not.toContain("Upload size issue");
    expect(capturedInput?.conversationContext?.join("\n")).toContain("50 MB");
    expect(capturedInput?.conversationContext?.join("\n")).toContain("100 MB");
    expect(capturedInput?.latestUserClarification?.content).toContain("100 MB");
  });

  test("re-analysis uses the latest browser clarification without the initial case snapshot", async () => {
    const supportCase = await createCase(75);
    const initialCreatedAt = new Date(Date.now() + 1_000).toISOString();
    const latestCreatedAt = new Date(Date.now() + 2_000).toISOString();
    const initialMessage = await store.createMessage({
      caseId: supportCase.id,
      direction: "INBOUND",
      channel: "line",
      originalText: "Chrome ใช้งานไม่ได้",
      senderType: "CUSTOMER",
      messageType: "CUSTOMER_MESSAGE",
      deliveryStatus: "RECEIVED",
      receivedAt: initialCreatedAt,
      metadata: { sourceInboxMessageId: `inbox-chrome-${sequence}` },
    });
    await store.createAnalysis({
      caseId: supportCase.id,
      messageId: initialMessage.id,
      analysisType: "customer_message",
      summary: "ปัญหา Chrome",
      category: "SOFTWARE_APPLICATION",
      confidence: 75,
      rawJson: { sourceMessageIds: [initialMessage.id] },
    });
    const latestMessage = await store.createMessage({
      caseId: supportCase.id,
      direction: "INBOUND",
      channel: "line",
      originalText: "แก้ไขข้อมูลล่าสุดค่ะ Chrome ใช้งานได้ปกติ ปัญหาเกิดเฉพาะ Safari",
      senderType: "CUSTOMER",
      messageType: "CUSTOMER_MESSAGE",
      deliveryStatus: "RECEIVED",
      receivedAt: latestCreatedAt,
      metadata: { sourceInboxMessageId: `inbox-safari-${sequence}` },
    });

    lastCustomerAnalysisInput = undefined;
    const response = await postRefreshSolution(supportCase.id);
    const capturedInput = lastCustomerAnalysisInput as CapturedCustomerAnalysisInput | undefined;

    expect(response.status).toBe(200);
    expect(capturedInput?.caseAnalysisContext).toBeUndefined();
    expect(capturedInput?.conversationContext?.join("\n")).toContain("Chrome");
    expect(capturedInput?.conversationContext?.join("\n")).toContain("Safari");
    expect(capturedInput?.latestUserClarification?.content).toContain("Safari");
    expect(capturedInput?.latestUserClarification?.content).toContain("Chrome ใช้งานได้ปกติ");
  });

  test("normalizes legacy analysis message ids to the canonical Inbox identity", async () => {
    const supportCase = await createCase(85);
    const inboxMessage = await store.createInboxMessage({
      customerId: supportCase.customerId,
      caseId: supportCase.id,
      assignedCaseId: supportCase.id,
      direction: "INBOUND",
      senderType: "CUSTOMER",
      text: "ข้อความอ้างอิงเดียวกัน",
      deliveryStatus: "DELIVERED",
    });
    const caseMessage = await store.createMessage({
      caseId: supportCase.id,
      direction: "INBOUND",
      channel: "line",
      originalText: inboxMessage.text,
      senderType: "CUSTOMER",
      messageType: "CUSTOMER_MESSAGE",
      deliveryStatus: "RECEIVED",
      metadata: { sourceInboxMessageId: inboxMessage.id },
    });
    await store.createAnalysis({
      caseId: supportCase.id,
      messageId: caseMessage.id,
      analysisType: "customer_message",
      summary: "สรุปจากข้อความอ้างอิง",
      category: "category",
      confidence: 85,
      rawJson: { sourceMessageIds: [caseMessage.id] },
    });

    const response = await getCase(supportCase.id);
    const body = await response.json() as { data: { currentAnalysis?: { sourceMessageIds?: string[] } } };

    expect(response.status).toBe(200);
    expect(body.data.currentAnalysis?.sourceMessageIds).toEqual([inboxMessage.id]);
  });

  test("reopen keeps the existing analysis in the API response", async () => {
    const supportCase = await createCase(85);
    const sourceInboxMessageId = `inbox-reopen-analysis-${sequence}`;
    const message = await store.createMessage({
      caseId: supportCase.id,
      direction: "INBOUND",
      channel: "line",
      originalText: "ข้อความอ้างอิงก่อนปิดเคส",
      senderType: "CUSTOMER",
      messageType: "CUSTOMER_MESSAGE",
      deliveryStatus: "RECEIVED",
      metadata: { sourceInboxMessageId },
    });
    const analysis = await store.createAnalysis({
      caseId: supportCase.id,
      messageId: message.id,
      analysisType: "customer_message",
      summary: "สรุปเดิม",
      category: "category",
      confidence: 85,
      rawJson: { sourceMessageIds: [sourceInboxMessageId] },
    });
    const endedAt = new Date(Date.now() - 60_000).toISOString();
    await store.updateCase(supportCase.id, {
      status: "closed",
      closedAt: endedAt,
      conversationEndedAt: endedAt,
    });

    const response = await app.fetch(new Request(`http://localhost/cases/${supportCase.id}/reopen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }));
    const body = await response.json() as {
      data: {
        status: string;
        conversationEndedAt?: string;
        confidenceScore?: number;
        currentAnalysis?: { id: string; analysisVersion: number; createdAt: string; summary?: string; sourceMessageIds?: string[] };
      };
    };

    expect(response.status).toBe(200);
    expect(body.data.status).toBe("reopened");
    expect(body.data.conversationEndedAt).toBeUndefined();
    expect(body.data.confidenceScore).toBe(85);
    expect(body.data.currentAnalysis).toEqual({
      id: analysis.analysisId,
      analysisVersion: analysis.analysisVersion,
      createdAt: analysis.createdAt,
      summary: analysis.summary,
      sourceMessageIds: [sourceInboxMessageId],
    });
  });

  test("case detail keeps customer-message analysis separate from solution analysis", async () => {
    const supportCase = await createCase(75);
    const message = await store.createMessage({
      caseId: supportCase.id,
      direction: "INBOUND",
      channel: "line",
      originalText: "ปัญหาการอัปโหลดไฟล์",
      senderType: "CUSTOMER",
      messageType: "CUSTOMER_MESSAGE",
      deliveryStatus: "RECEIVED",
    });
    const customerAnalysis = await store.createAnalysis({
      caseId: supportCase.id,
      messageId: message.id,
      analysisType: "customer_message",
      summary: "สรุปปัญหาเดิม",
      category: "SOFTWARE_APPLICATION",
      confidence: 75,
      rawJson: { sourceMessageIds: [message.id] },
    });
    const solutionAnalysis = await store.createAnalysis({
      caseId: supportCase.id,
      messageId: message.id,
      analysisType: "tech_solution",
      summary: "วิธีแก้จากทีม Tech",
      category: "SOFTWARE_APPLICATION",
      confidence: 90,
      rawJson: {},
    });

    const response = await getCase(supportCase.id);
    const body = await response.json() as {
      data: { currentAnalysis?: { id: string; analysisVersion: number; createdAt: string; summary?: string; sourceMessageIds?: string[] } };
    };

    expect(response.status).toBe(200);
    expect(solutionAnalysis.analysisVersion).toBeGreaterThan(customerAnalysis.analysisVersion);
    expect(body.data.currentAnalysis).toEqual({
      id: customerAnalysis.analysisId,
      analysisVersion: customerAnalysis.analysisVersion,
      createdAt: customerAnalysis.createdAt,
      summary: customerAnalysis.summary,
      sourceMessageIds: [message.id],
    });
  });

  test("re-analysis includes messages after reopening a previously closed case", async () => {
    const supportCase = await createCase(85);
    const beforeCloseInboxMessageId = `inbox-before-close-${sequence}`;
    await store.createMessage({
      caseId: supportCase.id,
      direction: "INBOUND",
      channel: "line",
      originalText: "ข้อความก่อนปิดเคส",
      senderType: "CUSTOMER",
      messageType: "CUSTOMER_MESSAGE",
      deliveryStatus: "RECEIVED",
      metadata: { sourceInboxMessageId: beforeCloseInboxMessageId },
    });
    const endedAt = new Date(Date.now() - 60_000).toISOString();
    await store.updateCase(supportCase.id, {
      status: "closed",
      closedAt: endedAt,
      conversationEndedAt: endedAt,
    });

    const reopenResponse = await app.fetch(new Request(`http://localhost/cases/${supportCase.id}/reopen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }));
    expect(reopenResponse.status).toBe(200);
    const reopenedDetail = await store.getCaseDetail(supportCase.id);
    expect(reopenedDetail?.status).toBe("reopened");
    expect(reopenedDetail?.conversationEndedAt).toBeUndefined();

    const afterReopenInboxMessageId = `inbox-after-reopen-${sequence}`;
    await store.createMessage({
      caseId: supportCase.id,
      direction: "OUTBOUND",
      channel: "line",
      originalText: "ทีม Tech ตรวจสอบและเริ่มประมวลผลใหม่แล้ว",
      senderType: "TECH",
      messageType: "TECH_REPLY",
      deliveryStatus: "SENT",
      metadata: { sourceInboxMessageId: afterReopenInboxMessageId },
    });

    const response = await postRefreshSolution(supportCase.id);
    const body = await response.json() as {
      data: {
        currentAnalysis?: { sourceMessageIds?: string[] };
        analyses: Array<{ analysisType: string; analysisVersion: number; rawJson: unknown }>;
      };
    };
    const reanalysis = body.data.analyses.find((analysis) => analysis.analysisType === "customer_message");
    const rawJson = reanalysis?.rawJson as { sourceMessageIds?: string[] } | undefined;

    expect(response.status).toBe(200);
    expect(rawJson?.sourceMessageIds).toContain(beforeCloseInboxMessageId);
    expect(rawJson?.sourceMessageIds).toContain(afterReopenInboxMessageId);
    expect(body.data.currentAnalysis?.sourceMessageIds).toContain(afterReopenInboxMessageId);
  });

  test("AI failure does not create a partial re-analysis record", async () => {
    const supportCase = await createCase(75);
    const message = await store.createMessage({
      caseId: supportCase.id,
      direction: "INBOUND",
      channel: "line",
      originalText: "ยังพบปัญหาเดิม",
      senderType: "CUSTOMER",
      messageType: "CUSTOMER_MESSAGE",
      deliveryStatus: "RECEIVED",
    });
    const initialAnalysis = await store.createAnalysis({
      caseId: supportCase.id,
      messageId: message.id,
      analysisType: "customer_message",
      summary: "เดิม",
      category: "category",
      confidence: 75,
      rawJson: {},
    });
    const beforeCount = (await store.getCaseDetail(supportCase.id))?.analyses.length;
    aiAnalysisShouldFail = true;
    try {
      const response = await postRefreshSolution(supportCase.id);
      expect(response.status).toBe(500);
    } finally {
      aiAnalysisShouldFail = false;
    }
    const after = await store.getCaseDetail(supportCase.id);
    expect(after?.analyses).toHaveLength(beforeCount ?? 0);
    expect(after?.analyses.find((analysis) => analysis.analysisId === initialAnalysis.analysisId)?.confidence).toBe(75);
  });

  test("sends a reply to LINE once and records the outbound case message", async () => {
    const supportCase = await createCase();
    const request = {
      action: "REPLY_CUSTOMER",
      caseId: supportCase.id,
      caseNumber: supportCase.caseNumber,
      replyText: "ลองออกจากระบบแล้วเข้าใหม่อีกครั้งค่ะ",
      requestId: `reply-${sequence}`,
    };

    const first = await postAction(request);
    const second = await postAction(request);
    const detail = await store.getCaseDetail(supportCase.id);
    const sentMessages = detail?.messages.filter((message) => message.direction === "OUTBOUND" && message.deliveryStatus === "SENT");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(lineSendCount).toBe(1);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages?.[0]?.senderType).toBe("TECH");
    // A concrete action reported by Teams is now stored as the extracted
    // solution, even when there is no end-user troubleshooting step.
    expect(detail?.solutions).toHaveLength(1);
    expect(detail?.solutions[0]?.solutionSteps).toEqual(["รีเซ็ตข้อมูลในระบบแล้ว"]);
    expect(detail?.analyses.some((analysis) => analysis.analysisType === "tech_solution")).toBe(true);
    const techSolutionAnalysis = detail?.analyses.find((analysis) => analysis.analysisType === "tech_solution");
    expect((techSolutionAnalysis?.rawJson as { teamActions?: string[] }).teamActions).toEqual(["รีเซ็ตข้อมูลในระบบแล้ว"]);
  });

  test("excludes unselected Inbox history from Tech Solution analysis context", async () => {
    const supportCase = await createCase();
    await store.createMessage({
      caseId: supportCase.id,
      direction: "INBOUND",
      channel: "line",
      originalText: "เคสเก่าอัปโหลดไฟล์ไม่ได้",
      senderType: "CUSTOMER",
      messageType: "CUSTOMER_MESSAGE",
      deliveryStatus: "RECEIVED",
      metadata: { isCaseReference: false, sourceInboxMessageId: "inbox-history-upload" },
    });
    await store.createMessage({
      caseId: supportCase.id,
      direction: "INBOUND",
      channel: "line",
      originalText: "เข้าสู่ระบบไม่ได้เพราะรหัสผ่านหมดอายุ",
      senderType: "CUSTOMER",
      messageType: "CUSTOMER_MESSAGE",
      deliveryStatus: "RECEIVED",
      metadata: { isCaseReference: true, sourceInboxMessageId: "inbox-current-password" },
    });
    lastTechSolutionInput = undefined;

    const response = await postAction({
      action: "REPLY_CUSTOMER",
      caseId: supportCase.id,
      caseNumber: supportCase.caseNumber,
      replyText: "เปลี่ยนรหัสผ่านแล้วเข้าสู่ระบบใหม่ครับ",
      requestId: `scoped-solution-${sequence}`,
    });
    const capturedTechSolutionInput = lastTechSolutionInput as CapturedTechSolutionInput | undefined;

    expect(response.status).toBe(200);
    expect(capturedTechSolutionInput?.originalCustomerText).toBe("เข้าสู่ระบบไม่ได้เพราะรหัสผ่านหมดอายุ");
    expect(capturedTechSolutionInput?.techReplyText).toContain("เข้าสู่ระบบไม่ได้เพราะรหัสผ่านหมดอายุ");
    expect(capturedTechSolutionInput?.techReplyText).toContain("เปลี่ยนรหัสผ่านแล้วเข้าสู่ระบบใหม่ครับ");
    expect(capturedTechSolutionInput?.techReplyText).not.toContain("เคสเก่าอัปโหลดไฟล์ไม่ได้");
  });

  test("rejects a missing reply and a mismatched case number", async () => {
    const supportCase = await createCase();
    const missingReply = await postAction({ action: "REPLY_CUSTOMER", caseId: supportCase.id, requestId: `empty-${sequence}` });
    const mismatch = await postAction({
      action: "REPLY_CUSTOMER",
      caseId: supportCase.id,
      caseNumber: "OFF-2099-99999",
      replyText: "test",
      requestId: `mismatch-${sequence}`,
    });

    expect(missingReply.status).toBe(400);
    expect(mismatch.status).toBe(400);
  });

  test("formats a close message, records SENT, and closes after LINE accepts it", async () => {
    const supportCase = await createCase();
    const response = await postAction({
      action: "CLOSE_CASE",
      caseId: supportCase.id,
      caseNumber: supportCase.caseNumber,
      replyText: "ทีมงานตรวจสอบและแนะนำวิธีแก้ไขเรียบร้อยแล้วค่ะ",
      responderName: "เจ้าหน้าที่ทดสอบ",
      requestId: `close-${sequence}`,
    });

    const detail = await store.getCaseDetail(supportCase.id);
    const closedMessage = detail?.messages.find((message) => message.messageType === "CASE_CLOSED" && message.direction === "OUTBOUND" && message.channel === "line");
    const systemEvent = detail?.messages.find((message) => message.messageType === "CASE_CLOSED" && message.senderType === "SYSTEM" && message.direction === "INTERNAL");

    expect(response.status).toBe(200);
    expect(detail?.status).toBe("closed");
    expect(detail?.closedBy).toBe("เจ้าหน้าที่ทดสอบ");
    expect(closedMessage?.deliveryStatus).toBe("SENT");
    expect(closedMessage?.isVisibleToCustomer).toBe(true);
    expect(closedMessage?.originalText).toContain(`ปิดเคส ${supportCase.caseNumber}`);
    expect(closedMessage?.sentAt).toBeDefined();
    expect(systemEvent?.isVisibleToCustomer).toBe(false);
    expect(systemEvent?.metadata?.eventType).toBe("CASE_CLOSED");
    // Closing with a concrete resolution also refreshes the extracted solution.
    expect(detail?.solutions).toHaveLength(1);
    expect(detail?.analyses.some((analysis) => analysis.analysisType === "tech_solution")).toBe(true);
  });

  test("composes customer reply and more-info drafts without sending LINE", async () => {
    const supportCase = await createCase();
    await store.createMessage({
      caseId: supportCase.id,
      direction: "INBOUND",
      channel: "line",
      originalText: "ส่งงานใน Teams แล้วแต่ยังไม่เห็นงานค่ะ",
      senderType: "CUSTOMER",
      messageType: "CUSTOMER_MESSAGE",
      isVisibleToCustomer: true,
      deliveryStatus: "RECEIVED",
    });
    await store.createMessage({
      caseId: supportCase.id,
      direction: "INBOUND",
      channel: "line",
      originalText: "ส่งช่วงสองโมงค่ะ",
      senderType: "CUSTOMER",
      messageType: "CUSTOMER_ADDITIONAL_INFO",
      isVisibleToCustomer: true,
      deliveryStatus: "RECEIVED",
    });
    await store.createSolution({
      caseId: supportCase.id,
      rawReplyText: "ให้ตรวจสอบสถานะการส่งงานอีกครั้ง",
      rootCause: "สถานะการส่งงานยังไม่อัปเดต",
      solutionSteps: ["ตรวจสอบสถานะการส่งงานอีกครั้ง"],
      rewrittenCustomerText: "รบกวนตรวจสอบสถานะการส่งงานอีกครั้งนะคะ",
      confidence: 85,
      validatedByTeam: true,
    });

    const replyResponse = await postCompose(supportCase.id, { mode: "CUSTOMER_REPLY", supportInstruction: "ให้ตอบสั้นและสุภาพ" });
    const infoResponse = await postCompose(supportCase.id, { mode: "REQUEST_MORE_INFO", requestedInformation: "ขอภาพหน้าจอ" });
    const detail = await store.getCaseDetail(supportCase.id);
    const aiDrafts = detail?.messages.filter((message) => message.senderType === "AI");

    expect(replyResponse.status).toBe(200);
    expect(infoResponse.status).toBe(200);
    expect(aiDrafts?.some((message) => message.metadata?.aiPurpose === "GENERATE_CUSTOMER_REPLY")).toBe(true);
    expect(aiDrafts?.some((message) => message.metadata?.aiPurpose === "GENERATE_MORE_INFO_REQUEST")).toBe(true);
    expect(detail?.status).toBe("assigned");
  });

  test("stores Case Detail feedback against the selected AI analysis version", async () => {
    const supportCase = await createCase(73);
    const analysis = await store.createAnalysis({
      caseId: supportCase.id,
      analysisType: "customer_message",
      confidence: 85,
      rawJson: {},
    });
    const understandingResponse = await patchAiFeedback(supportCase.id, {
      caseId: supportCase.id,
      analysisId: analysis.analysisId,
      analysisVersion: analysis.analysisVersion,
      feedbackType: "ISSUE_UNDERSTANDING",
      value: "CORRECT",
    });
    const solutionResponse = await patchAiFeedback(supportCase.id, {
      caseId: supportCase.id,
      analysisId: analysis.analysisId,
      analysisVersion: analysis.analysisVersion,
      feedbackType: "SOLUTION_SELECTION",
      value: "INCORRECT",
      reason: "ขั้นตอนแก้ไขยังไม่ตรงกับอาการ",
    });
    const detail = await store.getCaseDetail(supportCase.id);

    expect(understandingResponse.status).toBe(200);
    expect(solutionResponse.status).toBe(200);
    const understanding = await understandingResponse.json() as { data?: { feedback?: { id?: string; analysisId?: string; analysisVersion?: number; result?: string } } };
    const solution = await solutionResponse.json() as { data?: { feedback?: { analysisVersion?: number; result?: string; reason?: string }; aiFeedback?: { analysisId?: string; analysisVersion?: number; solutionSelection?: string; solutionSelectionReason?: string } } };
    expect(understanding.data?.feedback?.analysisId).toBe(analysis.analysisId);
    expect(understanding.data?.feedback?.analysisVersion).toBe(analysis.analysisVersion);
    expect(understanding.data?.feedback?.result).toBe("CORRECT");
    expect(solution.data?.feedback?.result).toBe("INCORRECT");
    expect(solution.data?.feedback?.reason).toBe("ขั้นตอนแก้ไขยังไม่ตรงกับอาการ");
    expect(solution.data?.feedback?.analysisVersion).toBe(analysis.analysisVersion);
    expect(solution.data?.aiFeedback).toEqual(expect.objectContaining({
      analysisId: analysis.analysisId,
      analysisVersion: analysis.analysisVersion,
      solutionSelection: "INCORRECT",
      solutionSelectionReason: "ขั้นตอนแก้ไขยังไม่ตรงกับอาการ",
    }));
    expect(detail?.caseUnderstandingFeedback).toBeUndefined();
    expect(detail?.solutionSelectionFeedback).toBeUndefined();
    expect(detail?.confidenceScore).toBe(73);
    expect(detail?.analyses.find((item) => item.analysisId === analysis.analysisId)?.confidence).toBe(85);

    const updatedResponse = await patchAiFeedback(supportCase.id, {
      caseId: supportCase.id,
      analysisId: analysis.analysisId,
      analysisVersion: analysis.analysisVersion,
      feedbackType: "ISSUE_UNDERSTANDING",
      value: "INCORRECT",
      reason: "สรุปอาการไม่ตรงกับข้อมูลล่าสุด",
    });
    const updated = await updatedResponse.json() as { data?: { feedback?: { id?: string; result?: string; reason?: string } } };
    expect(updatedResponse.status).toBe(200);
    expect(updated.data?.feedback?.id).toBe(understanding.data?.feedback?.id);
    expect(updated.data?.feedback?.result).toBe("INCORRECT");
    expect(updated.data?.feedback?.reason).toBe("สรุปอาการไม่ตรงกับข้อมูลล่าสุด");
    const correctedResponse = await patchAiFeedback(supportCase.id, {
      caseId: supportCase.id,
      analysisId: analysis.analysisId,
      analysisVersion: analysis.analysisVersion,
      feedbackType: "ISSUE_UNDERSTANDING",
      value: "CORRECT",
    });
    const corrected = await correctedResponse.json() as { data?: { feedback?: { id?: string; result?: string; reason?: string } } };
    expect(corrected.data?.feedback?.id).toBe(understanding.data?.feedback?.id);
    expect(corrected.data?.feedback?.result).toBe("CORRECT");
    expect(corrected.data?.feedback?.reason).toBeUndefined();
    expect((await store.listAiReviewFeedback()).filter((item) => (
      item.caseId === supportCase.id
      && item.analysisVersion === analysis.analysisVersion
      && item.feedbackType === "ISSUE_UNDERSTANDING"
    ))).toHaveLength(1);
    const afterFeedback = await store.getCaseDetail(supportCase.id);
    expect(afterFeedback?.confidenceScore).toBe(73);
    expect(afterFeedback?.analyses.find((item) => item.analysisId === analysis.analysisId)?.confidence).toBe(85);
  });

  test("stores Confidence Review feedback by type without changing model confidence", async () => {
    const supportCase = await createCase(94);
    const analysis = await store.createAnalysis({
      caseId: supportCase.id,
      analysisType: "customer_message",
      confidence: 91,
      rawJson: {},
    });
    const solution = await store.createSolution({
      caseId: supportCase.id,
      rawReplyText: "restart service",
      solutionSteps: ["restart service"],
      rewrittenCustomerText: "restart service",
      confidence: 91,
      validatedByTeam: false,
    });
    const confirmed = await postConfidenceReview({
      caseId: supportCase.id,
      analysisId: analysis.analysisId,
      analysisVersion: analysis.analysisVersion,
      reviewStage: "QUALITY",
      solutionId: solution.id,
      understandingResult: "CORRECT",
      solutionResult: "CORRECT",
    }, `match_${supportCase.id}`);
    const confirmationBody = await confirmed.json() as {
      data?: { feedback?: Array<{ feedbackType: string; result: string; reviewSource: string }>; case?: { confidenceReviewStatus?: string } };
    };
    const afterConfirmation = await store.getCaseDetail(supportCase.id);

    expect(confirmed.status).toBe(200);
    expect(confirmationBody.data?.feedback).toEqual(expect.arrayContaining([
      expect.objectContaining({ feedbackType: "ISSUE_UNDERSTANDING", result: "CORRECT", reviewSource: "CONFIDENCE_REVIEW" }),
      expect.objectContaining({ feedbackType: "SOLUTION_SELECTION", result: "CORRECT", reviewSource: "CONFIDENCE_REVIEW" }),
    ]));
    expect(confirmationBody.data?.case?.confidenceReviewStatus).toBe("QUALITY_APPROVED");
    expect(afterConfirmation?.confidenceScore).toBe(94);
    expect(afterConfirmation?.analyses.find((item) => item.analysisId === analysis.analysisId)?.confidence).toBe(91);

    const rejected = await postConfidenceReview({
      caseId: supportCase.id,
      analysisId: analysis.analysisId,
      analysisVersion: analysis.analysisVersion,
      reviewStage: "QUALITY",
      solutionId: solution.id,
      understandingResult: "CORRECT",
      solutionResult: "INCORRECT",
      reason: "วิธีแก้ยังไม่ตรงกับข้อมูลที่ทีมตรวจสอบ",
    }, `match_${supportCase.id}`);
    const rejectionBody = await rejected.json() as {
      data?: { feedback?: Array<{ feedbackType: string; result: string }>; case?: { confidenceReviewStatus?: string } };
    };

    expect(rejected.status).toBe(200);
    expect(rejectionBody.data?.feedback).toEqual(expect.arrayContaining([
      expect.objectContaining({ feedbackType: "ISSUE_UNDERSTANDING", result: "CORRECT" }),
      expect.objectContaining({ feedbackType: "SOLUTION_SELECTION", result: "INCORRECT" }),
    ]));
    expect(rejectionBody.data?.case?.confidenceReviewStatus).toBe("QUALITY_REJECTED");
    const afterRejection = await store.getCaseDetail(supportCase.id);
    const suggestionsAfterRejection = await app.fetch(new Request("http://localhost/confidence/suggestions"));
    const suggestionsBody = await suggestionsAfterRejection.json() as { data: Array<{ caseId: string }> };
    expect(afterRejection?.confidenceScore).toBe(94);
    expect(afterRejection?.analyses.find((item) => item.analysisId === analysis.analysisId)?.confidence).toBe(91);
    expect(suggestionsBody.data.some((item) => item.caseId === supportCase.id)).toBe(false);
  });

  test("keeps a partial formal review in QUALITY until every applicable dimension is reviewed", async () => {
    const supportCase = await createCase(85);
    const analysis = await store.createAnalysis({
      caseId: supportCase.id,
      analysisType: "customer_message",
      confidence: 85,
      rawJson: {},
    });
    const solution = await store.createSolution({
      caseId: supportCase.id,
      rawReplyText: "restart service",
      solutionSteps: ["restart service"],
      rewrittenCustomerText: "restart service",
      confidence: 85,
      validatedByTeam: false,
    });
    await store.upsertAiReviewFeedback({
      caseId: supportCase.id,
      analysisId: analysis.analysisId,
      analysisVersion: analysis.analysisVersion,
      feedbackType: "SOLUTION_SELECTION",
      result: "INCORRECT",
      reviewSource: "CONFIDENCE_REVIEW",
      reason: "wrong solution",
      reviewedBy: "Tech Support Console",
    });

    const beforeResponse = await app.fetch(new Request("http://localhost/confidence/suggestions"));
    const before = await beforeResponse.json() as { data: Array<{
      id: string;
      caseId: string;
      understandingResult?: string;
      solutionResult?: string;
      reviewReason?: string;
    }> };
    const suggestion = before.data.find((item) => item.caseId === supportCase.id);

    expect(suggestion).toEqual(expect.objectContaining({
      solutionResult: "INCORRECT",
      reviewReason: "wrong solution",
    }));
    expect(suggestion?.understandingResult).toBeUndefined();

    const incomplete = await postConfidenceReview({
      caseId: supportCase.id,
      analysisId: analysis.analysisId,
      analysisVersion: analysis.analysisVersion,
      reviewStage: "QUALITY",
      solutionId: solution.id,
      solutionResult: "INCORRECT",
    }, suggestion?.id ?? "missing");
    expect(incomplete.status).toBe(400);

    const completed = await postConfidenceReview({
      caseId: supportCase.id,
      analysisId: analysis.analysisId,
      analysisVersion: analysis.analysisVersion,
      reviewStage: "QUALITY",
      solutionId: solution.id,
      understandingResult: "CORRECT",
      solutionResult: "INCORRECT",
      reason: "wrong solution",
    }, suggestion?.id ?? "missing");
    expect(completed.status).toBe(200);

    const afterResponse = await app.fetch(new Request("http://localhost/confidence/suggestions"));
    const after = await afterResponse.json() as { data: Array<{ caseId: string }> };
    expect(after.data.some((item) => item.caseId === supportCase.id)).toBe(false);
  });

  test("keeps quality review pending when the latest solution is incomplete", async () => {
    const supportCase = await createCase(85);
    const analysis = await store.createAnalysis({
      caseId: supportCase.id,
      analysisType: "customer_message",
      category: "SOFTWARE_APPLICATION",
      confidence: 85,
      rawJson: {},
    });
    await store.createSolution({
      caseId: supportCase.id,
      rawReplyText: "restart service",
      solutionSteps: ["restart service"],
      rewrittenCustomerText: "restart service",
      confidence: 95,
      validatedByTeam: false,
    });
    await store.createSolution({
      caseId: supportCase.id,
      rawReplyText: "incomplete latest solution",
      solutionSteps: [],
      rewrittenCustomerText: "",
      confidence: 95,
      validatedByTeam: false,
    });
    const suggestionsResponse = await app.fetch(new Request("http://localhost/confidence/suggestions"));
    const suggestions = await suggestionsResponse.json() as { data: Array<{ id: string; caseId: string; category: string; hasSuggestedSolution: boolean }> };
    const suggestion = suggestions.data.find((item) => item.caseId === supportCase.id);
    expect(suggestion?.hasSuggestedSolution).toBe(false);
    expect(suggestion?.category).toBe("ปัญหาซอฟต์แวร์");

    const response = await postConfidenceReview({
      caseId: supportCase.id,
      analysisId: analysis.analysisId,
      analysisVersion: analysis.analysisVersion,
      reviewStage: "QUALITY",
      understandingResult: "INCORRECT",
      reason: "understanding is incomplete",
    }, suggestion?.id ?? "missing");
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("quality_solution_is_required");
    expect((await store.listAiReviewFeedback()).some((item) => item.caseId === supportCase.id)).toBe(false);
    const afterResponse = await app.fetch(new Request("http://localhost/confidence/suggestions"));
    const after = await afterResponse.json() as { data: Array<{ caseId: string }> };
    expect(after.data.some((item) => item.caseId === supportCase.id)).toBe(true);
  });

  test("calculates Analytics accuracy from current analysis-version feedback only", async () => {
    const supportCases = await Promise.all([createCase(90), createCase(90), createCase(90), createCase(90)]);
    const firstAnalysis = await store.createAnalysis({
      caseId: supportCases[0].id,
      analysisType: "customer_message",
      category: "NETWORK_CONNECTION",
      confidence: 90,
      rawJson: {},
    });
    await patchAiFeedback(supportCases[0].id, {
      analysisId: firstAnalysis.analysisId,
      analysisVersion: firstAnalysis.analysisVersion,
      feedbackType: "ISSUE_UNDERSTANDING",
      result: "CORRECT",
    });
    const reanalyzed = await store.createAnalysis({
      caseId: supportCases[0].id,
      analysisType: "customer_message",
      category: "NETWORK_CONNECTION",
      confidence: 90,
      rawJson: {},
    });
    await patchAiFeedback(supportCases[0].id, {
      analysisId: reanalyzed.analysisId,
      analysisVersion: reanalyzed.analysisVersion,
      feedbackType: "ISSUE_UNDERSTANDING",
      result: "INCORRECT",
    });
    await patchAiFeedback(supportCases[0].id, {
      analysisId: reanalyzed.analysisId,
      analysisVersion: reanalyzed.analysisVersion,
      feedbackType: "SOLUTION_SELECTION",
      result: "CORRECT",
    });
    const newerTechAnalysis = await store.createAnalysis({
      caseId: supportCases[0].id,
      analysisType: "tech_solution",
      category: "UNMAPPED_TECH_SOLUTION_CATEGORY",
      confidence: 99,
      rawJson: {},
    });
    await store.upsertAiReviewFeedback({
      caseId: supportCases[0].id,
      analysisId: newerTechAnalysis.analysisId,
      analysisVersion: newerTechAnalysis.analysisVersion,
      feedbackType: "ISSUE_UNDERSTANDING",
      result: "CORRECT",
      reviewSource: "CONFIDENCE_REVIEW",
    });

    for (const [index, supportCase] of supportCases.slice(1).entries()) {
      const analysis = await store.createAnalysis({
        caseId: supportCase.id,
        analysisType: "customer_message",
        category: "NETWORK_CONNECTION",
        confidence: 90,
        rawJson: {},
      });
      await patchAiFeedback(supportCase.id, {
        analysisId: analysis.analysisId,
        analysisVersion: analysis.analysisVersion,
        feedbackType: "ISSUE_UNDERSTANDING",
        result: "CORRECT",
      });
      if (index === 0) {
        await patchAiFeedback(supportCase.id, {
          analysisId: analysis.analysisId,
          analysisVersion: analysis.analysisVersion,
          feedbackType: "SOLUTION_SELECTION",
          result: "INCORRECT",
        });
      }
    }

    const loginCase = await createCase(90);
    await store.createAnalysis({
      caseId: loginCase.id,
      analysisType: "customer_message",
      category: "LOGIN_ISSUE",
      confidence: 90,
      rawJson: {},
    });
    const unknownCategoryCase = await createCase(90);
    const unknownAnalysis = await store.createAnalysis({
      caseId: unknownCategoryCase.id,
      analysisType: "customer_message",
      category: "UNMAPPED_FUTURE_CATEGORY",
      confidence: 90,
      rawJson: {},
    });
    await patchAiFeedback(unknownCategoryCase.id, {
      analysisId: unknownAnalysis.analysisId,
      analysisVersion: unknownAnalysis.analysisVersion,
      feedbackType: "ISSUE_UNDERSTANDING",
      result: "INCORRECT",
    });
    const zeroAccuracyCase = await createCase(90);
    const zeroAccuracyAnalysis = await store.createAnalysis({
      caseId: zeroAccuracyCase.id,
      analysisType: "customer_message",
      category: "DATA_DISPLAY",
      confidence: 90,
      rawJson: {},
    });
    await patchAiFeedback(zeroAccuracyCase.id, {
      analysisId: zeroAccuracyAnalysis.analysisId,
      analysisVersion: zeroAccuracyAnalysis.analysisVersion,
      feedbackType: "ISSUE_UNDERSTANDING",
      result: "INCORRECT",
    });
    const mismatchedAnalysisCase = await createCase(90);
    const mismatchedAnalysis = await store.createAnalysis({
      caseId: mismatchedAnalysisCase.id,
      analysisType: "customer_message",
      category: "NETWORK_CONNECTION",
      confidence: 90,
      rawJson: {},
    });
    await store.upsertAiReviewFeedback({
      caseId: mismatchedAnalysisCase.id,
      analysisId: "analysis-from-another-run",
      analysisVersion: mismatchedAnalysis.analysisVersion,
      feedbackType: "ISSUE_UNDERSTANDING",
      result: "INCORRECT",
      reviewSource: "CASE_DETAIL",
    });

    const response = await app.fetch(new Request("http://localhost/analytics/summary"));
    const body = await response.json() as { data: { categories: Array<{
      key: string;
      caseUnderstandingAccuracy: number;
      caseUnderstandingReviewedCount: number;
      solutionSelectionAccuracy: number;
      solutionSelectionReviewedCount: number;
    }> } };
    const network = body.data.categories.find((item) => item.key === "NETWORK_CONNECTION");
    const login = body.data.categories.find((item) => item.key === "LOGIN_ACCESS");
    const other = body.data.categories.find((item) => item.key === "OTHER");
    const dataDisplay = body.data.categories.find((item) => item.key === "DATA_DISPLAY");

    expect(response.status).toBe(200);
    expect(network?.caseUnderstandingReviewedCount).toBe(4);
    expect(network?.caseUnderstandingAccuracy).toBe(75);
    expect(network?.solutionSelectionReviewedCount).toBe(2);
    expect(network?.solutionSelectionAccuracy).toBe(50);
    expect(login?.caseUnderstandingReviewedCount).toBe(0);
    expect(login?.caseUnderstandingAccuracy).toBe(0);
    expect(other?.caseUnderstandingReviewedCount).toBeGreaterThanOrEqual(1);
    expect(dataDisplay?.caseUnderstandingReviewedCount).toBe(1);
    expect(dataDisplay?.caseUnderstandingAccuracy).toBe(0);
  });

  test("keeps only explicitly selected Inbox messages as case references", async () => {
    const customer = await store.upsertCustomer({ lineUserId: `U-inbox-context-${++sequence}`, displayName: "Inbox context" });
    const first = await store.createInboxMessage({ customerId: customer.id, direction: "INBOUND", senderType: "CUSTOMER", text: "ข้อความที่ไม่เลือก" });
    const second = await store.createInboxMessage({
      customerId: customer.id,
      direction: "OUTBOUND",
      senderType: "TECH",
      text: "ข้อความที่เลือก",
      externalMessageId: `line-reference-${sequence}`,
      webhookEventId: `webhook-reference-${sequence}`,
    });
    const response = await openInboxCase(customer.id, {
      title: "หัวข้อจากทีม Tech",
      description: "รายละเอียดจากทีม Tech",
      from: new Date(new Date(first.createdAt).getTime() - 60_000).toISOString(),
      to: new Date(new Date(second.createdAt).getTime() + 60_000).toISOString(),
      selectedMessageIds: [second.id],
    });
    const body = await response.json() as { data: { id: string; caseId?: string; activeCaseId?: string; messages: Array<{ originalText: string; sourceMessageId?: string; externalMessageId?: string; webhookEventId?: string; metadata?: Record<string, unknown> }> } };
    const referenceMessages = body.data.messages.filter((message) => message.metadata?.isCaseReference === true);
    const definition = body.data.messages.find((message) => message.metadata?.eventType === "CASE_CREATED_FROM_INBOX");
    const detail = await store.getCaseDetail(body.data.id);
    const analysisContext = detail?.analyses.find((analysis) => analysis.analysisType === "customer_message")?.rawJson as {
      caseAnalysisContext?: { subject?: string; detail?: string; referenceMessages?: Array<{ messageId?: string }> };
    } | undefined;

    expect(response.status).toBe(201);
    expect(referenceMessages).toHaveLength(1);
    expect(referenceMessages[0]?.originalText).toBe("ข้อความที่เลือก");
    expect(referenceMessages[0]?.sourceMessageId).toBeUndefined();
    expect(referenceMessages[0]?.metadata?.sourceInboxMessageId).toBe(second.id);
    expect(referenceMessages[0]?.externalMessageId).toBeUndefined();
    expect(referenceMessages[0]?.webhookEventId).toBeUndefined();
    expect(definition?.metadata?.caseSubject).toBe("หัวข้อจากทีม Tech");
    expect(definition?.metadata?.caseDetail).toBe("รายละเอียดจากทีม Tech");
    expect(lastCustomerAnalysisInput?.caseAnalysisContext).toMatchObject({
      subject: "หัวข้อจากทีม Tech",
      detail: "รายละเอียดจากทีม Tech",
    });
    expect(analysisContext?.caseAnalysisContext?.subject).toBe("หัวข้อจากทีม Tech");
    expect(analysisContext?.caseAnalysisContext?.detail).toBe("รายละเอียดจากทีม Tech");
    expect(analysisContext?.caseAnalysisContext?.referenceMessages?.map((message) => message.messageId)).toEqual([second.id]);
    const inboxUser = await store.getInboxUser(customer.id);
    const selectedInboxMessage = inboxUser?.messages.find((message) => message.id === second.id);
    expect(selectedInboxMessage?.caseId).toBe(body.data.id);
    expect(selectedInboxMessage?.assignedCaseId).toBe(body.data.id);
    expect(selectedInboxMessage?.assignedBy).toBe("SYSTEM_OPEN_CASE");
    expect(inboxUser?.customer.activeCaseId).toBe(body.data.id);
    expect(detail?.messages.filter((message) => message.metadata?.sourceInboxMessageId === second.id)).toHaveLength(1);
  });

  test("deduplicates case timeline rows by source identity without collapsing same-text messages", async () => {
    const customer = await store.upsertCustomer({ lineUserId: `U-case-dedupe-${++sequence}`, displayName: "Timeline dedupe" });
    const supportCase = await store.createCase({ customerId: customer.id, status: "assigned", title: "Timeline" });
    const sourceInboxMessageId = `inbox-source-${sequence}`;
    await store.createMessage({
      caseId: supportCase.id,
      direction: "INTERNAL",
      channel: "system",
      originalText: "ข้อมูลไม่อัปเดต",
      senderType: "SYSTEM",
      messageType: "SYSTEM_EVENT",
      deliveryStatus: "PROCESSED",
      metadata: { sourceInboxMessageId },
    });
    await store.createMessage({
      caseId: supportCase.id,
      direction: "INBOUND",
      channel: "line",
      originalText: "ข้อมูลไม่อัปเดต",
      senderType: "CUSTOMER",
      messageType: "CUSTOMER_MESSAGE",
      deliveryStatus: "RECEIVED",
      metadata: { sourceInboxMessageId },
    });
    await store.createMessage({
      caseId: supportCase.id,
      direction: "INBOUND",
      channel: "line",
      originalText: "ข้อมูลไม่อัปเดต",
      senderType: "CUSTOMER",
      messageType: "CUSTOMER_MESSAGE",
      deliveryStatus: "RECEIVED",
      metadata: { sourceInboxMessageId: `${sourceInboxMessageId}-second` },
    });
    const detail = await store.getCaseDetail(supportCase.id);

    expect(detail?.messages).toHaveLength(2);
    expect(detail?.messages.every((message) => message.senderType === "CUSTOMER" && message.direction === "INBOUND")).toBe(true);
  });

  test("links Case Detail outbound messages to the same case in Inbox", async () => {
    const customer = await store.upsertCustomer({ lineUserId: `U-case-message-${++sequence}`, displayName: "Case message" });
    const supportCase = await store.createCase({ customerId: customer.id, status: "assigned", title: "Case composer" });
    const response = await app.fetch(new Request(`http://localhost/cases/${supportCase.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "ทีม Tech ตรวจสอบให้แล้วค่ะ" }),
    }));
    const inboxUser = await store.getInboxUser(customer.id);
    const inboxMessage = inboxUser?.messages.find((message) => message.text === "ทีม Tech ตรวจสอบให้แล้วค่ะ");
    const detail = await store.getCaseDetail(supportCase.id);

    expect(response.status).toBe(200);
    expect(inboxMessage?.caseId).toBe(supportCase.id);
    expect(inboxMessage?.assignedCaseId).toBe(supportCase.id);
    expect(detail?.messages.some((message) => message.originalText === "ทีม Tech ตรวจสอบให้แล้วค่ะ" && message.channel === "line" && message.senderType === "TECH" && message.direction === "OUTBOUND")).toBe(true);
  });

  test("keeps Case Detail replies assigned to the current case even with multiple open cases", async () => {
    const customer = await store.upsertCustomer({ lineUserId: `U-case-message-multiple-${++sequence}`, displayName: "Multiple case composer" });
    await store.createCase({ customerId: customer.id, status: "assigned", title: "Older open case" });
    const currentCase = await store.createCase({ customerId: customer.id, status: "assigned", title: "Current open case" });

    const content = "ข้อความจากเคสปัจจุบัน";
    const response = await app.fetch(new Request(`http://localhost/cases/${currentCase.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, messageType: "CUSTOMER_REPLY" }),
    }));
    const body = await response.json() as { data: { id: string; caseId?: string } };
    const inboxUser = await store.getInboxUser(customer.id);
    const inboxMessage = inboxUser?.messages.find((message) => message.text === content);
    const detail = await store.getCaseDetail(currentCase.id);
    const timelineMessages = detail?.messages.filter((message) => message.originalText === content && message.channel === "line");

    expect(response.status).toBe(200);
    expect(body.data.caseId).toBe(currentCase.id);
    expect(inboxMessage?.caseId).toBe(currentCase.id);
    expect(inboxMessage?.senderType).toBe("TECH");
    expect(inboxMessage?.direction).toBe("OUTBOUND");
    expect(timelineMessages).toHaveLength(1);
    expect(timelineMessages?.[0]?.metadata?.inboxMessageId).toBe(inboxMessage?.id);
  });

  test("assigns all selected reference messages to the newly opened case", async () => {
    const customer = await store.upsertCustomer({ lineUserId: `U-selected-three-${++sequence}`, displayName: "Selected three" });
    const timestamps = ["2026-08-06T04:00:00.000Z", "2026-08-06T04:01:00.000Z", "2026-08-06T04:02:00.000Z"];
    const messages = await Promise.all(timestamps.map((createdAt, index) => store.createInboxMessage({
      customerId: customer.id,
      direction: index === 1 ? "OUTBOUND" : "INBOUND",
      senderType: index === 1 ? "TECH" : "CUSTOMER",
      text: `selected-${index + 1}`,
      createdAt,
    })));
    const response = await openInboxCase(customer.id, {
      title: "Selected messages",
      description: "Three selected messages",
      from: "2026-08-06T03:59:00.000Z",
      to: "2026-08-06T04:03:00.000Z",
      selectedMessageIds: messages.map((message) => message.id),
    });
    const body = await response.json() as { data: { id: string; caseId?: string; activeCaseId?: string; messages: Array<{ metadata?: Record<string, unknown> }> } };
    const inboxUser = await store.getInboxUser(customer.id);
    const selected = messages.map((message) => inboxUser?.messages.find((item) => item.id === message.id));

    expect(response.status).toBe(201);
    expect(body.data.caseId).toBe(body.data.id);
    expect(body.data.activeCaseId).toBe(body.data.id);
    expect(selected.every((message) => message?.caseId === body.data.id)).toBe(true);
    expect(selected.every((message) => message?.assignedCaseId === body.data.id)).toBe(true);
    expect(body.data.messages.filter((message) => message.metadata?.isCaseReference === true)).toHaveLength(3);
    expect(body.data.messages.filter((message) => message.metadata?.sourceInboxMessageId === messages[0]?.id)).toHaveLength(1);
  });

  test("allows an explicitly selected message to move from an older case to a newly opened case", async () => {
    const customer = await store.upsertCustomer({ lineUserId: `U-reassign-selected-${++sequence}`, displayName: "Reassign selected" });
    const oldCase = await store.createCase({ customerId: customer.id, status: "awaiting_tech", title: "Older case" });
    const message = await store.createInboxMessage({
      customerId: customer.id,
      direction: "INBOUND",
      senderType: "CUSTOMER",
      text: "A new issue selected for a new case",
      caseId: oldCase.id,
      assignedCaseId: oldCase.id,
      assignedBy: "SYSTEM",
      createdAt: "2026-08-06T04:00:00.000Z",
    });

    const response = await openInboxCase(customer.id, {
      title: "New case from selected message",
      description: "The selected message belongs to the new issue",
      from: "2026-08-06T03:59:00.000Z",
      to: "2026-08-06T04:03:00.000Z",
      selectedMessageIds: [message.id],
    });
    const body = await response.json() as { data: { id: string } };
    const inboxUser = await store.getInboxUser(customer.id);

    expect(response.status).toBe(201);
    expect(inboxUser?.messages.find((item) => item.id === message.id)?.caseId).toBe(body.data.id);
    expect(inboxUser?.messages.find((item) => item.id === message.id)?.assignedCaseId).toBe(body.data.id);
  });

  test("links an incoming message only when the active case is the sole open case", async () => {
    const { caseService } = await import("../services/case-service");
    const customer = await store.upsertCustomer({ lineUserId: `U-active-link-${++sequence}`, displayName: "Active link" });
    const supportCase = await store.createCase({ customerId: customer.id, status: "assigned", title: "Active" });
    await store.setActiveCase(customer.id, supportCase.id);
    const incoming = await store.createInboxMessage({ customerId: customer.id, direction: "INBOUND", senderType: "CUSTOMER", text: "new incoming" });
    await caseService.linkInboxMessageToActiveCase(customer.id, incoming);
    const linked = await store.getInboxUser(customer.id);
    const detail = await store.getCaseDetail(supportCase.id);

    expect(linked?.messages.find((message) => message.id === incoming.id)?.caseId).toBe(supportCase.id);
    expect(detail?.messages.some((message) => message.metadata?.sourceInboxMessageId === incoming.id && message.senderType === "CUSTOMER" && message.direction === "INBOUND")).toBe(true);
  });

  test("clears a closed active case and assigns the incoming message to the only open case", async () => {
    const { caseService } = await import("../services/case-service");
    const customer = await store.upsertCustomer({ lineUserId: `U-stale-active-${++sequence}`, displayName: "Stale active" });
    const closedCase = await store.createCase({ customerId: customer.id, status: "closed", title: "Closed case" });
    const openCase = await store.createCase({ customerId: customer.id, status: "awaiting_tech", title: "Open case" });
    await store.setActiveCase(customer.id, closedCase.id);

    const incoming = await store.createInboxMessage({ customerId: customer.id, direction: "INBOUND", senderType: "CUSTOMER", text: "new message after closed case" });
    await caseService.linkInboxMessageToActiveCase(customer.id, incoming);
    const inboxUser = await store.getInboxUser(customer.id);
    const refreshedCustomer = inboxUser?.customer;

    expect(refreshedCustomer?.activeCaseId).toBe(openCase.id);
    expect(inboxUser?.messages.find((message) => message.id === incoming.id)?.caseId).toBe(openCase.id);
  });

  test("leaves incoming messages unassigned when multiple cases are open", async () => {
    const { caseService } = await import("../services/case-service");
    const customer = await store.upsertCustomer({ lineUserId: `U-multiple-open-${++sequence}`, displayName: "Multiple open" });
    const first = await store.createCase({ customerId: customer.id, status: "assigned", title: "First" });
    await store.createCase({ customerId: customer.id, status: "assigned", title: "Second" });
    await store.setActiveCase(customer.id, first.id);
    const incoming = await store.createInboxMessage({ customerId: customer.id, direction: "INBOUND", senderType: "CUSTOMER", text: "ambiguous incoming" });
    const linked = await caseService.linkInboxMessageToActiveCase(customer.id, incoming);
    const inboxUser = await store.getInboxUser(customer.id);

    expect(linked).toBeUndefined();
    expect(inboxUser?.messages.find((message) => message.id === incoming.id)?.caseId).toBeUndefined();
  });

  test("backfills only unassigned reference Inbox messages", async () => {
    const customer = await store.upsertCustomer({ lineUserId: `U-backfill-${++sequence}`, displayName: "Backfill" });
    const reference = await store.createInboxMessage({ customerId: customer.id, direction: "INBOUND", senderType: "CUSTOMER", text: "reference" });
    const unrelatedCase = await store.createCase({ customerId: customer.id, status: "assigned", title: "Other case" });
    const protectedMessage = await store.createInboxMessage({ customerId: customer.id, caseId: unrelatedCase.id, assignedCaseId: unrelatedCase.id, direction: "INBOUND", senderType: "CUSTOMER", text: "protected" });
    const targetCase = await store.createCase({ customerId: customer.id, status: "assigned", title: "Backfill case" });
    await store.createMessage({
      caseId: targetCase.id,
      direction: "INBOUND",
      channel: "line",
      originalText: reference.text,
      senderType: "CUSTOMER",
      messageType: "CUSTOMER_MESSAGE",
      deliveryStatus: "RECEIVED",
      metadata: { isCaseReference: true, sourceInboxMessageId: reference.id },
    });
    await store.createMessage({
      caseId: targetCase.id,
      direction: "INBOUND",
      channel: "line",
      originalText: protectedMessage.text,
      senderType: "CUSTOMER",
      messageType: "CUSTOMER_MESSAGE",
      deliveryStatus: "RECEIVED",
      metadata: { isCaseReference: true, sourceInboxMessageId: protectedMessage.id },
    });

    const { caseService } = await import("../services/case-service");
    const result = await caseService.backfillCaseReferenceMessages(targetCase.id);
    const inboxUser = await store.getInboxUser(customer.id);
    const updatedDetail = await store.getCaseDetail(targetCase.id);

    expect(result.assignedMessageIds).toEqual([reference.id]);
    expect(inboxUser?.messages.find((message) => message.id === reference.id)?.caseId).toBe(targetCase.id);
    expect(inboxUser?.messages.find((message) => message.id === protectedMessage.id)?.caseId).toBe(unrelatedCase.id);
    expect(updatedDetail?.messages.find((message) => message.metadata?.sourceInboxMessageId === reference.id)?.metadata?.assignedAt).toBeDefined();
    expect(updatedDetail?.messages.find((message) => message.metadata?.sourceInboxMessageId === reference.id)?.senderType).toBe("CUSTOMER");
    expect(updatedDetail?.messages.find((message) => message.metadata?.sourceInboxMessageId === reference.id)?.direction).toBe("INBOUND");
  });

  test("does not add Inbox messages as references when a case is opened manually", async () => {
    const customer = await store.upsertCustomer({ lineUserId: `U-inbox-manual-${++sequence}`, displayName: "Manual case" });
    await store.createInboxMessage({ customerId: customer.id, direction: "INBOUND", senderType: "CUSTOMER", text: "ข้อความเดิมใน Inbox" });
    const response = await openInboxCase(customer.id, {
      title: "หัวข้อที่กรอกเอง",
      description: "รายละเอียดที่กรอกเอง",
      from: new Date(Date.now() - 60_000).toISOString(),
      to: new Date().toISOString(),
    });
    const body = await response.json() as { data: { messages: Array<{ metadata?: Record<string, unknown> }> } };
    const referenceMessages = body.data.messages.filter((message) => message.metadata?.isCaseReference === true);
    const definition = body.data.messages.find((message) => message.metadata?.eventType === "CASE_CREATED_FROM_INBOX");

    expect(response.status).toBe(201);
    expect(referenceMessages).toHaveLength(0);
    expect(definition?.metadata?.selectedInboxMessageIds).toEqual([]);
  });

  test("records a failed delivery and does not close the case", async () => {
    const supportCase = await createCase();
    lineShouldFail = true;
    const response = await postAction({
      action: "CLOSE_CASE",
      caseId: supportCase.id,
      replyText: "ปิดเคสค่ะ",
      requestId: `failed-close-${sequence}`,
    });
    lineShouldFail = false;

    const detail = await store.getCaseDetail(supportCase.id);
    expect(response.status).toBe(502);
    expect(detail?.status).toBe("assigned");
    expect(detail?.messages.some((message) => message.deliveryStatus === "FAILED")).toBe(true);
  });

  test("keeps customer analysis in QUALITY queue when newer tech analysis has formal feedback", async () => {
    const fixture = await createMixedAnalysisReviewFixture({ customerFeedbackSource: "CASE_DETAIL" });

    const response = await app.fetch(new Request("http://localhost/confidence/suggestions"));
    const body = await response.json() as { data: Array<{ caseId: string; analysisId?: string; analysisVersion?: number; reviewStage: string }> };
    const suggestion = body.data.find((item) => item.caseId === fixture.supportCase.id);

    expect(response.status).toBe(200);
    expect(suggestion).toEqual(expect.objectContaining({
      analysisId: fixture.customerAnalysis.analysisId,
      analysisVersion: fixture.customerAnalysis.analysisVersion,
      reviewStage: "QUALITY",
    }));
    expect(fixture.latestTechAnalysis.analysisVersion).toBeGreaterThan(fixture.customerAnalysis.analysisVersion);
  });

  test("removes QUALITY item only after the current customer analysis is formally confirmed", async () => {
    const fixture = await createMixedAnalysisReviewFixture({ customerFeedbackSource: "CONFIDENCE_REVIEW" });

    const response = await app.fetch(new Request("http://localhost/confidence/suggestions"));
    const body = await response.json() as { data: Array<{ caseId: string }> };

    expect(response.status).toBe(200);
    expect(body.data.some((item) => item.caseId === fixture.supportCase.id)).toBe(false);
  });

  test("accepts review of latest customer analysis when a newer tech analysis exists", async () => {
    const supportCase = await createCase(85);
    for (let version = 1; version < 10; version += 1) {
      await store.createAnalysis({ caseId: supportCase.id, analysisType: "tech_solution", confidence: 85, rawJson: {} });
    }
    const customerAnalysis = await store.createAnalysis({
      caseId: supportCase.id,
      analysisType: "customer_message",
      confidence: 85,
      rawJson: {},
    });
    const techAnalysis = await store.createAnalysis({
      caseId: supportCase.id,
      analysisType: "tech_solution",
      confidence: 85,
      rawJson: {},
    });
    const solution = await store.createSolution({
      caseId: supportCase.id,
      rawReplyText: "restart service",
      solutionSteps: ["restart service"],
      rewrittenCustomerText: "restart service",
      confidence: 85,
      validatedByTeam: false,
    });

    const response = await postConfidenceReview({
      caseId: supportCase.id,
      analysisId: customerAnalysis.analysisId,
      analysisVersion: customerAnalysis.analysisVersion,
      solutionId: solution.id,
      reviewStage: "QUALITY",
      understandingResult: "CORRECT",
      solutionResult: "CORRECT",
    }, `match_${supportCase.id}`);
    const feedback = (await store.listAiReviewFeedback()).filter((item) => item.caseId === supportCase.id);

    expect(customerAnalysis.analysisVersion).toBe(10);
    expect(techAnalysis.analysisVersion).toBe(11);
    expect(response.status).toBe(200);
    expect(feedback).toHaveLength(2);
    expect(feedback.every((item) => item.analysisId === customerAnalysis.analysisId && item.reviewSource === "CONFIDENCE_REVIEW")).toBe(true);
  });

  test("rejects stale customer review only when a newer customer analysis exists", async () => {
    const supportCase = await createCase(85);
    for (let version = 1; version < 10; version += 1) {
      await store.createAnalysis({ caseId: supportCase.id, analysisType: "tech_solution", confidence: 85, rawJson: {} });
    }
    const oldCustomerAnalysis = await store.createAnalysis({
      caseId: supportCase.id,
      analysisType: "customer_message",
      confidence: 85,
      rawJson: {},
    });
    await store.createAnalysis({ caseId: supportCase.id, analysisType: "tech_solution", confidence: 85, rawJson: {} });
    const currentCustomerAnalysis = await store.createAnalysis({
      caseId: supportCase.id,
      analysisType: "customer_message",
      confidence: 85,
      rawJson: {},
    });

    const response = await postConfidenceReview({
      caseId: supportCase.id,
      analysisId: oldCustomerAnalysis.analysisId,
      analysisVersion: oldCustomerAnalysis.analysisVersion,
      reviewStage: "QUALITY",
      understandingResult: "CORRECT",
    }, `match_${supportCase.id}`);

    expect(currentCustomerAnalysis.analysisVersion).toBeGreaterThan(oldCustomerAnalysis.analysisVersion);
    expect(oldCustomerAnalysis.analysisVersion).toBe(10);
    expect(currentCustomerAnalysis.analysisVersion).toBe(12);
    expect(response.status).toBe(409);
    expect((await store.listAiReviewFeedback()).some((item) => item.caseId === supportCase.id)).toBe(false);
  });

  test("legacy QUALITY review writes feedback to latest customer analysis", async () => {
    const supportCase = await createCase(85);
    const customerAnalysis = await store.createAnalysis({
      caseId: supportCase.id,
      analysisType: "customer_message",
      confidence: 85,
      rawJson: {},
    });
    await store.createAnalysis({ caseId: supportCase.id, analysisType: "tech_solution", confidence: 95, rawJson: {} });
    const latestTechAnalysis = await store.createAnalysis({ caseId: supportCase.id, analysisType: "tech_solution", confidence: 95, rawJson: {} });
    const solution = await store.createSolution({
      caseId: supportCase.id,
      rawReplyText: "restart service",
      solutionSteps: ["restart service"],
      rewrittenCustomerText: "restart service",
      confidence: 95,
      validatedByTeam: false,
    });

    const response = await postConfidenceReview({
      caseId: supportCase.id,
      solutionId: solution.id,
      reviewStage: "QUALITY",
      result: "approved",
    }, `match_${supportCase.id}`);
    const feedback = (await store.listAiReviewFeedback()).filter((item) => item.caseId === supportCase.id);

    expect(response.status).toBe(200);
    expect(feedback).toHaveLength(2);
    expect(feedback.every((item) => item.analysisId === customerAnalysis.analysisId)).toBe(true);
    expect(feedback.every((item) => item.analysisId !== latestTechAnalysis.analysisId)).toBe(true);
  });

  test("keeps production-equivalent mixed-analysis cases in QUALITY queue", async () => {
    const fixtures = await Promise.all(Array.from({ length: 18 }, () => (
      createMixedAnalysisReviewFixture({ customerFeedbackSource: "CASE_DETAIL" })
    )));

    const response = await app.fetch(new Request("http://localhost/confidence/suggestions"));
    const body = await response.json() as { data: Array<{ caseId: string; analysisId?: string; reviewStage: string }> };

    expect(response.status).toBe(200);
    for (const fixture of fixtures) {
      expect(body.data.find((item) => item.caseId === fixture.supportCase.id)).toEqual(expect.objectContaining({
        analysisId: fixture.customerAnalysis.analysisId,
        reviewStage: "QUALITY",
      }));
    }
  });

  test("records 90-97% confirmation as quality review without enabling auto-answer", async () => {
    const supportCase = await createCase(95);
    await store.createAnalysis({
      caseId: supportCase.id,
      analysisType: "customer_message",
      category: "NETWORK_CONNECTION",
      confidence: 95,
      rawJson: {},
    });
    const solution = await store.createSolution({
      caseId: supportCase.id,
      rawReplyText: "ให้ลองออกจากระบบแล้วเข้าใหม่",
      rootCause: "session หมดอายุ",
      solutionSteps: ["ออกจากระบบ", "เข้าใหม่"],
      rewrittenCustomerText: "ลองออกจากระบบแล้วเข้าใหม่อีกครั้งนะคะ",
      confidence: 95,
      validatedByTeam: false,
    });
    const suggestionsResponse = await app.fetch(new Request("http://localhost/confidence/suggestions"));
    const suggestionsBody = await suggestionsResponse.json() as { data: Array<{ id: string; caseId: string; reviewStage: string }> };
    const suggestion = suggestionsBody.data.find((item) => item.caseId === supportCase.id);
    const detail = await store.getCaseDetail(supportCase.id);

    expect(suggestion).toBeDefined();
    expect(suggestion?.reviewStage).toBe("QUALITY");

    const reviewResponse = await postConfidenceReview({ caseId: supportCase.id, solutionId: solution.id, reviewStage: "QUALITY", result: "approved" }, suggestion?.id ?? "missing");
    const refreshedResponse = await app.fetch(new Request("http://localhost/confidence/suggestions"));
    const refreshedBody = await refreshedResponse.json() as { data: Array<{ caseId: string }> };

    expect(reviewResponse.status).toBe(200);
    expect(refreshedBody.data.some((item) => item.caseId === supportCase.id)).toBe(false);
    expect(detail?.status).toBe("assigned");
    expect(detail?.solutions.find((item) => item.id === solution.id)?.validatedByTeam).toBe(false);
  });

  test("lists Confidence Review by current analysis feedback status", async () => {
    const lowConfidenceCase = await createCase(95);
    await store.createAnalysis({
      caseId: lowConfidenceCase.id,
      analysisType: "customer_message",
      category: "NETWORK_CONNECTION",
      confidence: 95,
      rawJson: {},
    });
    await store.createSolution({
      caseId: lowConfidenceCase.id,
      rawReplyText: "ตรวจสอบการเชื่อมต่อเครือข่าย",
      solutionSteps: ["ตรวจสอบการเชื่อมต่อเครือข่าย"],
      rewrittenCustomerText: "กรุณาตรวจสอบการเชื่อมต่อเครือข่ายค่ะ",
      confidence: 95,
      validatedByTeam: false,
    });

    const negativeCase = await createCase(99);
    const negativeAnalysis = await store.createAnalysis({
      caseId: negativeCase.id,
      analysisType: "customer_message",
      category: "NETWORK_CONNECTION",
      confidence: 99,
      rawJson: {},
    });
    await store.createSolution({
      caseId: negativeCase.id,
      rawReplyText: "รีสตาร์ตระบบ",
      solutionSteps: ["รีสตาร์ตระบบ"],
      rewrittenCustomerText: "กรุณารีสตาร์ตระบบค่ะ",
      confidence: 99,
      validatedByTeam: false,
    });
    await patchAiFeedback(negativeCase.id, {
      analysisId: negativeAnalysis.analysisId,
      analysisVersion: negativeAnalysis.analysisVersion,
      feedbackType: "ISSUE_UNDERSTANDING",
      result: "INCORRECT",
    });

    const oldFeedbackCase = await createCase(99);
    const oldAnalysis = await store.createAnalysis({
      caseId: oldFeedbackCase.id,
      analysisType: "customer_message",
      category: "LOGIN_ACCESS",
      confidence: 99,
      rawJson: {},
    });
    await store.createSolution({
      caseId: oldFeedbackCase.id,
      rawReplyText: "ตรวจสอบสิทธิ์การเข้าใช้งาน",
      solutionSteps: ["ตรวจสอบสิทธิ์การเข้าใช้งาน"],
      rewrittenCustomerText: "กรุณาตรวจสอบสิทธิ์การเข้าใช้งานค่ะ",
      confidence: 99,
      validatedByTeam: false,
    });
    await patchAiFeedback(oldFeedbackCase.id, {
      analysisId: oldAnalysis.analysisId,
      analysisVersion: oldAnalysis.analysisVersion,
      feedbackType: "ISSUE_UNDERSTANDING",
      result: "INCORRECT",
    });
    const newAnalysis = await store.createAnalysis({
      caseId: oldFeedbackCase.id,
      analysisType: "customer_message",
      category: "LOGIN_ACCESS",
      confidence: 99,
      rawJson: { technicalTopic: "บัญชีถูกล็อก" },
    });

    const response = await app.fetch(new Request("http://localhost/confidence/suggestions"));
    const body = await response.json() as { data: Array<{ caseId: string; reviewStage: string; reviewStatus: string; analysisId?: string; analysisVersion?: number; technicalTopic?: string }> };
    const lowConfidenceSuggestion = body.data.find((item) => item.caseId === lowConfidenceCase.id);
    const negativeSuggestion = body.data.find((item) => item.caseId === negativeCase.id);
    const oldFeedbackSuggestion = body.data.find((item) => item.caseId === oldFeedbackCase.id);

    expect(response.status).toBe(200);
    expect(lowConfidenceSuggestion).toEqual(expect.objectContaining({ reviewStage: "QUALITY", reviewStatus: "LOW_CONFIDENCE" }));
    expect(negativeSuggestion).toEqual(expect.objectContaining({ reviewStage: "QUALITY", reviewStatus: "NEGATIVE_FEEDBACK" }));
    expect(oldFeedbackSuggestion).toEqual(expect.objectContaining({
      reviewStage: "AUTO_ANSWER",
      reviewStatus: "NOT_REVIEWED",
      analysisId: newAnalysis.analysisId,
      analysisVersion: newAnalysis.analysisVersion,
      technicalTopic: "บัญชีถูกล็อก",
    }));
  });

  test("uses the current analysis message and omits Solution confidence when no Solution exists", async () => {
    const supportCase = await createCase(90);
    await store.createMessage({
      caseId: supportCase.id,
      direction: "INBOUND",
      channel: "line",
      originalText: "ข้อความเก่าเรื่องอัปโหลดไฟล์",
      senderType: "CUSTOMER",
      messageType: "CUSTOMER_MESSAGE",
      deliveryStatus: "RECEIVED",
      metadata: { isCaseReference: false, sourceInboxMessageId: "inbox-confidence-history" },
    });
    await store.createMessage({
      caseId: supportCase.id,
      direction: "INBOUND",
      channel: "line",
      originalText: "ข้อความปัจจุบันเรื่องรหัสผ่านหมดอายุ",
      senderType: "CUSTOMER",
      messageType: "CUSTOMER_MESSAGE",
      deliveryStatus: "RECEIVED",
      metadata: { isCaseReference: true, sourceInboxMessageId: "inbox-confidence-current" },
    });
    const analysis = await store.createAnalysis({
      caseId: supportCase.id,
      analysisType: "customer_message",
      category: "LOGIN_ACCESS",
      confidence: 90,
      rawJson: { sourceMessageIds: ["inbox-confidence-current"] },
    });

    const response = await app.fetch(new Request("http://localhost/confidence/suggestions"));
    const body = await response.json() as { data: Array<{
      caseId: string;
      originalText: string;
      analysisId?: string;
      suggestedSolutionId: string;
      solutionText: string;
      hasSuggestedSolution?: boolean;
      caseDiscriminationConfidence?: number;
    }> };
    const suggestion = body.data.find((item) => item.caseId === supportCase.id);

    expect(response.status).toBe(200);
    expect(suggestion).toEqual(expect.objectContaining({
      originalText: "ข้อความปัจจุบันเรื่องรหัสผ่านหมดอายุ",
      analysisId: analysis.analysisId,
      suggestedSolutionId: "",
      solutionText: "—",
      hasSuggestedSolution: false,
    }));
    expect(suggestion?.caseDiscriminationConfidence).toBeUndefined();
  });

  test("keeps Case Detail feedback in the queue until Confidence Review confirms it", async () => {
    const supportCase = await createCase(95);
    const analysis = await store.createAnalysis({
      caseId: supportCase.id,
      analysisType: "customer_message",
      confidence: 95,
      rawJson: {},
    });
    const solution = await store.createSolution({
      caseId: supportCase.id,
      rawReplyText: "restart service",
      solutionSteps: ["restart service"],
      rewrittenCustomerText: "restart service",
      confidence: 95,
      validatedByTeam: false,
    });
    for (const feedbackType of ["ISSUE_UNDERSTANDING", "SOLUTION_SELECTION"] as const) {
      await patchAiFeedback(supportCase.id, {
        caseId: supportCase.id,
        analysisId: analysis.analysisId,
        analysisVersion: analysis.analysisVersion,
        feedbackType,
        value: "CORRECT",
      });
    }

    const beforeResponse = await app.fetch(new Request("http://localhost/confidence/suggestions"));
    const before = await beforeResponse.json() as { data: Array<{ id: string; caseId: string; reviewStage: string }> };
    const suggestion = before.data.find((item) => item.caseId === supportCase.id);
    expect(suggestion).toEqual(expect.objectContaining({ reviewStage: "QUALITY" }));

    const payload = {
      caseId: supportCase.id,
      analysisId: analysis.analysisId,
      analysisVersion: analysis.analysisVersion,
      reviewStage: "QUALITY",
      solutionId: solution.id,
      understandingResult: "CORRECT",
      solutionResult: "CORRECT",
    };
    expect((await postConfidenceReview(payload, suggestion?.id ?? "missing")).status).toBe(200);
    expect((await postConfidenceReview(payload, suggestion?.id ?? "missing")).status).toBe(200);

    const saved = (await store.listAiReviewFeedback()).filter((item) => item.caseId === supportCase.id);
    expect(saved).toHaveLength(2);
    expect(saved.every((item) => item.reviewSource === "CONFIDENCE_REVIEW")).toBe(true);
    const afterResponse = await app.fetch(new Request("http://localhost/confidence/suggestions"));
    const after = await afterResponse.json() as { data: Array<{ caseId: string }> };
    expect(after.data.some((item) => item.caseId === supportCase.id)).toBe(false);

    await patchAiFeedback(supportCase.id, {
      caseId: supportCase.id,
      analysisId: analysis.analysisId,
      analysisVersion: analysis.analysisVersion,
      feedbackType: "ISSUE_UNDERSTANDING",
      value: "CORRECT",
    });
    const reopenedResponse = await app.fetch(new Request("http://localhost/confidence/suggestions"));
    const reopened = await reopenedResponse.json() as { data: Array<{ caseId: string; reviewStage: string }> };
    expect(reopened.data.find((item) => item.caseId === supportCase.id)).toEqual(expect.objectContaining({ reviewStage: "QUALITY" }));
  });

  test("rejects Auto-answer without mutating model or solution confidence", async () => {
    const supportCase = await createCase(99);
    const analysis = await store.createAnalysis({
      caseId: supportCase.id,
      analysisType: "customer_message",
      confidence: 98,
      rawJson: {},
    });
    const solution = await store.createSolution({
      caseId: supportCase.id,
      rawReplyText: "restart service",
      solutionSteps: ["restart service"],
      rewrittenCustomerText: "restart service",
      confidence: 99,
      validatedByTeam: false,
    });
    const suggestionResponse = await app.fetch(new Request("http://localhost/confidence/suggestions"));
    const suggestions = await suggestionResponse.json() as { data: Array<{ id: string; caseId: string }> };
    const suggestion = suggestions.data.find((item) => item.caseId === supportCase.id);

    const rejected = await postConfidenceReview({
      caseId: supportCase.id,
      analysisId: analysis.analysisId,
      analysisVersion: analysis.analysisVersion,
      reviewStage: "AUTO_ANSWER",
      solutionId: solution.id,
      decision: "REJECTED",
      solutionResult: "INCORRECT",
      reason: "solution does not match the reviewed case",
    }, suggestion?.id ?? "missing");
    const detail = await store.getCaseDetail(supportCase.id);
    const feedback = (await store.listAiReviewFeedback()).find((item) => (
      item.caseId === supportCase.id && item.feedbackType === "SOLUTION_SELECTION"
    ));

    expect(rejected.status).toBe(200);
    expect(feedback).toEqual(expect.objectContaining({
      result: "INCORRECT",
      reason: "solution does not match the reviewed case",
      reviewSource: "CONFIDENCE_REVIEW",
    }));
    expect(detail?.confidenceReviewStatus).toBe("AUTO_ANSWER_REJECTED");
    expect(detail?.confidenceScore).toBe(99);
    expect(detail?.analyses.find((item) => item.analysisId === analysis.analysisId)?.confidence).toBe(98);
    expect(detail?.solutions.find((item) => item.id === solution.id)?.confidence).toBe(99);
    expect(detail?.solutions.find((item) => item.id === solution.id)?.autoAnswerReviewResult).toBe("REJECTED");
  });

  test("rejects stale analysis, mismatched solution, and changed review stage", async () => {
    const supportCase = await createCase(99);
    const oldAnalysis = await store.createAnalysis({
      caseId: supportCase.id,
      analysisType: "customer_message",
      confidence: 99,
      rawJson: {},
    });
    const solution = await store.createSolution({
      caseId: supportCase.id,
      rawReplyText: "restart service",
      solutionSteps: ["restart service"],
      rewrittenCustomerText: "restart service",
      confidence: 99,
      validatedByTeam: false,
    });
    const currentAnalysis = await store.createAnalysis({
      caseId: supportCase.id,
      analysisType: "customer_message",
      confidence: 99,
      rawJson: {},
    });
    const basePayload = {
      caseId: supportCase.id,
      reviewStage: "AUTO_ANSWER",
      solutionId: solution.id,
      decision: "APPROVED",
      understandingResult: "CORRECT",
      solutionResult: "CORRECT",
    };

    const stale = await postConfidenceReview({
      ...basePayload,
      analysisId: oldAnalysis.analysisId,
      analysisVersion: oldAnalysis.analysisVersion,
    }, `match_${supportCase.id}`);
    const wrongSolution = await postConfidenceReview({
      ...basePayload,
      analysisId: currentAnalysis.analysisId,
      analysisVersion: currentAnalysis.analysisVersion,
      solutionId: "wrong-solution",
    }, `match_${supportCase.id}`);
    const wrongStage = await postConfidenceReview({
      ...basePayload,
      analysisId: currentAnalysis.analysisId,
      analysisVersion: currentAnalysis.analysisVersion,
      reviewStage: "QUALITY",
    }, `match_${supportCase.id}`);

    expect(stale.status).toBe(409);
    expect(wrongSolution.status).toBe(409);
    expect(wrongStage.status).toBe(409);
    expect((await store.listAiReviewFeedback()).filter((item) => item.caseId === supportCase.id)).toHaveLength(0);
  });

  test("approves only a 98% solution for auto-answer and persists the automation switch", async () => {
    const supportCase = await createCase(99);
    const analysis = await store.createAnalysis({
      caseId: supportCase.id,
      analysisType: "customer_message",
      category: "NETWORK_CONNECTION",
      confidence: 99,
      rawJson: {},
    });
    const solution = await store.createSolution({
      caseId: supportCase.id,
      rawReplyText: "รีสตาร์ตเครื่องแล้วลองใหม่",
      solutionSteps: ["รีสตาร์ตเครื่อง", "ลองใช้งานอีกครั้ง"],
      rewrittenCustomerText: "ลองรีสตาร์ตเครื่องแล้วทดสอบอีกครั้งนะคะ",
      confidence: 99,
      validatedByTeam: false,
    });
    const suggestionResponse = await app.fetch(new Request("http://localhost/confidence/suggestions"));
    const suggestions = await suggestionResponse.json() as { data: Array<{ id: string; caseId: string; reviewStage: string }> };
    const suggestion = suggestions.data.find((item) => item.caseId === supportCase.id);

    const approved = await postConfidenceReview({
      caseId: supportCase.id,
      analysisId: analysis.analysisId,
      analysisVersion: analysis.analysisVersion,
      solutionId: solution.id,
      reviewStage: "AUTO_ANSWER",
      decision: "APPROVED",
      understandingResult: "CORRECT",
      solutionResult: "CORRECT",
    }, suggestion?.id ?? "missing");
    const refreshedSuggestionsResponse = await app.fetch(new Request("http://localhost/confidence/suggestions"));
    const refreshedSuggestions = await refreshedSuggestionsResponse.json() as { data: Array<{ caseId: string }> };
    const before = await app.fetch(new Request("http://localhost/automation/settings"));
    const beforeBody = await before.json() as { data: { enabled: boolean } };
    const enabled = await app.fetch(new Request("http://localhost/automation/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    }));
    const enabledBody = await enabled.json() as { data: { enabled: boolean } };
    const persisted = await app.fetch(new Request("http://localhost/automation/settings"));
    const persistedBody = await persisted.json() as { data: { enabled: boolean } };
    await app.fetch(new Request("http://localhost/automation/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    }));

    const detail = await store.getCaseDetail(supportCase.id);
    expect(approved.status).toBe(200);
    expect(suggestion?.reviewStage).toBe("AUTO_ANSWER");
    expect(detail?.confidenceReviewStatus).toBe("AUTO_ANSWER_APPROVED");
    expect(detail?.solutions.find((item) => item.id === solution.id)?.validatedByTeam).toBe(true);
    expect(detail?.solutions.find((item) => item.id === solution.id)?.autoAnswerReviewResult).toBe("APPROVED");
    expect(refreshedSuggestions.data.some((item) => item.caseId === supportCase.id)).toBe(false);
    expect(beforeBody.data.enabled).toBe(false);
    expect(enabledBody.data.enabled).toBe(true);
    expect(persistedBody.data.enabled).toBe(true);
  });

  test("emergency-disables auto-answer from a validated audit action idempotently", async () => {
    const supportCase = await createCase(99);
    const audit = await store.createMessage({
      caseId: supportCase.id,
      direction: "outbound_customer",
      channel: "line",
      originalText: "Auto-answer already sent",
      senderType: "BOT",
      messageType: "AUTO_ANSWER",
      deliveryStatus: "sent",
      metadata: { autoAnswerSolutionId: "solution-emergency", autoAnswerTeamsNotified: true },
    });
    await store.updateAutomationSettings({ enabled: true, emergencyDisabledAt: undefined });
    const payload = {
      action: "EMERGENCY_DISABLE_AUTO_ANSWER",
      caseId: supportCase.id,
      caseNumber: supportCase.caseNumber,
      caseMessageId: audit.id,
    };

    const first = await postAction(payload);
    const second = await postAction(payload);
    const firstBody = await first.json() as { success: boolean; duplicate: boolean };
    const secondBody = await second.json() as { success: boolean; duplicate: boolean };
    const settings = await store.getAutomationSettings();

    expect(first.status).toBe(200);
    expect(firstBody).toMatchObject({ success: true, duplicate: false });
    expect(second.status).toBe(200);
    expect(secondBody).toMatchObject({ success: true, duplicate: true });
    expect(settings.enabled).toBe(false);
    expect(settings.emergencyDisabledAt).toBeDefined();
  });
});
