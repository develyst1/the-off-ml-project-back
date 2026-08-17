import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const cases = [
  {
    caseNumber: "OFF-2026-00001",
    category: "SOFTWARE_APPLICATION",
    confidenceScore: 75,
    customer: { displayName: "Test Customer" },
    analyses: [],
    solutions: [
      {
        id: "solution-auto",
        solutionSteps: ["ออกจากระบบ", "เข้าสู่ระบบใหม่"],
        confidence: 99,
        validatedByTeam: true,
        validatedAt: "2026-07-22T07:59:00.000Z",
      },
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
      {
        id: "auto-answer-teams-failed",
        createdAt: "2026-07-22T08:02:00.000Z",
        originalText: "Teams failed after this LINE auto-answer was sent",
        messageType: "AUTO_ANSWER",
        deliveryStatus: "SENT",
        metadata: {
          autoAnswerSolutionId: "solution-auto",
          autoAnswerTeamsNotified: false,
          autoAnswerTeamsNotificationStatus: "FAILED",
        },
      },
    ],
  },
];

let reliabilityShouldFail = false;

mock.module("../repositories/store", () => ({
  store: {
    getAutomationSettings: async () => ({
      enabled: false,
      caseUnderstandingThreshold: 98,
      caseDiscriminationThreshold: 98,
      learnedReliabilityThreshold: 90,
      updatedBy: "ระบบเริ่มต้น",
    }),
    updateAutomationSettings: async (patch: Record<string, unknown>) => ({
      enabled: false,
      ...patch,
      updatedAt: "2026-08-11T00:00:00.000Z",
    }),
    listAiReviewFeedbackForReliability: async () => {
      if (reliabilityShouldFail) throw new Error("database unavailable");
      return [
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `understanding-${index}`,
        caseId: `case-understanding-${index}`,
        analysisId: `analysis-understanding-${index}`,
        analysisVersion: 1,
        feedbackType: "ISSUE_UNDERSTANDING" as const,
        result: "CORRECT" as const,
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `solution-${index}`,
        caseId: `case-solution-${index}`,
        analysisId: `analysis-solution-${index}`,
        analysisVersion: 1,
        feedbackType: "SOLUTION_SELECTION" as const,
        result: "CORRECT" as const,
      })),
      ];
    },
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
  test("extends settings with read-only learned reliability", async () => {
    const response = await app.fetch(new Request("http://localhost/automation/settings"));
    const body = await response.json() as {
      data: {
        enabled: boolean;
        learnedReliability: {
          threshold: number;
          minimumSample: number;
          issueUnderstanding: { status: string; reliability: number };
          solutionSelection: { status: string; reliability: number };
        };
        learnedReliabilityDecision: { allowed: boolean };
      };
    };

    expect(response.status).toBe(200);
    expect(body.data.enabled).toBe(false);
    expect(body.data.learnedReliability).toMatchObject({
      threshold: 0.9,
      minimumSample: 5,
      issueUnderstanding: { status: "READY", reliability: 1 },
      solutionSelection: { status: "READY", reliability: 1 },
    });
    expect(body.data.learnedReliabilityDecision.allowed).toBe(true);
  });

  test("keeps settings available and fails closed when reliability cannot be loaded", async () => {
    reliabilityShouldFail = true;
    const response = await app.fetch(new Request("http://localhost/automation/settings"));
    reliabilityShouldFail = false;
    const body = await response.json() as {
      data: { learnedReliability: null; learnedReliabilityDecision: { allowed: boolean; reason?: string } };
    };

    expect(response.status).toBe(200);
    expect(body.data.learnedReliability).toBeNull();
    expect(body.data.learnedReliabilityDecision).toEqual({
      allowed: false,
      reason: "LEARNED_RELIABILITY_UNAVAILABLE",
    });
  });

  test("keeps learned reliability in the settings response after an update", async () => {
    const response = await app.fetch(new Request("http://localhost/automation/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    }));
    const body = await response.json() as {
      data: { enabled: boolean; learnedReliability: { threshold: number }; learnedReliabilityDecision: { allowed: boolean } };
    };

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      enabled: true,
      learnedReliability: { threshold: 0.9 },
      learnedReliabilityDecision: { allowed: true },
    });
  });

  test("saves the three thresholds and exposes audit metadata", async () => {
    const response = await app.fetch(new Request("http://localhost/automation/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        caseUnderstandingThreshold: 90,
        caseDiscriminationThreshold: 90,
        learnedReliabilityThreshold: 80,
        updatedBy: "ผู้ดูแลระบบ",
      }),
    }));
    const body = await response.json() as { data: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      caseUnderstandingThreshold: 90,
      caseDiscriminationThreshold: 90,
      learnedReliabilityThreshold: 80,
      updatedBy: "ผู้ดูแลระบบ",
    });
  });

  test("rejects thresholds outside their safe ranges", async () => {
    const response = await app.fetch(new Request("http://localhost/automation/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ learnedReliabilityThreshold: 69 }),
    }));

    expect(response.status).toBe(400);
  });

  test("lists only messages actually sent by auto-answer", async () => {
    const response = await app.fetch(new Request("http://localhost/automation/logs"));
    const body = await response.json() as {
      data: { totalItems: number; items: Array<{ id: string; solutionText?: string; teamsNotified: boolean }> };
    };

    expect(response.status).toBe(200);
    expect(body.data.totalItems).toBe(2);
    expect(body.data.items.find((item) => item.id === "auto-answer")).toMatchObject({
      id: "auto-answer",
      solutionText: "ออกจากระบบ\nเข้าสู่ระบบใหม่",
      teamsNotified: true,
    });
    expect(body.data.items.find((item) => item.id === "auto-answer-teams-failed")).toMatchObject({
      id: "auto-answer-teams-failed",
      teamsNotified: false,
    });
  });

  test("returns Thai category labels for guardrail-ready solutions", async () => {
    const response = await app.fetch(new Request("http://localhost/automation/solutions"));
    const body = await response.json() as { data: Array<{ category: string; caseUnderstandingConfidence: number; caseDiscriminationConfidence: number }> };

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      category: "ปัญหาซอฟต์แวร์",
      caseUnderstandingConfidence: 75,
      caseDiscriminationConfidence: 99,
    });
  });
});
