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
    analyzeTechSolution: async () => ({ solutionSteps: [], rewrittenCustomerText: "" }),
    reviewTechMessageForCustomer: async () => ({ shouldSendToCustomer: false, reviewFailed: false }),
  },
}));

const { app } = await import("../app");

let sequence = 0;

async function createCase() {
  sequence += 1;
  const customer = await store.upsertCustomer({ lineUserId: `U-teams-${sequence}`, displayName: `Teams customer ${sequence}` });
  return store.createCase({ customerId: customer.id, status: "assigned", title: "Teams action test" });
}

function postAction(body: Record<string, unknown>) {
  return app.fetch(new Request("http://localhost/webhooks/teams/actions", {
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
});
