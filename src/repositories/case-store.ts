import type { AiReviewFeedback, AiReviewFeedbackMemoryItem, Analysis, AutomationSettings, CaseAiFeedback, CaseDetail, CaseMatchLog, CaseStatus, ConversationState, Customer, InboxMessage, InboxUser, Message, PendingCaseSelection, Solution, SupportCase } from "../domain/types";

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

export type QualityReviewPersistenceInput = {
  caseId: string;
  feedback: Array<Omit<AiReviewFeedback, "id" | "createdAt" | "updatedAt">>;
  status: "QUALITY_APPROVED" | "QUALITY_REJECTED";
  reviewedAt: string;
  reviewedBy: string;
};

export type QualityReviewPersistenceResult = {
  feedback: AiReviewFeedback[];
  supportCase: SupportCase;
};

export type CaseStore = {
  upsertCustomer(input: { lineUserId: string; displayName?: string }): Promise<Customer>;
  setActiveCase(customerId: string, caseId?: string): Promise<Customer>;
  setPendingCaseSelection(customerId: string, selection?: PendingCaseSelection): Promise<Customer>;
  setConversationState(customerId: string, state: ConversationState): Promise<Customer>;
  markInboxRead(customerId: string, readAt?: string): Promise<Customer>;
  createInboxMessage(input: Omit<InboxMessage, "id" | "createdAt"> & { createdAt?: string }): Promise<InboxMessage>;
  assignInboxMessageToCase(messageId: string, input: { caseId: string; assignedBy: string; assignedAt?: string }): Promise<InboxMessage>;
  assignInboxMessagesToCase(messageIds: string[], input: { caseId: string; assignedBy: string; assignedAt?: string; allowReassignment?: boolean }): Promise<InboxMessage[]>;
  getInboxMessageByExternalMessageId(externalMessageId: string): Promise<InboxMessage | undefined>;
  getInboxMessageByWebhookEventId(webhookEventId: string): Promise<InboxMessage | undefined>;
  listInboxUsers(): Promise<InboxUser[]>;
  getInboxUser(customerId: string): Promise<InboxUser | undefined>;
  deleteExpiredRawMessages(input: { cutoffAt: Date; batchSize: number; dryRun: boolean }): Promise<ChatRetentionCleanupResult>;
  createCase(input: { customerId: string; status?: CaseStatus; title?: string; category?: string; confidenceScore?: number; conversationStartedAt?: string }): Promise<SupportCase>;
  updateCase(id: string, patch: Partial<Omit<SupportCase, "id" | "customerId" | "createdAt">>): Promise<SupportCase>;
  createMessage(input: Omit<Message, "id" | "createdAt">): Promise<Message>;
  updateMessage(id: string, patch: Partial<Pick<Message, "direction" | "messageType" | "senderType" | "deliveryStatus" | "deliveryError" | "sentAt" | "deliveredAt" | "failedAt" | "metadata">>): Promise<Message>;
  getMessageByExternalMessageId(externalMessageId: string): Promise<Message | undefined>;
  getMessageByWebhookEventId(webhookEventId: string): Promise<Message | undefined>;
  createAnalysis(input: Omit<Analysis, "id" | "analysisId" | "createdAt" | "analysisVersion">): Promise<Analysis>;
  upsertAiReviewFeedback(input: Omit<AiReviewFeedback, "id" | "createdAt" | "updatedAt">): Promise<AiReviewFeedback>;
  persistQualityReview(input: QualityReviewPersistenceInput): Promise<QualityReviewPersistenceResult>;
  listAiReviewFeedback(): Promise<AiReviewFeedback[]>;
  listAiReviewFeedbackForReliability(options?: { excludeCaseId?: string }): Promise<AiReviewFeedback[]>;
  listAiReviewFeedbackForMemory(options: { feedbackType?: AiReviewFeedback["feedbackType"]; result?: AiReviewFeedback["result"]; limit: number }): Promise<AiReviewFeedbackMemoryItem[]>;
  upsertCaseAiFeedback(input: Omit<CaseAiFeedback, "id" | "createdAt" | "updatedAt">): Promise<CaseAiFeedback>;
  deleteCaseAiFeedback(caseId: string, feedbackType: CaseAiFeedback["feedbackType"]): Promise<void>;
  listCaseAiFeedback(): Promise<CaseAiFeedback[]>;
  createSolution(input: Omit<Solution, "id" | "createdAt">): Promise<Solution>;
  updateSolution(id: string, patch: Partial<Pick<Solution, "confidence" | "validatedByTeam" | "validatedAt" | "validatedBy" | "autoAnswerReviewResult" | "autoAnswerReviewedAt" | "autoAnswerReviewedBy">>): Promise<Solution>;
  getAutomationSettings(): Promise<AutomationSettings>;
  updateAutomationSettings(patch: Partial<Pick<AutomationSettings, "enabled" | "caseUnderstandingThreshold" | "caseDiscriminationThreshold" | "emergencyDisabledAt">>): Promise<AutomationSettings>;
  createCaseMatchLog(input: Omit<CaseMatchLog, "id" | "createdAt">): Promise<CaseMatchLog>;
  updateCaseMatchLogDecision(id: string, finalUserDecision: NonNullable<CaseMatchLog["finalUserDecision"]>): Promise<CaseMatchLog>;
  listCases(): Promise<CaseDetail[]>;
  getCaseDetail(id: string): Promise<CaseDetail | undefined>;
};
