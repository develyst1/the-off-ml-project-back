import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { InMemoryStore } from "../repositories/in-memory-store";

const store = new InMemoryStore();
const autoAnswerTeamsPayloads: Array<Record<string, unknown>> = [];

mock.module("../repositories/store", () => ({ store }));
mock.module("../services/teams-client", () => ({
  teamsClient: {
    getStatus: () => ({ connected: true, valid: true, mode: "incoming_webhook" }),
    notifyCase: async () => ({ delivered: true }),
    notifyAutoAnswer: async (input: Record<string, unknown>) => {
      autoAnswerTeamsPayloads.push(input);
      return { delivered: true };
    },
  },
}));

const { integrationRoutes } = await import("./integrations");
const app = new Hono().route("/integrations", integrationRoutes);

let sequence = 0;

async function createAutoAnswerAudit() {
  sequence += 1;
  const customer = await store.upsertCustomer({
    lineUserId: `U-api-016-${sequence}`,
    displayName: `API-016 customer ${sequence}`,
  });
  const supportCase = await store.createCase({
    customerId: customer.id,
    status: "assigned",
    title: "API-016 validation case",
    confidenceScore: 99,
  });
  const source = await store.createMessage({
    caseId: supportCase.id,
    direction: "inbound_customer",
    channel: "line",
    originalText: "Customer follow-up",
    senderType: "CUSTOMER",
    messageType: "CUSTOMER_ADDITIONAL_INFO",
  });
  const analysis = await store.createAnalysis({
    caseId: supportCase.id,
    messageId: source.id,
    analysisType: "customer_message",
    summary: "Connection issue",
    category: "NETWORK_CONNECTION",
    confidence: 99,
    rawJson: {},
  });
  const solution = await store.createSolution({
    caseId: supportCase.id,
    rawReplyText: "Restart and reconnect",
    solutionSteps: ["Restart the application", "Reconnect"],
    rewrittenCustomerText: "Please restart and reconnect.",
    confidence: 99,
    validatedByTeam: true,
    validatedAt: new Date().toISOString(),
  });
  const audit = await store.createMessage({
    caseId: supportCase.id,
    direction: "outbound_customer",
    channel: "line",
    originalText: "Please restart the application and reconnect.",
    senderType: "BOT",
    messageType: "AUTO_ANSWER",
    sourceMessageId: source.id,
    deliveryStatus: "sent",
    metadata: {
      autoAnswerSolutionId: solution.id,
      autoAnswerAnalysisId: analysis.analysisId,
      autoAnswerAnalysisVersion: analysis.analysisVersion,
      autoAnswerSourceMessageId: source.id,
      autoAnswerTeamsNotified: false,
      autoAnswerTeamsNotificationStatus: "PENDING",
    },
  });
  return { supportCase, solution, analysis, audit };
}

function postAutoAnswerLog(body: Record<string, unknown>) {
  return app.fetch(new Request("http://localhost/integrations/teams/auto-answer-log", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("POST /integrations/teams/auto-answer-log", () => {
  test("validates the stored audit identity and does not notify Teams twice", async () => {
    const setup = await createAutoAnswerAudit();
    const callsBefore = autoAnswerTeamsPayloads.length;
    const identity = {
      caseId: setup.supportCase.id,
      caseMessageId: setup.audit.id,
      solutionId: setup.solution.id,
      analysisId: setup.analysis.analysisId,
      analysisVersion: setup.analysis.analysisVersion,
    };

    const first = await postAutoAnswerLog(identity);
    const second = await postAutoAnswerLog(identity);
    const firstBody = await first.json() as { data: { delivered: boolean; duplicate: boolean } };
    const secondBody = await second.json() as { data: { delivered: boolean; duplicate: boolean } };
    const detail = await store.getCaseDetail(setup.supportCase.id);
    const audit = detail?.messages.find((message) => message.id === setup.audit.id);

    expect(first.status).toBe(200);
    expect(firstBody.data).toMatchObject({ delivered: true, duplicate: false });
    expect(second.status).toBe(200);
    expect(secondBody.data).toMatchObject({ delivered: true, duplicate: true });
    expect(autoAnswerTeamsPayloads.length - callsBefore).toBe(1);
    expect(audit?.metadata?.autoAnswerTeamsNotified).toBe(true);
    expect(autoAnswerTeamsPayloads.at(-1)).toMatchObject({
      caseId: setup.supportCase.id,
      caseMessageId: setup.audit.id,
      solutionId: setup.solution.id,
      analysisId: setup.analysis.analysisId,
      analysisVersion: setup.analysis.analysisVersion,
    });
  });

  test("rejects malformed and mismatched audit identities", async () => {
    const setup = await createAutoAnswerAudit();
    const missingMessage = await postAutoAnswerLog({ caseId: setup.supportCase.id });
    const badVersion = await postAutoAnswerLog({
      caseId: setup.supportCase.id,
      caseMessageId: setup.audit.id,
      analysisVersion: 0,
    });
    const mismatchedSolution = await postAutoAnswerLog({
      caseId: setup.supportCase.id,
      caseMessageId: setup.audit.id,
      solutionId: "wrong-solution",
    });

    expect(missingMessage.status).toBe(400);
    expect(badVersion.status).toBe(400);
    expect(await badVersion.json()).toEqual({ error: "analysisVersion_must_be_a_positive_integer" });
    expect(mismatchedSolution.status).toBe(400);
    expect(await mismatchedSolution.json()).toEqual({ error: "solution_identity_mismatch" });
  });
});
