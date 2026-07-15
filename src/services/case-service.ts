import type { CaseStatus, MessageChannel } from "../domain/types";
import { store } from "../repositories/store";
import { aiCenterClient } from "./ai-center-client";
import { lineClient } from "./line-client";
import { teamsClient } from "./teams-client";

export const caseService = {
  async getActiveLineCase(customer: { id: string; activeCaseId?: string }) {
    const activeStatuses = ["analyzing", "awaiting_tech", "assigned", "tech_replied", "analyzing_solution", "awaiting_customer_info", "awaiting_confirmation"];
    if (customer.activeCaseId) {
      const activeCase = await store.getCaseDetail(customer.activeCaseId);
      if (activeCase && activeCase.customerId === customer.id && activeStatuses.includes(activeCase.status)) {
        return activeCase;
      }
    }

    return (await store.listCases())
      .filter((item) => item.customerId === customer.id && activeStatuses.includes(item.status))
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())[0];
  },

  async requestCaseSplitConfirmation(input: { caseId: string; text: string; relation: { confidence: number; reason: string }; externalMessageId?: string }) {
    const detail = await store.getCaseDetail(input.caseId);
    if (!detail) throw new Error("Case not found");

    const message = await store.createMessage({
      caseId: input.caseId,
      direction: "inbound_customer",
      channel: "line",
      originalText: input.text,
      externalMessageId: input.externalMessageId,
    });
    await store.createAnalysis({
      caseId: input.caseId,
      messageId: message.id,
      analysisType: "case_match",
      summary: input.relation.reason,
      category: detail.category,
      confidence: input.relation.confidence,
      rawJson: { decision: "needs_confirmation", ...input.relation },
    });
    await store.updateCase(input.caseId, { status: "awaiting_confirmation" });
    return store.getCaseDetail(input.caseId);
  },

  async findRelatedLineCase(input: { customerId: string; newText: string; receivedAt?: string }) {
    const cases = (await store.listCases())
      .filter((item) => item.customer.id === input.customerId && ["analyzing", "awaiting_tech", "assigned", "tech_replied", "analyzing_solution", "awaiting_customer_info", "awaiting_confirmation"].includes(item.status))
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
    const candidate = cases[0];
    if (!candidate) return undefined;

    const customerMessages = candidate.messages.filter((message) => message.direction === "inbound_customer");
    const originalCustomerText = customerMessages[0]?.originalText;
    if (!originalCustomerText) return undefined;

    const latestActivity = candidate.messages.reduce((latest, message) => {
      return Math.max(latest, new Date(message.createdAt).getTime());
    }, new Date(candidate.updatedAt).getTime());
    const receivedAt = input.receivedAt ? new Date(input.receivedAt).getTime() : Date.now();
    const elapsedHours = Math.max(0, (receivedAt - latestActivity) / (1000 * 60 * 60));
    const relation = await aiCenterClient.analyzeCaseRelation({
      originalCustomerText,
      caseCategory: candidate.category,
      recentConversation: candidate.messages.slice(-6).map((message) => `${message.direction}: ${message.originalText}`),
      newCustomerText: input.newText,
      elapsedHours,
      caseStatus: candidate.status,
    });

    console.log({
      event: "line_case_relation_decision",
      caseId: candidate.id,
      elapsedHours: Number(elapsedHours.toFixed(2)),
      related: relation.related,
      confidence: relation.confidence,
      reason: relation.reason,
    });

    return relation.related ? candidate : undefined;
  },

  async appendLineMessageToCase(input: { caseId: string; text: string; externalMessageId?: string }) {
    const detail = await store.getCaseDetail(input.caseId);
    if (!detail) throw new Error("Case not found");

    const message = await store.createMessage({
      caseId: input.caseId,
      direction: "inbound_customer",
      channel: "line",
      originalText: input.text,
      externalMessageId: input.externalMessageId,
    });
    const analysis = await aiCenterClient.analyzeCustomerMessage({
      text: input.text,
      customerDisplayName: detail.customer.displayName,
      conversationContext: detail.messages.slice(-8).map((message) => `${message.direction}: ${message.originalText}`),
    });

    await store.createAnalysis({
      caseId: input.caseId,
      messageId: message.id,
      analysisType: "customer_message",
      summary: analysis.summary,
      category: analysis.category,
      confidence: analysis.confidence,
      rawJson: analysis,
    });
    await store.updateCase(input.caseId, {
      status: "awaiting_tech",
      category: detail.category ?? analysis.category,
      priority: analysis.urgency,
      confidenceScore: analysis.confidence,
    });

    const updatedDetail = await store.getCaseDetail(input.caseId);
    if (!updatedDetail) throw new Error("Case detail missing after appending LINE message");

    try {
      await teamsClient.notifyCase(updatedDetail);
      await store.updateCase(input.caseId, {
        teamsDeliveryStatus: "accepted",
        teamsDeliveryAt: new Date().toISOString(),
        teamsDeliveryError: undefined,
      });
    } catch (error) {
      await store.updateCase(input.caseId, {
        teamsDeliveryStatus: "failed",
        teamsDeliveryAt: new Date().toISOString(),
        teamsDeliveryError: error instanceof Error ? error.message : String(error),
      });
      console.error({ event: "teams_related_case_delivery_failed", caseId: input.caseId, error: String(error) });
    }

    return store.getCaseDetail(input.caseId);
  },

  async acceptCase(caseId: string) {
    const detail = await store.getCaseDetail(caseId);
    if (!detail) throw new Error("Case not found");
    return store.updateCase(caseId, { status: "assigned" });
  },

  async requestAdditionalInfo(caseId: string, text: string) {
    const detail = await store.getCaseDetail(caseId);
    if (!detail) throw new Error("Case not found");

    await lineClient.reply({
      lineUserId: detail.customer.lineUserId,
      text,
    });

    await store.createMessage({
      caseId,
      direction: "outbound_customer",
      channel: "line",
      originalText: text,
    });

    await store.updateCase(caseId, { status: "awaiting_customer_info" });
    return store.getCaseDetail(caseId);
  },

  async notifyTeams(caseId: string) {
    const detail = await store.getCaseDetail(caseId);
    if (!detail) {
      throw new Error("Case not found");
    }

    try {
      const result = await teamsClient.notifyCase(detail);
      await store.updateCase(caseId, {
        teamsDeliveryStatus: "accepted",
        teamsDeliveryAt: new Date().toISOString(),
        teamsDeliveryError: undefined,
      });
      return { ...result, case: await store.getCaseDetail(caseId) };
    } catch (error) {
      await store.updateCase(caseId, {
        teamsDeliveryStatus: "failed",
        teamsDeliveryAt: new Date().toISOString(),
        teamsDeliveryError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },

  async intakeLineMessage(input: {
    lineUserId: string;
    displayName?: string;
    text: string;
    externalMessageId?: string;
  }) {
    const customer = await store.upsertCustomer({
      lineUserId: input.lineUserId,
      displayName: input.displayName,
    });

    const supportCase = await store.createCase({
      customerId: customer.id,
      status: "analyzing",
    });

    const message = await store.createMessage({
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

    await store.createAnalysis({
      caseId: supportCase.id,
      messageId: message.id,
      analysisType: "customer_message",
      summary: analysis.summary,
      category: analysis.category,
      confidence: analysis.confidence,
      rawJson: analysis,
    });

    await store.updateCase(supportCase.id, {
      status: "awaiting_tech",
      category: analysis.category,
      priority: analysis.urgency,
      confidenceScore: analysis.confidence,
    });

    const detail = await store.getCaseDetail(supportCase.id);
    if (!detail) {
      throw new Error("Case detail missing after intake");
    }

    try {
      await teamsClient.notifyCase(detail);
      await store.updateCase(supportCase.id, {
        teamsDeliveryStatus: "accepted",
        teamsDeliveryAt: new Date().toISOString(),
        teamsDeliveryError: undefined,
      });
    } catch (error) {
      await store.updateCase(supportCase.id, {
        teamsDeliveryStatus: "failed",
        teamsDeliveryAt: new Date().toISOString(),
        teamsDeliveryError: error instanceof Error ? error.message : String(error),
      });
      console.error({ event: "teams_case_delivery_failed", caseId: supportCase.id, error: String(error) });
    }
    return store.getCaseDetail(supportCase.id);
  },

  async receiveTeamsReply(input: {
    caseId: string;
    text: string;
    externalMessageId?: string;
    channel?: MessageChannel;
  }) {
    if (input.externalMessageId) {
      const existingMessage = await store.getMessageByExternalMessageId(input.externalMessageId);
      if (existingMessage) {
        return store.getCaseDetail(existingMessage.caseId);
      }
    }

    const detail = await store.getCaseDetail(input.caseId);
    if (!detail) {
      throw new Error("Case not found");
    }

    await store.updateCase(input.caseId, { status: "tech_replied" });

    const message = await store.createMessage({
      caseId: input.caseId,
      direction: "inbound_tech",
      channel: input.channel ?? "ms_teams",
      originalText: input.text,
      externalMessageId: input.externalMessageId,
    });

    await store.updateCase(input.caseId, { status: "analyzing_solution" });

    const originalCustomerText = detail.messages.find((item) => item.direction === "inbound_customer")?.originalText;
    const solutionAnalysis = await aiCenterClient.analyzeTechSolution({
      techReplyText: input.text,
      originalCustomerText,
    });

    await store.createAnalysis({
      caseId: input.caseId,
      messageId: message.id,
      analysisType: "tech_solution",
      summary: solutionAnalysis.solutionSteps.join("\n"),
      category: solutionAnalysis.category,
      confidence: solutionAnalysis.confidence,
      rawJson: solutionAnalysis,
    });

    await store.createSolution({
      caseId: input.caseId,
      rawReplyText: input.text,
      rootCause: solutionAnalysis.rootCause,
      solutionSteps: solutionAnalysis.solutionSteps,
      rewrittenCustomerText: solutionAnalysis.rewrittenCustomerText,
      confidence: solutionAnalysis.confidence,
      validatedByTeam: true,
    });

    await store.updateCase(input.caseId, {
      status: "resolved",
      category: solutionAnalysis.category ?? detail.category,
    });

    const updatedDetail = await store.getCaseDetail(input.caseId);
    if (!updatedDetail) {
      throw new Error("Case detail missing after Teams reply");
    }

    await lineClient.reply({
      lineUserId: updatedDetail.customer.lineUserId,
      text: solutionAnalysis.rewrittenCustomerText,
    });

    await store.createMessage({
      caseId: input.caseId,
      direction: "outbound_customer",
      channel: "line",
      originalText: solutionAnalysis.rewrittenCustomerText,
    });

    await store.updateCase(input.caseId, { status: "sent_to_customer" });
    await store.setActiveCase(updatedDetail.customer.id);
    return store.getCaseDetail(input.caseId);
  },

  listCases() {
    return store.listCases();
  },

  getCase(caseId: string) {
    return store.getCaseDetail(caseId);
  },

  async getCaseByNumber(caseNumber: number) {
    const cases = await store.listCases();
    return cases.find((item) => item.caseNumber === caseNumber);
  },

  updateStatus(caseId: string, status: CaseStatus) {
    return store.updateCase(caseId, { status });
  },
};
