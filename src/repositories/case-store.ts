import type { Analysis, CaseDetail, CaseStatus, ConversationState, Customer, Message, PendingCaseSelection, Solution, SupportCase } from "../domain/types";

export type CaseStore = {
  upsertCustomer(input: { lineUserId: string; displayName?: string }): Promise<Customer>;
  setActiveCase(customerId: string, caseId?: string): Promise<Customer>;
  setPendingCaseSelection(customerId: string, selection?: PendingCaseSelection): Promise<Customer>;
  setConversationState(customerId: string, state: ConversationState): Promise<Customer>;
  createCase(input: { customerId: string; status?: CaseStatus; title?: string; category?: string; confidenceScore?: number }): Promise<SupportCase>;
  updateCase(id: string, patch: Partial<Omit<SupportCase, "id" | "customerId" | "createdAt">>): Promise<SupportCase>;
  createMessage(input: Omit<Message, "id" | "createdAt">): Promise<Message>;
  updateMessage(id: string, patch: Partial<Pick<Message, "direction" | "messageType" | "senderType" | "deliveryStatus">>): Promise<Message>;
  getMessageByExternalMessageId(externalMessageId: string): Promise<Message | undefined>;
  getMessageByWebhookEventId(webhookEventId: string): Promise<Message | undefined>;
  createAnalysis(input: Omit<Analysis, "id" | "createdAt">): Promise<Analysis>;
  createSolution(input: Omit<Solution, "id" | "createdAt">): Promise<Solution>;
  listCases(): Promise<CaseDetail[]>;
  getCaseDetail(id: string): Promise<CaseDetail | undefined>;
};
