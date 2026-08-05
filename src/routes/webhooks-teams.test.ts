import { describe, expect, mock, test } from "bun:test";
import { InMemoryStore } from "../repositories/in-memory-store";

const store = new InMemoryStore();
let lineShouldFail = false;
let lineSendCount = 0;

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
mock.module("../services/teams-client", () => ({ teamsClient: { notifyCase: async () => ({ delivered: true }) } }));
mock.module("../services/ai-center-client", () => ({
  aiCenterClient: {
    analyzeCustomerMessage: async () => ({ status: "AI_SUCCESS", summary: "summary", caseTitle: "title", category: "category", urgency: "medium", confidence: 85, missingInformation: [] }),
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
    analyzeTechSolution: async () => ({
      solutionSteps: [],
      teamActions: ["รีเซ็ตข้อมูลในระบบแล้ว"],
      rewrittenCustomerText: "",
    }),
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

describe("POST /webhooks/teams/actions", () => {
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
      analysisId: analysis.analysisId,
      analysisVersion: analysis.analysisVersion,
      feedbackType: "ISSUE_UNDERSTANDING",
      result: "CORRECT",
    });
    const solutionResponse = await patchAiFeedback(supportCase.id, {
      analysisId: analysis.analysisId,
      analysisVersion: analysis.analysisVersion,
      feedbackType: "SOLUTION_SELECTION",
      result: "INCORRECT",
    });
    const detail = await store.getCaseDetail(supportCase.id);

    expect(understandingResponse.status).toBe(200);
    expect(solutionResponse.status).toBe(200);
    const understanding = await understandingResponse.json() as { data?: { feedback?: { id?: string; analysisId?: string; analysisVersion?: number; result?: string } } };
    const solution = await solutionResponse.json() as { data?: { feedback?: { analysisVersion?: number; result?: string } } };
    expect(understanding.data?.feedback?.analysisId).toBe(analysis.analysisId);
    expect(understanding.data?.feedback?.analysisVersion).toBe(analysis.analysisVersion);
    expect(understanding.data?.feedback?.result).toBe("CORRECT");
    expect(solution.data?.feedback?.result).toBe("INCORRECT");
    expect(solution.data?.feedback?.analysisVersion).toBe(analysis.analysisVersion);
    expect(detail?.caseUnderstandingFeedback).toBeUndefined();
    expect(detail?.solutionSelectionFeedback).toBeUndefined();
    expect(detail?.confidenceScore).toBe(73);
    expect(detail?.analyses.find((item) => item.analysisId === analysis.analysisId)?.confidence).toBe(85);

    const updatedResponse = await patchAiFeedback(supportCase.id, {
      analysisId: analysis.analysisId,
      analysisVersion: analysis.analysisVersion,
      feedbackType: "ISSUE_UNDERSTANDING",
      result: "INCORRECT",
    });
    const updated = await updatedResponse.json() as { data?: { feedback?: { id?: string; result?: string } } };
    expect(updatedResponse.status).toBe(200);
    expect(updated.data?.feedback?.id).toBe(understanding.data?.feedback?.id);
    expect(updated.data?.feedback?.result).toBe("INCORRECT");
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
    const confirmed = await postConfidenceReview({
      caseId: supportCase.id,
      analysisId: analysis.analysisId,
      analysisVersion: analysis.analysisVersion,
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
      solutionResult: "INCORRECT",
      reason: "วิธีแก้ยังไม่ตรงกับข้อมูลที่ทีมตรวจสอบ",
    }, `match_${supportCase.id}`);
    const rejectionBody = await rejected.json() as {
      data?: { feedback?: Array<{ feedbackType: string; result: string }>; case?: { confidenceReviewStatus?: string } };
    };

    expect(rejected.status).toBe(200);
    expect(rejectionBody.data?.feedback).toEqual([
      expect.objectContaining({ feedbackType: "SOLUTION_SELECTION", result: "INCORRECT" }),
    ]);
    expect(rejectionBody.data?.case?.confidenceReviewStatus).toBe("QUALITY_REJECTED");
    const afterRejection = await store.getCaseDetail(supportCase.id);
    expect(afterRejection?.confidenceScore).toBe(94);
    expect(afterRejection?.analyses.find((item) => item.analysisId === analysis.analysisId)?.confidence).toBe(91);
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

    for (const supportCase of supportCases.slice(1)) {
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
    }

    const response = await app.fetch(new Request("http://localhost/analytics/summary"));
    const body = await response.json() as { data: { categories: Array<{ key: string; caseUnderstandingAccuracy: number; caseUnderstandingReviewedCount: number }> } };
    const network = body.data.categories.find((item) => item.key === "NETWORK_CONNECTION");

    expect(response.status).toBe(200);
    expect(network?.caseUnderstandingReviewedCount).toBe(4);
    expect(network?.caseUnderstandingAccuracy).toBe(75);
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
    const body = await response.json() as { data: { id: string; messages: Array<{ originalText: string; sourceMessageId?: string; externalMessageId?: string; webhookEventId?: string; metadata?: Record<string, unknown> }> } };
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
    expect(analysisContext?.caseAnalysisContext?.subject).toBe("หัวข้อจากทีม Tech");
    expect(analysisContext?.caseAnalysisContext?.detail).toBe("รายละเอียดจากทีม Tech");
    expect(analysisContext?.caseAnalysisContext?.referenceMessages?.map((message) => message.messageId)).toEqual([second.id]);
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

  test("records 90-97% confirmation as quality review without enabling auto-answer", async () => {
    const supportCase = await createCase(95);
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

  test("approves only a 98% solution for auto-answer and persists the automation switch", async () => {
    const supportCase = await createCase(99);
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

    const approved = await postConfidenceReview({ caseId: supportCase.id, solutionId: solution.id, reviewStage: "AUTO_ANSWER", result: "approved" }, suggestion?.id ?? "missing");
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
    expect(beforeBody.data.enabled).toBe(false);
    expect(enabledBody.data.enabled).toBe(true);
    expect(persistedBody.data.enabled).toBe(true);
  });
});
