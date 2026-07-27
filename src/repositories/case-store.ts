import type { Analysis, AutomationSettings, CaseDetail, CaseMatchLog, CaseStatus, ConversationState, Customer, InboxMessage, InboxUser, Message, PendingCaseSelection, Solution, SupportCase } from "../domain/types";

export type ChatRetentionCleanupResult = {
  cutoffAt: string;
  dryRun: boolean;
  batchSize: number;
  deletedInboxMessages: number;
  deletedCaseMessages: number;
  deletedLegacyMessages: number;
  totalDeleted: number;
  durationMs: number;
};

export type CaseStore = {
  upsertCustomer(input: { lineUserId: string; displayName?: string }): Promise<Customer>;
  setActiveCase(customerId: string, caseId?: string): Promise<Customer>;
  setPendingCaseSelection(customerId: string, selection?: PendingCaseSelection): Promise<Customer>;
  setConversationState(customerId: string, state: ConversationState): Promise<Customer>;
  createInboxMessage(input: Omit<InboxMessage, "id" | "createdAt">): Promise<InboxMessage>;
  getInboxMessageByExternalMessageId(externalMessageId: string): Promise<InboxMessage | undefined>;
  getInboxMessageByWebhookEventId(webhookEventId: string): Promise<InboxMessage | undefined>;
  listInboxUsers(): Promise<InboxUser[]>;
  getInboxUser(customerId: string): Promise<InboxUser | undefined>;
  deleteExpiredRawMessages(input: { cutoffAt: Date; batchSize: number; dryRun: boolean }): Promise<ChatRetentionCleanupResult>;
  createCase(input: { customerId: string; status?: CaseStatus; title?: string; category?: string; confidenceScore?: number }): Promise<SupportCase>;
  updateCase(id: string, patch: Partial<Omit<SupportCase, "id" | "customerId" | "createdAt">>): Promise<SupportCase>;
  createMessage(input: Omit<Message, "id" | "createdAt">): Promise<Message>;
  updateMessage(id: string, patch: Partial<Pick<Message, "direction" | "messageType" | "senderType" | "deliveryStatus" | "deliveryError" | "sentAt" | "deliveredAt" | "failedAt">>): Promise<Message>;
  getMessageByExternalMessageId(externalMessageId: string): Promise<Message | undefined>;
  getMessageByWebhookEventId(webhookEventId: string): Promise<Message | undefined>;
  createAnalysis(input: Omit<Analysis, "id" | "createdAt">): Promise<Analysis>;
  createSolution(input: Omit<Solution, "id" | "createdAt">): Promise<Solution>;
  updateSolution(id: string, patch: Partial<Pick<Solution, "confidence" | "validatedByTeam" | "validatedAt" | "validatedBy" | "autoAnswerReviewResult" | "autoAnswerReviewedAt" | "autoAnswerReviewedBy">>): Promise<Solution>;
  getAutomationSettings(): Promise<AutomationSettings>;
  updateAutomationSettings(patch: Partial<Pick<AutomationSettings, "enabled" | "caseUnderstandingThreshold" | "caseDiscriminationThreshold" | "emergencyDisabledAt">>): Promise<AutomationSettings>;
  createCaseMatchLog(input: Omit<CaseMatchLog, "id" | "createdAt">): Promise<CaseMatchLog>;
  updateCaseMatchLogDecision(id: string, finalUserDecision: NonNullable<CaseMatchLog["finalUserDecision"]>): Promise<CaseMatchLog>;
  listCases(): Promise<CaseDetail[]>;
  getCaseDetail(id: string): Promise<CaseDetail | undefined>;
};
