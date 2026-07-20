import { describe, expect, mock, test } from "bun:test";
import { InMemoryStore } from "../repositories/in-memory-store";

const store = new InMemoryStore();
const lineReplies: string[] = [];

mock.module("../repositories/store", () => ({ store }));
mock.module("./line-client", () => ({
  lineClient: {
    getProfile: async () => undefined,
    reply: async () => ({ delivered: true }),
    replyToToken: async (input: { text: string }) => { lineReplies.push(input.text); return { delivered: true }; },
  },
}));
mock.module("./teams-client", () => ({
  teamsClient: {
    notifyCase: async () => ({ delivered: true }),
  },
}));
mock.module("./ai-center-client", () => ({
  aiCenterClient: {
    analyzeCustomerMessage: async (input: { text: string }) => ({
      summary: input.text,
      caseTitle: "ส่งงานใน Microsoft Teams ไม่สำเร็จ",
      category: "ปัญหาการส่งงาน",
      urgency: "medium",
      confidence: 85,
      status: "AI_SUCCESS",
      missingInformation: [],
      suggestedTeamNote: "ตรวจสอบข้อมูลการส่งงาน",
      sentiment: "neutral",
    }),
    analyzeCaseRelation: async () => ({ related: true, confidence: 100, reason: "pending question" }),
    extractPendingInformation: async () => ({ values: {} }),
    classifyLineMessageIntent: async () => ({ intent: "NEW_SUPPORT_ISSUE", shouldCreateCase: true, targetCaseNumber: null, confidence: 1, reason: "test" }),
    generateLineContinuationReply: async (input: { replyType?: string; requestedNextQuestion?: string }) =>
      input.replyType === "FOLLOW_UP_QUESTION" && input.requestedNextQuestion
        ? input.requestedNextQuestion
        : "รับทราบค่ะ เดี๋ยวตรวจสอบข้อมูลนี้ต่อให้นะคะ",
    generateProblemSummary: async (input: { currentProblemSummary?: string; latestCustomerMessage: string }) => ({
      problemSummary: input.currentProblemSummary ?? input.latestCustomerMessage,
      shouldUpdate: !input.currentProblemSummary,
      reason: "test",
      status: "SUCCESS",
    }),
  },
}));

const { caseService } = await import("./case-service");
const { receiveLineTextMessage } = await import("./line-webhook-service");

let sequence = 0;

async function createCaseWaitingForSubmissionDetails() {
  sequence += 1;
  const lineUserId = `U-pending-info-${sequence}`;
  const customer = await store.upsertCustomer({ lineUserId, displayName: `Customer ${sequence}` });
  const supportCase = await store.createCase({
    customerId: customer.id,
    status: "awaiting_tech",
    title: "ส่งงานใน Microsoft Teams แล้วแต่ยังไม่ได้รับงาน",
  });
  await store.createMessage({
    caseId: supportCase.id,
    direction: "inbound_customer",
    channel: "line",
    originalText: "ส่งงานใน Microsoft Teams ไปแล้วแต่ยังไม่ได้รับงาน",
    externalMessageId: `initial-${sequence}`,
    senderType: "CUSTOMER",
    messageType: "CUSTOMER_MESSAGE",
  });
  await caseService.requestAdditionalInfo(
    supportCase.id,
    "รบกวนแจ้งชื่อวิชาหรือทีมที่ส่งงาน และเวลาที่ส่งงานเพิ่มเติมได้ไหมคะ",
  );
  return { customer, lineUserId, supportCase };
}

async function sendReply(input: { lineUserId: string; messageId: string; text: string }) {
  return receiveLineTextMessage({
    ...input,
    replyToken: `reply-${input.messageId}`,
    timestamp: Date.now(),
  });
}

