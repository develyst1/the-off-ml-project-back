import { expect, mock, test } from "bun:test";

let postedBody: Record<string, unknown> | undefined;

mock.module("../config/env", () => ({
  env: {
    TEAMS_WEBHOOK_URL: "https://teams.example.test/webhook",
    FRONTEND_BASE_URL: "https://off.example.test",
  },
}));

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  postedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
  return new Response(null, { status: 200 });
}) as typeof fetch;

const { teamsClient } = await import("./teams-client");

test("API-016 Teams card contains the auto-answer audit identity and emergency-disable action", async () => {
  try {
    const result = await teamsClient.notifyAutoAnswer({
      caseId: "case-016",
      caseNumber: "OFF-2026-00016",
      caseMessageId: "message-016",
      customerName: "API customer",
      lineUserId: "U-api-customer",
      answerText: "Restart the application and reconnect.",
      solutionId: "solution-016",
      solutionText: "Restart the application\nReconnect",
      analysisId: "analysis-016",
      analysisVersion: 3,
      sentAt: "2026-08-11T10:00:00.000Z",
      lineDeliveryStatus: "SENT",
    });

    const body = postedBody?.body as Array<Record<string, unknown>>;
    const actions = postedBody?.actions as Array<Record<string, unknown>>;
    expect(result.delivered).toBe(true);
    expect(JSON.stringify(body)).toContain("Restart the application and reconnect.");
    expect(JSON.stringify(body)).toContain("solution-016");
    expect(JSON.stringify(body)).toContain("analysis-016 v3");
    expect(actions[0]).toMatchObject({
      type: "Action.Submit",
      data: {
        action: "EMERGENCY_DISABLE_AUTO_ANSWER",
        caseId: "case-016",
        caseMessageId: "message-016",
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
