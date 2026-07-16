export type CaseStatus =
  | "new"
  | "analyzing"
  | "awaiting_tech"
  | "assigned"
  | "tech_replied"
  | "analyzing_solution"
  | "resolved"
  | "sent_to_customer"
  | "closed"
  | "reopened"
  | "in_progress"
  | "awaiting_customer_info"
  | "awaiting_confirmation";

export type MessageDirection =
  | "inbound_customer"
  | "outbound_customer"
  | "inbound_tech"
  | "outbound_tech";

export type MessageChannel = "line" | "ms_teams" | "system";

export type Customer = {
  id: string;
  lineUserId: string;
  displayName?: string;
  activeCaseId?: string;
  pendingCaseSelection?: PendingCaseSelection;
  conversationState?: ConversationState;
  createdAt: string;
  updatedAt: string;
};

export type PendingCaseSelection = {
  mode: "choose" | "confirm";
  candidateCaseIds: string[];
  selectedCaseId?: string;
  createdAt: string;
};

export type ConversationState =
  | "IDLE"
  | "WAITING_NEW_CASE_CONFIRMATION"
  | "WAITING_NEW_CASE_DETAIL"
  | "WAITING_CASE_SELECTION"
  | "WAITING_REOPEN_CONFIRMATION"
  | "ACTIVE_CASE_CONVERSATION";

export type SupportCase = {
  id: string;
  caseNumber: string;
  sequenceNumber: number;
  sequenceYear: number;
  customerId: string;
  title?: string;
  aiStatus?: "AI_SUCCESS" | "AI_LOW_CONFIDENCE" | "AI_FAILED";
  dataStatus?: "COMPLETE" | "DATA_INCOMPLETE";
  customerSentAt?: string;
  systemReceivedAt?: string;
  aiAnalyzedAt?: string;
  teamsSentAt?: string;
  techRepliedAt?: string;
  lineSentAt?: string;
  lineDeliveredAt?: string;
  teamsDeliveryStatus?: "not_sent" | "accepted" | "failed";
  teamsDeliveryAt?: string;
  teamsDeliveryError?: string;
  status: CaseStatus;
  category?: string;
  priority?: "low" | "medium" | "high" | "critical";
  confidenceScore?: number;
  teamsThreadId?: string;
  createdAt: string;
  updatedAt: string;
};

export type Message = {
  id: string;
  caseId: string;
  direction: MessageDirection;
  channel: MessageChannel;
  originalText: string;
  senderType?: "CUSTOMER" | "BOT" | "TECH" | "SYSTEM";
  messageType?: "text" | "system";
  deliveryStatus?: "pending" | "sent" | "delivered" | "failed";
  externalMessageId?: string;
  webhookEventId?: string;
  normalizedText?: string;
  receivedAt?: string;
  createdAt: string;
};

export type Analysis = {
  id: string;
  caseId: string;
  messageId: string;
  analysisType: "customer_message" | "tech_solution" | "customer_rewrite" | "case_match";
  summary?: string;
  category?: string;
  confidence: number;
  rawJson: unknown;
  createdAt: string;
};

export type Solution = {
  id: string;
  caseId: string;
  rawReplyText: string;
  rootCause?: string;
  solutionSteps: string[];
  rewrittenCustomerText: string;
  confidence: number;
  validatedByTeam: boolean;
  createdAt: string;
};

export type CaseDetail = SupportCase & {
  customer: Customer;
  messages: Message[];
  analyses: Analysis[];
  solutions: Solution[];
};