describe("pending LINE information requests", () => {
  test("keeps a combined subject and time answer in the requested case and forwards it to Teams", async () => {
    const { customer, lineUserId, supportCase } = await createCaseWaitingForSubmissionDetails();

    await sendReply({ lineUserId, messageId: "pending-combined", text: "คณิตศาสตร์ ช่วงสองโมง" });

    const cases = await caseService.getCustomerCases(customer.id);
    const detail = await caseService.getCase(supportCase.id);
    const updatedCustomer = await store.upsertCustomer({ lineUserId });
    expect(cases).toHaveLength(1);
    expect(detail?.messages.some((message) => message.originalText === "คณิตศาสตร์ ช่วงสองโมง" && message.messageType === "CUSTOMER_ADDITIONAL_INFO")).toBe(true);
    expect(detail?.messages.some((message) => message.messageType === "CASE_FORWARDED")).toBe(true);
    expect(detail?.messages.some((message) => message.originalText.includes("วิชา/ทีม คณิตศาสตร์") && message.originalText.includes("ส่งงานช่วงสองโมง"))).toBe(true);
    expect(updatedCustomer.pendingCaseSelection).toBeUndefined();
  });

  test("keeps the pending state for a short subject answer and asks only for the missing time", async () => {
    const { lineUserId, supportCase } = await createCaseWaitingForSubmissionDetails();

    await sendReply({ lineUserId, messageId: "pending-subject", text: "คณิตศาสตร์" });

    const detail = await caseService.getCase(supportCase.id);
    const updatedCustomer = await store.upsertCustomer({ lineUserId });
    const latestRequest = detail?.messages.filter((message) => message.messageType === "REQUEST_MORE_INFO").at(-1);
    expect(updatedCustomer.pendingCaseSelection?.pendingAction).toBe("REQUEST_MORE_INFO");
    expect(updatedCustomer.pendingCaseSelection?.pendingCollectedFields?.subjectOrTeam).toBe("คณิตศาสตร์");
    expect(latestRequest?.originalText).toContain("เวลาที่ส่งงาน");
    expect(latestRequest?.originalText).not.toContain("ชื่อวิชาหรือทีมที่ส่งงานเพิ่มเติม");
  });

  test("accepts a short time answer after a separate subject answer without creating another case", async () => {
    const { customer, lineUserId, supportCase } = await createCaseWaitingForSubmissionDetails();

    await sendReply({ lineUserId, messageId: "pending-split-subject", text: "คณิตศาสตร์" });
    await sendReply({ lineUserId, messageId: "pending-split-time", text: "บ่ายสอง" });

    const cases = await caseService.getCustomerCases(customer.id);
    const detail = await caseService.getCase(supportCase.id);
    const updatedCustomer = await store.upsertCustomer({ lineUserId });
    expect(cases).toHaveLength(1);
    expect(detail?.messages.some((message) => message.originalText === "บ่ายสอง" && message.messageType === "CUSTOMER_ADDITIONAL_INFO")).toBe(true);
    const latestReply = detail?.messages.filter((message) => message.senderType === "BOT").at(-1)?.originalText ?? "";
    expect(latestReply).not.toContain("เพิ่มข้อมูลในเคส");
    expect(latestReply).not.toContain(supportCase.caseNumber);
    expect(updatedCustomer.pendingCaseSelection).toBeUndefined();
  });

  test("keeps a short time-only answer pending when the subject or team is still missing", async () => {
    const { lineUserId, supportCase } = await createCaseWaitingForSubmissionDetails();

    await sendReply({ lineUserId, messageId: "pending-time", text: "บ่ายสอง" });

    const detail = await caseService.getCase(supportCase.id);
    const updatedCustomer = await store.upsertCustomer({ lineUserId });
    const latestRequest = detail?.messages.filter((message) => message.messageType === "REQUEST_MORE_INFO").at(-1);
    expect(updatedCustomer.pendingCaseSelection?.pendingAction).toBe("REQUEST_MORE_INFO");
    expect(updatedCustomer.pendingCaseSelection?.pendingCollectedFields?.submittedAtText).toBe("บ่ายสอง");
    expect(latestRequest?.originalText).toContain("ชื่อวิชาหรือทีมที่ส่งงาน");
  });
});

describe("LINE case query guards", () => {
  test("answers a case count query without creating a new case", async () => {
    sequence += 1;
    const lineUserId = `U-case-query-${sequence}`;
    const customer = await store.upsertCustomer({ lineUserId, displayName: `Query Customer ${sequence}` });
    await store.createCase({ customerId: customer.id, status: "awaiting_tech", title: "ปัญหาการเชื่อมต่อ" });

    const before = await caseService.getCustomerCases(customer.id);
    await sendReply({ lineUserId, messageId: `case-query-${sequence}`, text: "ตอนนี้ฉันเปิดไปกี่เคส" });
    const after = await caseService.getCustomerCases(customer.id);

    expect(after).toHaveLength(before.length);
    expect(lineReplies.at(-1)).toContain(`คุณเคยเปิดเคสทั้งหมด ${before.length} เคสค่ะ`);
  });

  test("does not expose another customer's case when checking a case status", async () => {
    sequence += 1;
    const lineUserId = `U-case-status-${sequence}`;
    const otherCustomer = await store.upsertCustomer({ lineUserId: `U-other-${sequence}`, displayName: "Other Customer" });
    const otherCase = await store.createCase({ customerId: otherCustomer.id, status: "awaiting_tech", title: "ข้อมูลส่วนตัวของอีกคน" });

    await sendReply({ lineUserId, messageId: `case-status-${sequence}`, text: `สถานะเคส ${otherCase.caseNumber}` });

    expect(lineReplies.at(-1)).toContain("ไม่พบเคสหมายเลขนี้ในประวัติของคุณค่ะ");
    expect(await caseService.getCustomerCases((await store.upsertCustomer({ lineUserId })).id)).toHaveLength(0);
  });
});
