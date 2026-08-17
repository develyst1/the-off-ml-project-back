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

// These are semantic classifications layered on top of the persisted legacy
// senderType/messageType fields. They keep UI consumers from treating a system
// audit event as an actual Tech Support reply.
export type MessageSource = "CUSTOMER" | "LINE_BOT" | "TECH_SUPPORT" | "SYSTEM";

export type CaseEventType =
  | "CASE_RECEIVED"
  | "AI_ANALYZED"
  | "TEAMS_SENT"
  | "TECH_REPLIED"
  | "LINE_REPLY_SENT"
  | "CASE_CLOSED"
  | "CASE_REOPENED";

export type Customer = {
  id: string;
  lineUserId: string;
  displayName?: string;
  activeCaseId?: string;
  pendingCaseSelection?: PendingCaseSelection;
  conversationState?: ConversationState;
  inboxLastReadAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type InboxMessage = {
  id: string;
  customerId: string;
  caseId?: string;
  assignedCaseId?: string;
  assignedBy?: string;
  assignedAt?: string;
  direction: "INBOUND" | "OUTBOUND";
  text: string;
  senderType: "CUSTOMER" | "TECH" | "BOT";
  externalMessageId?: string;
  webhookEventId?: string;
  deliveryStatus?: "PENDING" | "SENT" | "DELIVERED" | "FAILED";
  deliveryError?: string;
  sentAt?: string;
  deliveredAt?: string;
  createdAt: string;
};

export type InboxUser = {
  customer: Customer;
  latestMessage?: InboxMessage;
  messages: InboxMessage[];
  cases: CaseDetail[];
};

export type PendingCaseSelection = {
  mode: "choose" | "confirm" | "case_split_confirmation" | "case_history_match" | "request_more_info" | "close_case_request" | "context_only";
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
  pendingAction?: "REQUEST_MORE_INFO" | "CLOSE_CASE";
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
  | "AWAITING_ISSUE"
  | "HANDOFF_TO_TECH"
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
  conversationStartedAt?: string;
  conversationEndedAt?: string;
  closedAt?: string;
  closedBy?: string;
  closeSummary?: { cause: string; resolution: string; prevention: string };
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
  rawMessageTimelineExpired?: boolean;
  confidenceReviewStatus?: "PENDING" | "QUALITY_APPROVED" | "QUALITY_REJECTED" | "AUTO_ANSWER_APPROVED" | "AUTO_ANSWER_REJECTED";
  confidenceReviewedAt?: string;
  confidenceReviewedBy?: string;
  caseUnderstandingFeedback?: "CORRECT" | "INCORRECT";
  solutionSelectionFeedback?: "CORRECT" | "INCORRECT";
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
    | "AUTO_ANSWER"
    | "REQUEST_MORE_INFO"
    | "CUSTOMER_ADDITIONAL_INFO"
    | "TECH_RAW_REPLY"
    | "TECH_SOLUTION"
    | "TECH_MORE_INFO_REQUEST"
    | "TECH_ATTACHMENT"
    | "TECH_GENERAL_MESSAGE"
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
  analysisId: string;
  caseId: string;
  messageId?: string;
  analysisVersion: number;
  analysisType: "customer_message" | "customer_outcome" | "tech_solution" | "customer_rewrite" | "case_match" | "tech_message_review";
  summary?: string;
  category?: string;
  confidence: number;
  rawJson: unknown;
  createdAt: string;
};

export type CaseAnalysisContext = {
  subject: string;
  detail: string;
  referenceMessages: Array<{
    messageId: string;
    sender: NonNullable<Message["senderType"]>;
    content: string;
    createdAt: string;
    lineReceivedAt?: string;
    sequence: number;
  }>;
};

export type CaseAiFeedback = {
  id: string;
  caseId: string;
  feedbackType: "ISSUE_UNDERSTANDING" | "SOLUTION_SELECTION";
  value: "CORRECT" | "INCORRECT";
  caseAnalysisContextSnapshot: CaseAnalysisContext;
  aiCategory?: string;
  aiSummary?: string;
  aiSolution?: string;
  createdAt: string;
  updatedAt: string;
};

export type AiReviewFeedback = {
  id: string;
  caseId: string;
  analysisId?: string;
  analysisVersion: number;
  feedbackType: "ISSUE_UNDERSTANDING" | "SOLUTION_SELECTION";
  result: "CORRECT" | "INCORRECT";
  reviewSource: "CASE_DETAIL" | "CONFIDENCE_REVIEW";
  reason?: string;
  reviewedBy?: string;
  createdAt: string;
  updatedAt: string;
};

export type AiReviewFeedbackMemoryItem = {
  caseId: string;
  analysisId: string | null;
  analysisVersion: number;
  feedbackType: AiReviewFeedback["feedbackType"];
  result: AiReviewFeedback["result"];
  context: string;
  aiOutput: string;
  reason?: string | null;
  updatedAt: string;
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
  learnedReliabilityThreshold: number;
  emergencyDisabledAt?: string;
  updatedAt: string;
  updatedBy: string;
};

export type CaseDetail = SupportCase & {
  customer: Customer;
  messages: Message[];
  analyses: Analysis[];
  solutions: Solution[];
};
