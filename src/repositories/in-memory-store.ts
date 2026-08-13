import type { AiReviewFeedback, Analysis, AutomationSettings, CaseAiFeedback, CaseDetail, CaseMatchLog, CaseStatus, ConversationState, Customer, InboxMessage, InboxUser, Message, PendingCaseSelection, Solution, SupportCase } from "../domain/types";
import { toAiReviewFeedbackMemoryItem } from "../lib/ai-review-feedback-memory";
import { createId, nowIso } from "../lib/ids";
import type { CaseStore, ChatRetentionCleanupResult } from "./case-store";
import { dedupeCaseMessages, normalizeCaseMessage } from "./case-message-normalizer";

export class InMemoryStore implements CaseStore {
  private customers = new Map<string, Customer>();
  private customersByLineUserId = new Map<string, string>();
  private cases = new Map<string, SupportCase>();
  private nextCaseNumbers = new Map<number, number>();
  private messages = new Map<string, Message>();
  private inboxMessages = new Map<string, InboxMessage>();
  private analyses = new Map<string, Analysis>();
  private aiReviewFeedback = new Map<string, AiReviewFeedback>();
  private caseAiFeedback = new Map<string, CaseAiFeedback>();
  private solutions = new Map<string, Solution>();
  private caseMatchLogs = new Map<string, CaseMatchLog>();
  private automationSettings: AutomationSettings = {
    enabled: false,
    caseUnderstandingThreshold: 98,
    caseDiscriminationThreshold: 98,
    updatedAt: nowIso(),
  };

  private retainedInboxMessages(customerId: string) {
    const cutoffAt = Date.now() - 14 * 24 * 60 * 60 * 1000;
    return [...this.inboxMessages.values()]
      .filter((message) => message.customerId === customerId && new Date(message.createdAt).getTime() >= cutoffAt)
      .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
  }

