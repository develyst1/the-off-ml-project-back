import type { CaseStatus } from "../domain/types";
import { store } from "../repositories/in-memory-store";
import { aiCenterClient } from "./ai-center-client";
import { lineClient } from "./line-client";
import { teamsClient } from "./teams-client";

export const caseService = {
  async intakeLineMessage(input: {
    lineUserId: string;
    displayName?: string;
    text: string;
    externalMessageId?: string;
  }) {
    const customer = store.upsertCustomer({
      lineUserId: input.lineUserId,
      displayName: input.displayName,
    });

    const supportCase = store.createCase({
      customerId: customer.id,
      status: "analyzing",
    });

    const message = store.createMessage({
      caseId: supportCase.id,
      direction: "inbound_customer",
      channel: "line",
      originalText: input.text,
      externalMessageId: input.externalMessageId,
    });

    const analysis = await aiCenterClient.analyzeCustomerMessage({
      text: input.text,
      customerDisplayName: input.displayName,
    });

    store.createAnalysis({
      caseId: supportCase.id,
      messageId: message.id,
      analysisType: "customer_message",
      summary: analysis.summary,
      category: analysis.category,
      confidence: analysis.confidence,
      rawJson: analysis,
    });

    store.updateCase(supportCase.id, {
      status: "awaiting_tech",
      category: analysis.category,
      priority: analysis.urgency,
      confidenceScore: analysis.confidence,
    });

    const detail = store.getCaseDetail(supportCase.id);
    if (!detail) {
      throw new Error("Case detail missing after intake");
    }

    await teamsClient.notifyCase(detail);
    return store.getCaseDetail(supportCase.id);
  },

  async receiveTeamsReply(input: {
    caseId: string;
    text: string;
    externalMessageId?: string;
  }) {
    const detail = store.getCaseDetail(input.caseId);
    if (!detail) {
      throw new Error("Case not found");
    }

    store.updateCase(input.caseId, { status: "tech_replied" });

    const message = store.createMessage({
      caseId: input.caseId,
      direction: "inbound_tech",
      channel: "ms_teams",
      originalText: input.text,
      externalMessageId: input.externalMessageId,
    });

    store.updateCase(input.caseId, { status: "analyzing_solution" });

    const originalCustomerText = detail.messages.find((item) => item.direction === "inbound_customer")?.originalText;
    const solutionAnalysis = await aiCenterClient.analyzeTechSolution({
      techReplyText: input.text,
      originalCustomerText,
    });

    store.createAnalysis({
      caseId: input.caseId,
      messageId: message.id,
      analysisType: "tech_solution",
      summary: solutionAnalysis.solutionSteps.join("\n"),
      category: solutionAnalysis.category,
      confidence: solutionAnalysis.confidence,
      rawJson: solutionAnalysis,
    });

    store.createSolution({
      caseId: input.caseId,
      rawReplyText: input.text,
      rootCause: solutionAnalysis.rootCause,
      solutionSteps: solutionAnalysis.solutionSteps,
      rewrittenCustomerText: solutionAnalysis.rewrittenCustomerText,
      confidence: solutionAnalysis.confidence,
      validatedByTeam: true,
    });

    store.updateCase(input.caseId, {
      status: "resolved",
      category: solutionAnalysis.category ?? detail.category,
    });

    const updatedDetail = store.getCaseDetail(input.caseId);
    if (!updatedDetail) {
      throw new Error("Case detail missing after Teams reply");
    }

    await lineClient.reply({
      lineUserId: updatedDetail.customer.lineUserId,
      text: solutionAnalysis.rewrittenCustomerText,
    });

    store.createMessage({
      caseId: input.caseId,
      direction: "outbound_customer",
      channel: "line",
      originalText: solutionAnalysis.rewrittenCustomerText,
    });

    store.updateCase(input.caseId, { status: "sent_to_customer" });
    return store.getCaseDetail(input.caseId);
  },

  listCases() {
    return store.listCases();
  },

  getCase(caseId: string) {
    return store.getCaseDetail(caseId);
  },

  updateStatus(caseId: string, status: CaseStatus) {
    return store.updateCase(caseId, { status });
  },
};
