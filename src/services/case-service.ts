import type { CaseDetail, CaseStatus, MessageChannel, PendingCaseSelection } from "../domain/types";
import { store } from "../repositories/store";
import { aiCenterClient } from "./ai-center-client";
import { lineClient } from "./line-client";
import { teamsClient } from "./teams-client";

export const caseService = {
  formatCaseTitle(detail: { title?: string; category?: string; messages: { direction: string; originalText: string }[] }) {
    if (detail.title?.trim()) return detail.title.trim();
    const original = detail.messages.find((message) => message.direction === "inbound_customer")?.originalText ?? detail.category ?? "Tech Support";
    return original.trim().slice(0, 50);
  },

  async getCustomerCases(customerId: string) {
    return (await store.listCases())
      .filter((item) => item.customerId === customerId)
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  },

  async findReopenCandidates(customerId: string, text: string): Promise<CaseDetail[]> {
    const normalized = text.trim().toLowerCase();
    const terms = normalized
      .replace(/เปิดเคส|เคสที่|ของฉัน|ปัญหาเดิม|เรื่องที่แจ้ง|ยังไม่หาย|ขอเปิด|กลับมาตรวจสอบ/g, " ")
      .split(/\s+/)
      .filter((term) => term.length >= 2);
    const allCases = await this.getCustomerCases(customerId);
    const closedCases = allCases.filter((item) => ["closed", "sent_to_customer", "resolved"].includes(item.status));
    const cases = closedCases.length > 0 ? closedCases : allCases;
    const scored = cases.map((item) => {
      const searchable = [
        item.title,
        item.category,
        ...item.messages.map((message) => message.originalText),
        ...item.analyses.map((analysis) => analysis.summary),
      ].filter(Boolean).join(" ").toLowerCase();
      const matches = terms.filter((term) => searchable.includes(term)).length;
      const recency = Math.max(0, 10 - Math.floor((Date.now() - new Date(item.updatedAt).getTime()) / 86400000));
      return { item, score: matches * 100 + recency };
    });
    return scored
      .sort((left, right) => right.score - left.score)
      .slice(0, 3)
      .map(({ item }) => item);
  },

  selectionPrompt(cases: CaseDetail[]) {
    const rows = cases.map((item, index) => {
      const date = new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", year: "numeric" }).format(new Date(item.updatedAt));
      return `${index + 1}. ${caseService.formatCaseTitle(item)}\n   ปิด/อัปเดตเมื่อ ${date}`;
    });
    return `พบเคสที่ใกล้เคียงค่ะ ต้องการเปิดเรื่องไหนกลับมาตรวจสอบต่อคะ?\n\n${rows.join("\n\n")}\n\nพิมพ์เลข 1, 2 หรือ 3 ได้เลยค่ะ`;
  },

  confirmationPrompt(detail: CaseDetail) {
    const date = new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", year: "numeric" }).format(new Date(detail.createdAt));
    return `หมายถึงเคสนี้ใช่ไหมคะ?\n\n${detail.caseNumber}\nเรื่อง: ${caseService.formatCaseTitle(detail)}\nแจ้งเมื่อ: ${date}\n\nตอบ “ใช่” เพื่อเปิดเคสกลับมาตรวจสอบต่อ หรือพิมพ์ “ไม่ใช่” เพื่อเลือกเรื่องอื่นค่ะ`;
  },

  async setPendingCaseSelection(customerId: string, candidateCaseIds: string[], selectedCaseId?: string) {
    const selection: PendingCaseSelection = {
      mode: selectedCaseId ? "confirm" : "choose",
      candidateCaseIds,
      selectedCaseId,
      createdAt: new Date().toISOString(),
    };
    return store.setPendingCaseSelection(customerId, selection);
  },

  async reopenCase(customerId: string, caseId: string) {
    const detail = await store.getCaseDetail(caseId);
    if (!detail || detail.customerId !== customerId) throw new Error("Case not found");
    await store.updateCase(caseId, { status: "reopened" });
    await store.setPendingCaseSelection(customerId);
    await store.setActiveCase(customerId, caseId);
    const text = `เปิดเคส ${detail.caseNumber} กลับมาแล้วค่ะ เดี๋ยวทีมงานช่วยตรวจสอบต่อให้นะคะ`;
    const delivery = await lineClient.reply({ lineUserId: detail.customer.lineUserId, text });
    await store.createMessage({ caseId, direction: "outbound_customer", channel: "line", originalText: text, senderType: "BOT", deliveryStatus: delivery.delivered ? "delivered" : "pending" });
    return store.getCaseDetail(caseId);
  },
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
      senderType: "CUSTOMER",
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
      senderType: "CUSTOMER",
    });
    const analysis = await aiCenterClient.analyzeCustomerMessage({
      text: input.text,
      customerDisplayName: detail.customer.displayName,
      conversationContext: detail.messages.slice(-8).map((message) => `${message.direction}: ${message.originalText}`),
    });
    const continuationReply = await aiCenterClient.generateLineContinuationReply({
      originalCustomerText: detail.messages.find((message) => message.direction === "inbound_customer")?.originalText ?? input.text,
      recentConversation: detail.messages.slice(-8).map((message) => `${message.direction}: ${message.originalText}`),
      newCustomerText: input.text,
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
      title: detail.title ?? analysis.summary.slice(0, 50),
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

    return { detail: await store.getCaseDetail(input.caseId), continuationReply };
  },

  async acceptCase(caseId: string) {
    const detail = await store.getCaseDetail(caseId);
    if (!detail) throw new Error("Case not found");
    await store.updateCase(caseId, { status: "assigned" });
    return store.getCaseDetail(caseId);
  },

  async requestAdditionalInfo(caseId: string, text: string) {
    const detail = await store.getCaseDetail(caseId);
    if (!detail) throw new Error("Case not found");

    const messageText = `ขอข้อมูลเพิ่มเติมสำหรับเคส ${detail.caseNumber}\nเรื่อง: ${caseService.formatCaseTitle(detail)}\n\n${text}`;
    const delivery = await lineClient.reply({
      lineUserId: detail.customer.lineUserId,
      text: messageText,
    });

    await store.createMessage({
      caseId,
      direction: "outbound_customer",
      channel: "line",
      originalText: messageText,
      senderType: "TECH",
      deliveryStatus: delivery.delivered ? "delivered" : "pending",
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
      title: analysis.summary.slice(0, 50),
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
    closeAfterReply?: boolean;
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
      senderType: "TECH",
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
      title: detail.title ?? solutionAnalysis.category ?? undefined,
    });

    const updatedDetail = await store.getCaseDetail(input.caseId);
    if (!updatedDetail) {
      throw new Error("Case detail missing after Teams reply");
    }

    const lineText = input.closeAfterReply
      ? `ปิดเคส ${updatedDetail.caseNumber}\nเรื่อง: ${caseService.formatCaseTitle(updatedDetail)}\n\n${solutionAnalysis.rewrittenCustomerText}\n\nทีมงานดำเนินการในเรื่องนี้เรียบร้อยแล้ว จึงขอปิดเคสนี้นะคะ\nหากยังพบปัญหา สามารถตอบกลับพร้อมแจ้งหมายเลขเคส ${updatedDetail.caseNumber} ได้เลยค่ะ`
      : `อัปเดตเคส ${updatedDetail.caseNumber}\nเรื่อง: ${caseService.formatCaseTitle(updatedDetail)}\n\n${solutionAnalysis.rewrittenCustomerText}`;
    const delivery = await lineClient.reply({
      lineUserId: updatedDetail.customer.lineUserId,
      text: lineText,
    });

    await store.createMessage({
      caseId: input.caseId,
      direction: "outbound_customer",
      channel: "line",
      originalText: lineText,
      senderType: "TECH",
      deliveryStatus: delivery.delivered ? "delivered" : "pending",
    });

    await store.updateCase(input.caseId, { status: input.closeAfterReply ? "closed" : "sent_to_customer" });
    await store.setActiveCase(updatedDetail.customer.id, input.closeAfterReply ? undefined : input.caseId);
    return store.getCaseDetail(input.caseId);
  },

  listCases() {
    return store.listCases();
  },

  getCase(caseId: string) {
    return store.getCaseDetail(caseId);
  },

  async getCaseByNumber(caseNumber: string) {
    const cases = await store.listCases();
    return cases.find((item) => item.caseNumber.toUpperCase() === caseNumber.trim().toUpperCase());
  },

  updateStatus(caseId: string, status: CaseStatus) {
    return store.updateCase(caseId, { status });
  },
};
