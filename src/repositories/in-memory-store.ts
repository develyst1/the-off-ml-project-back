import type { Analysis, CaseDetail, CaseMatchLog, CaseStatus, ConversationState, Customer, Message, PendingCaseSelection, Solution, SupportCase } from "../domain/types";
import { createId, nowIso } from "../lib/ids";
import type { CaseStore } from "./case-store";
import { normalizeCaseMessage } from "./case-message-normalizer";

export class InMemoryStore implements CaseStore {
  private customers = new Map<string, Customer>();
  private customersByLineUserId = new Map<string, string>();
  private cases = new Map<string, SupportCase>();
  private nextCaseNumbers = new Map<number, number>();
  private messages = new Map<string, Message>();
  private analyses = new Map<string, Analysis>();
  private solutions = new Map<string, Solution>();
  private caseMatchLogs = new Map<string, CaseMatchLog>();

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

  async createCase(input: { customerId: string; status?: CaseStatus; title?: string; category?: string; confidenceScore?: number }): Promise<SupportCase> {
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

  async updateMessage(id: string, patch: Partial<Pick<Message, "direction" | "messageType" | "senderType" | "deliveryStatus" | "deliveryError" | "sentAt" | "deliveredAt" | "failedAt">>): Promise<Message> {
    const current = this.messages.get(id);
    if (!current) throw new Error("Message not found");
    const updated = { ...current, ...patch };
    this.messages.set(id, updated);
    return updated;
  }

  async getMessageByExternalMessageId(externalMessageId: string): Promise<Message | undefined> {
    return [...this.messages.values()].find((message) => message.externalMessageId === externalMessageId);
  }

  async getMessageByWebhookEventId(webhookEventId: string): Promise<Message | undefined> {
    return [...this.messages.values()].find((message) => message.webhookEventId === webhookEventId);
  }

  async createAnalysis(input: Omit<Analysis, "id" | "createdAt">): Promise<Analysis> {
    const analysis: Analysis = {
      ...input,
      id: createId("ana"),
      createdAt: nowIso(),
    };

    this.analyses.set(analysis.id, analysis);
    return analysis;
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

    return {
      ...supportCase,
      customer,
      messages: [...this.messages.values()].filter((message) => message.caseId === id),
      analyses: [...this.analyses.values()].filter((analysis) => analysis.caseId === id),
      solutions: [...this.solutions.values()].filter((solution) => solution.caseId === id),
    };
  }
}
