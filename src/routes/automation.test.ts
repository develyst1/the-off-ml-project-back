import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const cases = [
  {
    caseNumber: "OFF-2026-00001",
    customer: { displayName: "Test Customer" },
    solutions: [
      { id: "solution-auto", solutionSteps: ["ออกจากระบบ", "เข้าสู่ระบบใหม่"] },
    ],
    messages: [
      {
        id: "manual-reply",
        createdAt: "2026-07-22T08:00:00.000Z",
        originalText: "ทีมงานจะตรวจสอบให้นะคะ",
        messageType: "CASE_ACKNOWLEDGEMENT",
        deliveryStatus: "SENT",
      },
      {
        id: "auto-answer",
        createdAt: "2026-07-22T08:01:00.000Z",
        originalText: "ลองออกจากระบบแล้วเข้าสู่ระบบใหม่อีกครั้งนะคะ",
        messageType: "AUTO_ANSWER",
        deliveryStatus: "SENT",
        metadata: {
          autoAnswerSolutionId: "solution-auto",
          autoAnswerTeamsNotified: true,
        },
      },
    ],
  },
];

mock.module("../repositories/store", () => ({
  store: {
    getAutomationSettings: async () => ({ enabled: false }),
  },
}));

mock.module("../services/case-service", () => ({
  caseService: {
    listCases: async () => cases,
  },
}));

const { automationRoutes } = await import("./automation");
const app = new Hono().route("/automation", automationRoutes);

describe("automation logs", () => {
  test("lists only messages actually sent by auto-answer", async () => {
    const response = await app.fetch(new Request("http://localhost/automation/logs"));
    const body = await response.json() as {
      data: { totalItems: number; items: Array<{ id: string; solutionText?: string; teamsNotified: boolean }> };
    };

    expect(response.status).toBe(200);
    expect(body.data.totalItems).toBe(1);
    expect(body.data.items[0]).toMatchObject({
      id: "auto-answer",
      solutionText: "ออกจากระบบ\nเข้าสู่ระบบใหม่",
      teamsNotified: true,
    });
  });
});
