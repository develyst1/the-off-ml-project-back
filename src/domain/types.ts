export type CaseStatus =
  | "new"
  | "analyzing"
  | "awaiting_tech"
  | "tech_replied"
  | "analyzing_solution"
  | "resolved"
  | "sent_to_customer"
  | "closed"
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
  createdAt: string;
  updatedAt: string;
};

export type SupportCase = {
  id: string;
  customerId: string;
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
  externalMessageId?: string;
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