  async upsertCustomer(input: { lineUserId: string; displayName?: string }): Promise<Customer> {
    const existingId = this.customersByLineUserId.get(input.lineUserId);
    const timestamp = nowIso();

    if (existingId) {
      const existing = this.customers.get(existingId);
      if (!existing) {
        throw new Error("Customer index is inconsistent");
      }

      const updated = {
        ...existing,
        displayName: input.displayName ?? existing.displayName,
        updatedAt: timestamp,
      };
      this.customers.set(updated.id, updated);
      return updated;
    }

    const customer: Customer = {
      id: createId("cus"),
      lineUserId: input.lineUserId,
      displayName: input.displayName,
      activeCaseId: undefined,
      conversationState: "IDLE",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.customers.set(customer.id, customer);
    this.customersByLineUserId.set(customer.lineUserId, customer.id);
    return customer;
  }

  async setActiveCase(customerId: string, caseId?: string): Promise<Customer> {
    const customer = this.customers.get(customerId);
    if (!customer) throw new Error("Customer not found");
    const updated = { ...customer, activeCaseId: caseId, updatedAt: nowIso() };
    this.customers.set(customerId, updated);
    return updated;
  }

  async setPendingCaseSelection(customerId: string, selection?: PendingCaseSelection): Promise<Customer> {
    const customer = this.customers.get(customerId);
    if (!customer) throw new Error("Customer not found");
    const updated = { ...customer, pendingCaseSelection: selection, updatedAt: nowIso() };
    this.customers.set(customerId, updated);
    return updated;
  }

  async setConversationState(customerId: string, state: ConversationState): Promise<Customer> {
    const customer = this.customers.get(customerId);
    if (!customer) throw new Error("Customer not found");
    const updated = { ...customer, conversationState: state, updatedAt: nowIso() };
    this.customers.set(customerId, updated);
    return updated;
  }

  async markInboxRead(customerId: string, readAt = nowIso()): Promise<Customer> {
    const customer = this.customers.get(customerId);
    if (!customer) throw new Error("Customer not found");
    const updated = { ...customer, inboxLastReadAt: readAt, updatedAt: nowIso() };
    this.customers.set(customerId, updated);
    return updated;
  }

  async createInboxMessage(input: Omit<InboxMessage, "id" | "createdAt"> & { createdAt?: string }): Promise<InboxMessage> {
    const message: InboxMessage = { ...input, id: createId("inbox"), createdAt: input.createdAt ?? nowIso() };
    this.inboxMessages.set(message.id, message);
    return message;
  }

  async assignInboxMessageToCase(messageId: string, input: { caseId: string; assignedBy: string; assignedAt?: string }): Promise<InboxMessage> {
    const message = this.inboxMessages.get(messageId);
    if (!message) throw new Error("Inbox message not found");
    if (message.caseId && message.caseId !== input.caseId) throw new Error("Inbox message is already assigned to another case");
    const updated = { ...message, caseId: input.caseId, assignedCaseId: input.caseId, assignedBy: input.assignedBy, assignedAt: input.assignedAt ?? nowIso() };
    this.inboxMessages.set(messageId, updated);
    return updated;
  }

  async assignInboxMessagesToCase(messageIds: string[], input: { caseId: string; assignedBy: string; assignedAt?: string; allowReassignment?: boolean }): Promise<InboxMessage[]> {
    const assignedAt = input.assignedAt ?? nowIso();
    const updated: InboxMessage[] = [];
    for (const messageId of messageIds) {
      const message = this.inboxMessages.get(messageId);
      if (!message) continue;
      if (message.caseId && !input.allowReassignment) continue;
      const next = { ...message, caseId: input.caseId, assignedCaseId: input.caseId, assignedBy: input.assignedBy, assignedAt };
      this.inboxMessages.set(messageId, next);
      updated.push(next);
    }
    return updated;
  }

  async getInboxMessageByExternalMessageId(externalMessageId: string): Promise<InboxMessage | undefined> {
    return [...this.inboxMessages.values()].find((message) => message.externalMessageId === externalMessageId);
  }

  async getInboxMessageByWebhookEventId(webhookEventId: string): Promise<InboxMessage | undefined> {
    return [...this.inboxMessages.values()].find((message) => message.webhookEventId === webhookEventId);
  }

  async getInboxUser(customerId: string): Promise<InboxUser | undefined> {
    const customer = this.customers.get(customerId);
    if (!customer) return undefined;
    const messages = this.retainedInboxMessages(customerId);
    const cases = await Promise.all([...this.cases.values()]
      .filter((supportCase) => supportCase.customerId === customerId)
      .map((supportCase) => this.getCaseDetail(supportCase.id)));
    return {
      customer,
      latestMessage: messages.at(-1),
      messages,
      cases: cases.filter((item): item is CaseDetail => Boolean(item)),
    };
  }

  async listInboxUsers(): Promise<InboxUser[]> {
    const customerIds = new Set([...this.inboxMessages.values()]
      .filter((message) => new Date(message.createdAt).getTime() >= Date.now() - 14 * 24 * 60 * 60 * 1000)
      .map((message) => message.customerId));
    const users = await Promise.all([...customerIds].map((customerId) => this.getInboxUser(customerId)));
    return users
      .filter((item): item is InboxUser => Boolean(item))
      .sort((left, right) => new Date(right.latestMessage?.createdAt ?? 0).getTime() - new Date(left.latestMessage?.createdAt ?? 0).getTime());
  }

  async deleteExpiredRawMessages(input: { cutoffAt: Date; batchSize: number; dryRun: boolean }): Promise<ChatRetentionCleanupResult> {
    const startedAt = Date.now();
    const isExpired = (createdAt: string) => new Date(createdAt).getTime() < input.cutoffAt.getTime();
    const isRawCaseMessage = (message: Message) => message.senderType !== "SYSTEM" || message.contentType !== "SYSTEM_EVENT";
    const inboxIds = [...this.inboxMessages.values()].filter((message) => isExpired(message.createdAt)).map((message) => message.id);
    const caseMessageIds = [...this.messages.values()]
      .filter((message) => isExpired(message.createdAt) && isRawCaseMessage(message))
      .map((message) => message.id);

    if (!input.dryRun) {
      for (const ids of [inboxIds, caseMessageIds]) {
        for (let offset = 0; offset < ids.length; offset += input.batchSize) {
          for (const id of ids.slice(offset, offset + input.batchSize)) {
            this.inboxMessages.delete(id);
            this.messages.delete(id);
          }
        }
      }
    }

    const deletedInboxMessages = inboxIds.length;
    const deletedCaseMessages = caseMessageIds.length;
    return {
      cutoffAt: input.cutoffAt.toISOString(),
      dryRun: input.dryRun,
      batchSize: input.batchSize,
      deletedInboxMessages,
      deletedCaseMessages,
      deletedLegacyMessages: 0,
      totalDeleted: deletedInboxMessages + deletedCaseMessages,
      durationMs: Date.now() - startedAt,
    };
  }

  async createCase(input: { customerId: string; status?: CaseStatus; title?: string; category?: string; confidenceScore?: number; conversationStartedAt?: string }): Promise<SupportCase> {
    const timestamp = nowIso();
    const sequenceYear = new Date().getUTCFullYear();
    const sequenceNumber = this.nextCaseNumbers.get(sequenceYear) ?? 1;
    this.nextCaseNumbers.set(sequenceYear, sequenceNumber + 1);
    const supportCase: SupportCase = {
      id: createId("case"),
      caseNumber: `OFF-${sequenceYear}-${String(sequenceNumber).padStart(5, "0")}`,
      sequenceNumber,
      sequenceYear,
      customerId: input.customerId,
      title: input.title,
      status: input.status ?? "new",
      category: input.category,
      confidenceScore: input.confidenceScore,
      conversationStartedAt: input.conversationStartedAt ?? timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.cases.set(supportCase.id, supportCase);
    return supportCase;
  }

  async updateCase(id: string, patch: Partial<Omit<SupportCase, "id" | "customerId" | "createdAt">>): Promise<SupportCase> {
    const current = this.cases.get(id);

    if (!current) {
      throw new Error("Case not found");
    }

    const updated = {
      ...current,
      ...patch,
      updatedAt: nowIso(),
    };

    this.cases.set(id, updated);
    return updated;
  }

  async createMessage(input: Omit<Message, "id" | "createdAt">): Promise<Message> {
    const message: Message = {
      ...normalizeCaseMessage(input),
      id: createId("msg"),
      createdAt: nowIso(),
    };

    this.messages.set(message.id, message);
    return message;
  }

  async updateMessage(id: string, patch: Partial<Pick<Message, "direction" | "messageType" | "senderType" | "deliveryStatus" | "deliveryError" | "sentAt" | "deliveredAt" | "failedAt" | "metadata">>): Promise<Message> {
    const current = this.messages.get(id);
    if (!current) throw new Error("Message not found");
    const updated = { ...current, ...patch, metadata: patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata };
    this.messages.set(id, updated);
    return updated;
  }

  async getMessageByExternalMessageId(externalMessageId: string): Promise<Message | undefined> {
    return [...this.messages.values()].find((message) => message.externalMessageId === externalMessageId);
  }

  async getMessageByWebhookEventId(webhookEventId: string): Promise<Message | undefined> {
    return [...this.messages.values()].find((message) => message.webhookEventId === webhookEventId);
  }

  async createAnalysis(input: Omit<Analysis, "id" | "analysisId" | "createdAt" | "analysisVersion">): Promise<Analysis> {
    const latestVersion = [...this.analyses.values()]
      .filter((analysis) => analysis.caseId === input.caseId)
      .reduce((maximum, analysis) => Math.max(maximum, analysis.analysisVersion), 0);
    const id = createId("ana");
    const analysis: Analysis = {
      ...input,
      id,
      analysisId: id,
      analysisVersion: latestVersion + 1,
      createdAt: nowIso(),
    };

    this.analyses.set(analysis.id, analysis);
    return analysis;
  }

  async upsertAiReviewFeedback(input: Omit<AiReviewFeedback, "id" | "createdAt" | "updatedAt">): Promise<AiReviewFeedback> {
    const existing = [...this.aiReviewFeedback.values()].find((item) => (
      item.caseId === input.caseId
      && item.analysisVersion === input.analysisVersion
      && item.feedbackType === input.feedbackType
    ));
    const timestamp = nowIso();
    const feedback: AiReviewFeedback = existing
      ? { ...existing, ...input, updatedAt: timestamp }
      : { ...input, id: createId("review"), createdAt: timestamp, updatedAt: timestamp };
    this.aiReviewFeedback.set(feedback.id, feedback);
    return feedback;
  }

  async listAiReviewFeedback(): Promise<AiReviewFeedback[]> {
    return [...this.aiReviewFeedback.values()]
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  }

  async listAiReviewFeedbackForReliability(options: { excludeCaseId?: string } = {}): Promise<AiReviewFeedback[]> {
    return [...this.aiReviewFeedback.values()]
      .filter((feedback) => !options.excludeCaseId || feedback.caseId !== options.excludeCaseId)
      .filter((feedback) => feedback.reviewSource === "CONFIDENCE_REVIEW")
      .filter((feedback) => Boolean(feedback.analysisId))
      .filter((feedback) => [...this.analyses.values()].some((analysis) => (
        analysis.caseId === feedback.caseId
        && analysis.analysisId === feedback.analysisId
        && analysis.analysisVersion === feedback.analysisVersion
        && analysis.analysisType === "customer_message"
      )))
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  }

  async listAiReviewFeedbackForMemory(options: { feedbackType?: AiReviewFeedback["feedbackType"]; result?: AiReviewFeedback["result"]; limit: number }) {
    const items = [...this.aiReviewFeedback.values()]
      .filter((feedback) => !options.feedbackType || feedback.feedbackType === options.feedbackType)
      .filter((feedback) => !options.result || feedback.result === options.result)
      .map((feedback) => {
        const matches = [...this.analyses.values()].filter((analysis) => (
          analysis.caseId === feedback.caseId
          && analysis.analysisVersion === feedback.analysisVersion
          && (!feedback.analysisId || analysis.analysisId === feedback.analysisId)
        ));
        return matches.length === 1 ? toAiReviewFeedbackMemoryItem(feedback, matches[0]) : undefined;
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
    return items.slice(0, Math.max(0, options.limit));
  }

  async upsertCaseAiFeedback(input: Omit<CaseAiFeedback, "id" | "createdAt" | "updatedAt">): Promise<CaseAiFeedback> {
    const existing = [...this.caseAiFeedback.values()].find((item) => item.caseId === input.caseId && item.feedbackType === input.feedbackType);
    const timestamp = nowIso();
    const feedback: CaseAiFeedback = existing
      ? { ...existing, ...input, updatedAt: timestamp }
      : { ...input, id: createId("feedback"), createdAt: timestamp, updatedAt: timestamp };
    this.caseAiFeedback.set(feedback.id, feedback);
    return feedback;
  }

  async deleteCaseAiFeedback(caseId: string, feedbackType: CaseAiFeedback["feedbackType"]): Promise<void> {
    const existing = [...this.caseAiFeedback.values()].find((item) => item.caseId === caseId && item.feedbackType === feedbackType);
    if (existing) this.caseAiFeedback.delete(existing.id);
  }

  async listCaseAiFeedback(): Promise<CaseAiFeedback[]> {
    return [...this.caseAiFeedback.values()].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  }

  async createSolution(input: Omit<Solution, "id" | "createdAt">): Promise<Solution> {
    const solution: Solution = {
      ...input,
      id: createId("sol"),
      createdAt: nowIso(),
    };

    this.solutions.set(solution.id, solution);
    return solution;
  }

  async updateSolution(id: string, patch: Partial<Pick<Solution, "confidence" | "validatedByTeam" | "validatedAt" | "validatedBy" | "autoAnswerReviewResult" | "autoAnswerReviewedAt" | "autoAnswerReviewedBy">>): Promise<Solution> {
    const current = this.solutions.get(id);
    if (!current) throw new Error("Solution not found");
    const updated = { ...current, ...patch };
    this.solutions.set(id, updated);
    return updated;
  }

  async getAutomationSettings(): Promise<AutomationSettings> {
    return this.automationSettings;
  }

  async updateAutomationSettings(patch: Partial<Pick<AutomationSettings, "enabled" | "caseUnderstandingThreshold" | "caseDiscriminationThreshold" | "emergencyDisabledAt">>): Promise<AutomationSettings> {
    this.automationSettings = { ...this.automationSettings, ...patch, updatedAt: nowIso() };
    return this.automationSettings;
  }

  async createCaseMatchLog(input: Omit<CaseMatchLog, "id" | "createdAt">): Promise<CaseMatchLog> {
    const log: CaseMatchLog = { ...input, id: createId("match"), createdAt: nowIso() };
    this.caseMatchLogs.set(log.id, log);
    return log;
  }

  async updateCaseMatchLogDecision(id: string, finalUserDecision: NonNullable<CaseMatchLog["finalUserDecision"]>): Promise<CaseMatchLog> {
    const current = this.caseMatchLogs.get(id);
    if (!current) throw new Error("Case match log not found");
    const updated = { ...current, finalUserDecision };
    this.caseMatchLogs.set(id, updated);
    return updated;
  }

  async listCases(): Promise<CaseDetail[]> {
    const details = await Promise.all([...this.cases.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((supportCase) => this.getCaseDetail(supportCase.id)));

    return details.filter((detail): detail is CaseDetail => Boolean(detail));
  }

  async getCaseDetail(id: string): Promise<CaseDetail | undefined> {
    const supportCase = this.cases.get(id);
    if (!supportCase) return undefined;

    const customer = this.customers.get(supportCase.customerId);
    if (!customer) return undefined;

    const messages = dedupeCaseMessages([...this.messages.values()].filter((message) => message.caseId === id));
    const customerMessages = messages
      .filter((message) => message.senderType === "CUSTOMER" && (message.direction === "INBOUND" || message.direction === "inbound_customer"))
      .sort((left, right) => new Date(left.receivedAt ?? left.createdAt).getTime() - new Date(right.receivedAt ?? right.createdAt).getTime());
    const latestCustomerMessage = customerMessages.at(-1);
    const latestOutboundMessage = messages
      .filter((message) => message.senderType !== "CUSTOMER" && (message.direction === "OUTBOUND" || message.direction === "outbound_customer"))
      .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime())
      .at(-1);

    return {
      ...supportCase,
      customer,
      initialCustomerMessageId: supportCase.initialCustomerMessageId ?? customerMessages[0]?.id,
      latestCustomerMessageId: supportCase.latestCustomerMessageId ?? latestCustomerMessage?.id,
      hasUnreadCustomerMessage: Boolean(latestCustomerMessage && (!latestOutboundMessage || new Date(latestCustomerMessage.receivedAt ?? latestCustomerMessage.createdAt).getTime() > new Date(latestOutboundMessage.createdAt).getTime())),
      rawMessageTimelineExpired: messages.filter((message) => message.senderType !== "SYSTEM" || message.contentType !== "SYSTEM_EVENT").length === 0
        && new Date(supportCase.createdAt).getTime() < Date.now() - 14 * 24 * 60 * 60 * 1000,
      messages,
      analyses: [...this.analyses.values()].filter((analysis) => analysis.caseId === id),
      solutions: [...this.solutions.values()].filter((solution) => solution.caseId === id),
    };
  }
}
