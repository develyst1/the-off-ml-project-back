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
  | "awaiting_confirmation"
  | "awaiting_tech_review";

export type MessageDirection =
  | "INBOUND"
  | "OUTBOUND"
  | "INTERNAL"
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
  mode: "choose" | "confirm" | "case_split_confirmation" | "case_history_match" | "request_more_info" | "context_only";
  candidateCaseIds: string[];
  selectedCaseId?: string;
  pendingText?: string;
  previousCaseStatus?: CaseStatus;
  externalMessageId?: string;
  webhookEventId?: string;
  receivedAt?: string;
  matchedCaseId?: string;
  matchConfidence?: number;
  matchReason?: string;
  matchLogId?: string;
  expiresAt?: string;
  pendingAction?: "REQUEST_MORE_INFO";
  pendingCaseId?: string;
  pendingQuestionType?: "AI_MISSING_INFORMATION" | "TECH_REQUEST";
  pendingRequestedFields?: string[];
  pendingCollectedFields?: Record<string, string>;
  pendingCreatedAt?: string;
  contextTopic?: string;
  contextMessages?: Array<{ sender: string; message: string; createdAt: string }>;
  createdAt: string;
};

export type CaseMatchLog = {
  id: string;
  customerId: string;
  incomingMessage: string;
  candidateCaseIds: string[];
  aiIntent: "CONTINUE_CASE" | "NEW_CASE" | "UNCERTAIN";
  matchedCaseId?: string;
  confidence: number;
  reason: string;
  finalUserDecision?: "continue_existing_case" | "create_new_case" | "auto_new_case" | "expired";
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
  closedAt?: string;
  closedBy?: string;
  teamsDeliveryStatus?: "not_sent" | "accepted" | "failed";
  teamsDeliveryAt?: string;
  teamsDeliveryError?: string;
  status: CaseStatus;
  category?: string;
  priority?: "low" | "medium" | "high" | "critical";
  confidenceScore?: number;
  teamsThreadId?: string;
  initialCustomerMessageId?: string;
  latestCustomerMessageId?: string;
  problemSummary?: string;
  problemSummaryGeneratedAt?: string;
  problemSummarySourceMessageId?: string;
  problemSummaryVersion?: number;
  problemSummaryStatus?: "PENDING" | "SUCCESS" | "FAILED";
  assigneeName?: string;
  hasUnreadCustomerMessage?: boolean;
  confidenceReviewStatus?: "PENDING" | "QUALITY_APPROVED" | "QUALITY_REJECTED" | "AUTO_ANSWER_APPROVED" | "AUTO_ANSWER_REJECTED";
  confidenceReviewedAt?: string;
  confidenceReviewedBy?: string;
  createdAt: string;
  updatedAt: string;
};

export type Message = {
  id: string;
  caseId: string;
  direction: MessageDirection;
  channel: MessageChannel;
  originalText: string;
  displayText?: string;
  senderType?: "CUSTOMER" | "BOT" | "AI" | "TECH" | "SYSTEM";
  contentType?: "TEXT" | "IMAGE" | "FILE" | "STICKER" | "LOCATION" | "SYSTEM_EVENT";
  messageType?:
    | "text"
    | "system"
    | "CUSTOMER_MESSAGE"
    | "CASE_ACKNOWLEDGEMENT"
    | "REQUEST_MORE_INFO"
    | "CUSTOMER_ADDITIONAL_INFO"
    | "TECH_RAW_REPLY"
    | "AI_REWRITTEN_REPLY"
    | "CUSTOMER_REPLY"
    | "CASE_FORWARDED"
    | "STATUS_UPDATE"
    | "TECH_REPLY"
    | "INTERNAL_NOTE"
    | "CUSTOMER_REWRITE"
    | "RESOLUTION"
    | "CASE_REOPENED"
    | "CASE_CLOSED"
    | "SYSTEM_EVENT";
  deliveryStatus?: "RECEIVED" | "PROCESSING" | "PROCESSED" | "PENDING" | "SENT" | "API_ACCEPTED" | "DELIVERED" | "FAILED" | "SKIPPED" | "pending" | "sent" | "delivered" | "failed";
  isVisibleToCustomer?: boolean;
  parentMessageId?: string;
  sourceMessageId?: string;
  teamsMessageId?: string;
  deliveryError?: string;
  retryCount?: number;
  lastRetryAt?: string;
  externalMessageId?: string;
  webhookEventId?: string;
  normalizedText?: string;
  receivedAt?: string;
  processedAt?: string;
  sentAt?: string;
  deliveredAt?: string;
  failedAt?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type Analysis = {
  id: string;
  caseId: string;
  messageId: string;
  analysisType: "customer_message" | "tech_solution" | "customer_rewrite" | "case_match" | "tech_message_review";
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
  validatedAt?: string;
  validatedBy?: string;
  autoAnswerReviewResult?: "APPROVED" | "REJECTED";
  autoAnswerReviewedAt?: string;
  autoAnswerReviewedBy?: string;
  createdAt: string;
};

export type AutomationSettings = {
  enabled: boolean;
  caseUnderstandingThreshold: number;
  caseDiscriminationThreshold: number;
  emergencyDisabledAt?: string;
  updatedAt: string;
};

export type CaseDetail = SupportCase & {
  customer: Customer;
  messages: Message[];
  analyses: Analysis[];
  solutions: Solution[];
};
