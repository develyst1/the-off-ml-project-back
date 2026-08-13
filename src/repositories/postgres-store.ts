import pg from "pg";
import { env } from "../config/env";
import type { AiReviewFeedback, Analysis, AutomationSettings, CaseAiFeedback, CaseDetail, CaseMatchLog, CaseStatus, ConversationState, Customer, InboxMessage, InboxUser, Message, PendingCaseSelection, Solution, SupportCase } from "../domain/types";
import { createId, nowIso } from "../lib/ids";
import type { CaseStore, ChatRetentionCleanupResult } from "./case-store";
import { dedupeCaseMessages, normalizeCaseMessage } from "./case-message-normalizer";
import { schemaSql } from "./schema";
import { toAiReviewFeedbackMemoryItem } from "../lib/ai-review-feedback-memory";

const { Pool } = pg;

type DbCustomer = {
  id: string;
  line_user_id: string;
  display_name: string | null;
  active_case_id: string | null;
  pending_case_selection: PendingCaseSelection | null;
  conversation_state: ConversationState;
  inbox_last_read_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type DbCase = {
  id: string;
  case_number: string;
  sequence_number: number | string;
  sequence_year: number;
  customer_id: string;
  title: string | null;
  ai_status: SupportCase["aiStatus"] | null;
  data_status: SupportCase["dataStatus"];
  customer_sent_at: Date | null;
  system_received_at: Date | null;
  ai_analyzed_at: Date | null;
  teams_sent_at: Date | null;
  tech_replied_at: Date | null;
  line_sent_at: Date | null;
  line_delivered_at: Date | null;
  conversation_started_at: Date | null;
  conversation_ended_at: Date | null;
  closed_at: Date | null;
  closed_by: string | null;
  close_cause: string | null;
  close_resolution: string | null;
  close_prevention: string | null;
  status: CaseStatus;
  category: string | null;
  priority: SupportCase["priority"] | null;
  confidence_score: string | number | null;
  teams_thread_id: string | null;
  teams_delivery_status: SupportCase["teamsDeliveryStatus"];
  teams_delivery_at: Date | null;
  teams_delivery_error: string | null;
  initial_customer_message_id: string | null;
  latest_customer_message_id: string | null;
  problem_summary: string | null;
  problem_summary_generated_at: Date | null;
  problem_summary_source_message_id: string | null;
  problem_summary_version: number | null;
  problem_summary_status: SupportCase["problemSummaryStatus"];
  assignee_name: string | null;
  confidence_review_status: SupportCase["confidenceReviewStatus"];
  confidence_reviewed_at: Date | null;
  confidence_reviewed_by: string | null;
  case_understanding_feedback: SupportCase["caseUnderstandingFeedback"];
  solution_selection_feedback: SupportCase["solutionSelectionFeedback"];
  created_at: Date;
  updated_at: Date;
};

type DbMessage = {
  id: string;
  case_id: string;
  direction: Message["direction"];
  channel: Message["channel"];
  original_text: string;
  display_text: string;
  sender_type: Message["senderType"];
  content_type: NonNullable<Message["contentType"]>;
  message_type: Message["messageType"];
  delivery_status: Message["deliveryStatus"];
  is_visible_to_customer: boolean;
  parent_message_id: string | null;
  source_message_id: string | null;
  teams_message_id: string | null;
  delivery_error: string | null;
  retry_count: number;
  last_retry_at: Date | null;
  webhook_event_id: string | null;
  normalized_text: string | null;
  received_at: Date | null;
  processed_at: Date | null;
  sent_at: Date | null;
  delivered_at: Date | null;
  failed_at: Date | null;
  external_message_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
};

type DbInboxMessage = {
  id: string;
  customer_id: string;
  case_id: string | null;
  assigned_case_id: string | null;
  assigned_by: string | null;
  assigned_at: Date | null;
  direction: InboxMessage["direction"];
  sender_type: InboxMessage["senderType"];
  text: string;
  external_message_id: string | null;
  webhook_event_id: string | null;
  delivery_status: InboxMessage["deliveryStatus"] | null;
  delivery_error: string | null;
  sent_at: Date | null;
  delivered_at: Date | null;
  created_at: Date;
};

type DbAnalysis = {
  id: string;
  case_id: string;
  message_id: string | null;
  analysis_version: number | null;
  analysis_type: Analysis["analysisType"];
  summary: string | null;
  category: string | null;
  confidence: string | number;
  raw_json: unknown;
  created_at: Date;
};

type DbCaseAiFeedback = {
  id: string;
  case_id: string;
  feedback_type: CaseAiFeedback["feedbackType"];
  value: CaseAiFeedback["value"];
  case_analysis_context_snapshot: CaseAiFeedback["caseAnalysisContextSnapshot"];
  ai_category: string | null;
  ai_summary: string | null;
  ai_solution: string | null;
  created_at: Date;
  updated_at: Date;
};

type DbAiReviewFeedback = {
  id: string;
  case_id: string;
  analysis_id: string | null;
  analysis_version: number;
  feedback_type: AiReviewFeedback["feedbackType"];
  result: AiReviewFeedback["result"];
  review_source: AiReviewFeedback["reviewSource"];
  reason: string | null;
  reviewed_by: string | null;
  created_at: Date;
  updated_at: Date;
};

type DbAiReviewFeedbackMemory = DbAiReviewFeedback & {
  analysis_summary: string | null;
  analysis_category: string | null;
  analysis_raw_json: unknown;
  matched_analysis_id: string;
};

type DbSolution = {
  id: string;
  case_id: string;
  raw_reply_text: string;
  root_cause: string | null;
  solution_steps: string[];
  rewritten_customer_text: string;
  confidence: string | number;
  validated_by_team: boolean;
  validated_at: Date | null;
  validated_by: string | null;
  auto_answer_review_result: "APPROVED" | "REJECTED" | null;
  auto_answer_reviewed_at: Date | null;
  auto_answer_reviewed_by: string | null;
  created_at: Date;
};

type DbAutomationSettings = {
  enabled: boolean;
  case_understanding_threshold: string | number;
  case_discrimination_threshold: string | number;
  emergency_disabled_at: Date | null;
  updated_at: Date;
};

type DbCaseMatchLog = {
  id: string;
  customer_id: string;
  incoming_message: string;
  candidate_case_ids: string[];
  ai_intent: CaseMatchLog["aiIntent"];
  matched_case_id: string | null;
  confidence: string | number;
  reason: string;
  final_user_decision: CaseMatchLog["finalUserDecision"] | null;
  created_at: Date;
};

function dateIso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : value;
}

function optionalNumber(value: string | number | null) {
  if (value === null) return undefined;
  return Number(value);
}

function mapAutomationSettings(row: DbAutomationSettings): AutomationSettings {
  return {
    enabled: row.enabled,
    caseUnderstandingThreshold: Number(row.case_understanding_threshold),
    caseDiscriminationThreshold: Number(row.case_discrimination_threshold),
    emergencyDisabledAt: row.emergency_disabled_at ? dateIso(row.emergency_disabled_at) : undefined,
    updatedAt: dateIso(row.updated_at),
  };
}

function mapCustomer(row: DbCustomer): Customer {
  return {
    id: row.id,
    lineUserId: row.line_user_id,
    displayName: row.display_name ?? undefined,
    activeCaseId: row.active_case_id ?? undefined,
    pendingCaseSelection: row.pending_case_selection ?? undefined,
    conversationState: row.conversation_state,
    inboxLastReadAt: row.inbox_last_read_at ? dateIso(row.inbox_last_read_at) : undefined,
    createdAt: dateIso(row.created_at),
    updatedAt: dateIso(row.updated_at),
  };
}

function mapCase(row: DbCase): SupportCase {
  return {
    id: row.id,
    caseNumber: row.case_number,
    sequenceNumber: Number(row.sequence_number),
    sequenceYear: Number(row.sequence_year),
    customerId: row.customer_id,
    title: row.title ?? undefined,
    aiStatus: row.ai_status ?? undefined,
    dataStatus: row.data_status ?? "COMPLETE",
    customerSentAt: row.customer_sent_at ? dateIso(row.customer_sent_at) : undefined,
    systemReceivedAt: row.system_received_at ? dateIso(row.system_received_at) : undefined,
    aiAnalyzedAt: row.ai_analyzed_at ? dateIso(row.ai_analyzed_at) : undefined,
    teamsSentAt: row.teams_sent_at ? dateIso(row.teams_sent_at) : undefined,
    techRepliedAt: row.tech_replied_at ? dateIso(row.tech_replied_at) : undefined,
    lineSentAt: row.line_sent_at ? dateIso(row.line_sent_at) : undefined,
    lineDeliveredAt: row.line_delivered_at ? dateIso(row.line_delivered_at) : undefined,
    conversationStartedAt: row.conversation_started_at ? dateIso(row.conversation_started_at) : undefined,
    conversationEndedAt: row.conversation_ended_at ? dateIso(row.conversation_ended_at) : undefined,
    closedAt: row.closed_at ? dateIso(row.closed_at) : undefined,
    closedBy: row.closed_by ?? undefined,
    closeSummary: row.close_cause && row.close_resolution && row.close_prevention
      ? { cause: row.close_cause, resolution: row.close_resolution, prevention: row.close_prevention }
      : undefined,
    status: row.status,
    category: row.category ?? undefined,
    priority: row.priority ?? undefined,
    confidenceScore: optionalNumber(row.confidence_score),
    teamsThreadId: row.teams_thread_id ?? undefined,
    teamsDeliveryStatus: row.teams_delivery_status ?? "not_sent",
    teamsDeliveryAt: row.teams_delivery_at ? dateIso(row.teams_delivery_at) : undefined,
    teamsDeliveryError: row.teams_delivery_error ?? undefined,
    initialCustomerMessageId: row.initial_customer_message_id ?? undefined,
    latestCustomerMessageId: row.latest_customer_message_id ?? undefined,
    problemSummary: row.problem_summary ?? undefined,
    problemSummaryGeneratedAt: row.problem_summary_generated_at ? dateIso(row.problem_summary_generated_at) : undefined,
    problemSummarySourceMessageId: row.problem_summary_source_message_id ?? undefined,
    problemSummaryVersion: row.problem_summary_version ?? undefined,
    problemSummaryStatus: row.problem_summary_status ?? "PENDING",
    assigneeName: row.assignee_name ?? undefined,
    confidenceReviewStatus: row.confidence_review_status ?? "PENDING",
    confidenceReviewedAt: row.confidence_reviewed_at ? dateIso(row.confidence_reviewed_at) : undefined,
    confidenceReviewedBy: row.confidence_reviewed_by ?? undefined,
    caseUnderstandingFeedback: row.case_understanding_feedback ?? undefined,
    solutionSelectionFeedback: row.solution_selection_feedback ?? undefined,
    createdAt: dateIso(row.created_at),
    updatedAt: dateIso(row.updated_at),
  };
}

function mapMessage(row: DbMessage): Message {
  return {
    id: row.id,
    caseId: row.case_id,
    direction: row.direction,
    channel: row.channel,
    originalText: row.original_text,
    displayText: row.display_text,
    senderType: row.sender_type,
    contentType: row.content_type,
    messageType: row.message_type,
    deliveryStatus: row.delivery_status,
    isVisibleToCustomer: row.is_visible_to_customer,
    parentMessageId: row.parent_message_id ?? undefined,
    sourceMessageId: row.source_message_id ?? undefined,
    teamsMessageId: row.teams_message_id ?? undefined,
    deliveryError: row.delivery_error ?? undefined,
    retryCount: row.retry_count,
    lastRetryAt: row.last_retry_at ? dateIso(row.last_retry_at) : undefined,
    webhookEventId: row.webhook_event_id ?? undefined,
    normalizedText: row.normalized_text ?? undefined,
    receivedAt: row.received_at ? dateIso(row.received_at) : undefined,
    processedAt: row.processed_at ? dateIso(row.processed_at) : undefined,
    sentAt: row.sent_at ? dateIso(row.sent_at) : undefined,
    deliveredAt: row.delivered_at ? dateIso(row.delivered_at) : undefined,
    failedAt: row.failed_at ? dateIso(row.failed_at) : undefined,
    externalMessageId: row.external_message_id ?? undefined,
    metadata: row.metadata ?? undefined,
    createdAt: dateIso(row.created_at),
  };
}

function mapInboxMessage(row: DbInboxMessage): InboxMessage {
  return {
    id: row.id,
    customerId: row.customer_id,
    caseId: row.case_id ?? undefined,
    assignedCaseId: row.assigned_case_id ?? undefined,
    assignedBy: row.assigned_by ?? undefined,
    assignedAt: row.assigned_at ? dateIso(row.assigned_at) : undefined,
    direction: row.direction,
    senderType: row.sender_type,
    text: row.text,
    externalMessageId: row.external_message_id ?? undefined,
    webhookEventId: row.webhook_event_id ?? undefined,
    deliveryStatus: row.delivery_status ?? undefined,
    deliveryError: row.delivery_error ?? undefined,
    sentAt: row.sent_at ? dateIso(row.sent_at) : undefined,
    deliveredAt: row.delivered_at ? dateIso(row.delivered_at) : undefined,
    createdAt: dateIso(row.created_at),
  };
}

function mapAnalysis(row: DbAnalysis): Analysis {
  return {
    id: row.id,
    analysisId: row.id,
    caseId: row.case_id,
    messageId: row.message_id ?? undefined,
    analysisVersion: row.analysis_version ?? 1,
    analysisType: row.analysis_type,
    summary: row.summary ?? undefined,
    category: row.category ?? undefined,
    confidence: Number(row.confidence),
    rawJson: row.raw_json,
    createdAt: dateIso(row.created_at),
  };
}

function mapCaseAiFeedback(row: DbCaseAiFeedback): CaseAiFeedback {
  return {
    id: row.id,
    caseId: row.case_id,
    feedbackType: row.feedback_type,
    value: row.value,
    caseAnalysisContextSnapshot: row.case_analysis_context_snapshot,
    aiCategory: row.ai_category ?? undefined,
    aiSummary: row.ai_summary ?? undefined,
    aiSolution: row.ai_solution ?? undefined,
    createdAt: dateIso(row.created_at),
    updatedAt: dateIso(row.updated_at),
  };
}

function mapAiReviewFeedback(row: DbAiReviewFeedback): AiReviewFeedback {
  return {
    id: row.id,
    caseId: row.case_id,
    analysisId: row.analysis_id ?? undefined,
    analysisVersion: row.analysis_version,
    feedbackType: row.feedback_type,
    result: row.result,
    reviewSource: row.review_source,
    reason: row.reason ?? undefined,
    reviewedBy: row.reviewed_by ?? undefined,
    createdAt: dateIso(row.created_at),
    updatedAt: dateIso(row.updated_at),
  };
}

function mapSolution(row: DbSolution): Solution {
  return {
    id: row.id,
    caseId: row.case_id,
    rawReplyText: row.raw_reply_text,
    rootCause: row.root_cause ?? undefined,
    solutionSteps: row.solution_steps,
    rewrittenCustomerText: row.rewritten_customer_text,
    confidence: Number(row.confidence),
    validatedByTeam: row.validated_by_team,
    validatedAt: row.validated_at ? dateIso(row.validated_at) : undefined,
    validatedBy: row.validated_by ?? undefined,
    autoAnswerReviewResult: row.auto_answer_review_result ?? undefined,
    autoAnswerReviewedAt: row.auto_answer_reviewed_at ? dateIso(row.auto_answer_reviewed_at) : undefined,
    autoAnswerReviewedBy: row.auto_answer_reviewed_by ?? undefined,
    createdAt: dateIso(row.created_at),
  };
}

function mapCaseMatchLog(row: DbCaseMatchLog): CaseMatchLog {
  return {
    id: row.id,
    customerId: row.customer_id,
    incomingMessage: row.incoming_message,
    candidateCaseIds: row.candidate_case_ids ?? [],
    aiIntent: row.ai_intent,
    matchedCaseId: row.matched_case_id ?? undefined,
    confidence: Number(row.confidence),
    reason: row.reason,
    finalUserDecision: row.final_user_decision ?? undefined,
    createdAt: dateIso(row.created_at),
  };
}

export class PostgresStore implements CaseStore {
  private readonly pool: InstanceType<typeof Pool>;
  private schemaReady?: Promise<void>;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
    });
  }

  async close() {
    await this.pool.end();
  }

  private async ready() {
    this.schemaReady ??= this.pool.query(schemaSql).then(() => undefined);
    await this.schemaReady;
  }

  private async query<T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) {
    await this.ready();
    return this.pool.query<T>(sql, values);
  }

  async upsertCustomer(input: { lineUserId: string; displayName?: string }): Promise<Customer> {
    const id = createId("cus");
    const timestamp = nowIso();
    const result = await this.query<DbCustomer>(
      `insert into customers (id, line_user_id, display_name, created_at, updated_at)
       values ($1, $2, $3, $4, $4)
       on conflict (line_user_id)
       do update set
         display_name = coalesce(excluded.display_name, customers.display_name),
         updated_at = excluded.updated_at
       returning *`,
      [id, input.lineUserId, input.displayName ?? null, timestamp],
    );

    return mapCustomer(result.rows[0]);
  }

  async setActiveCase(customerId: string, caseId?: string): Promise<Customer> {
    const result = await this.query<DbCustomer>(
      `update customers set active_case_id = $2, updated_at = $3 where id = $1 returning *`,
      [customerId, caseId ?? null, nowIso()],
    );
    if (!result.rows[0]) throw new Error("Customer not found");
    return mapCustomer(result.rows[0]);
  }

  async setPendingCaseSelection(customerId: string, selection?: PendingCaseSelection): Promise<Customer> {
    const result = await this.query<DbCustomer>(
      `update customers set pending_case_selection = $2::jsonb, updated_at = $3 where id = $1 returning *`,
      [customerId, selection ? JSON.stringify(selection) : null, nowIso()],
    );
    if (!result.rows[0]) throw new Error("Customer not found");
    return mapCustomer(result.rows[0]);
  }

  async setConversationState(customerId: string, state: ConversationState): Promise<Customer> {
    const result = await this.query<DbCustomer>(
      `update customers set conversation_state = $2, updated_at = $3 where id = $1 returning *`,
      [customerId, state, nowIso()],
    );
    if (!result.rows[0]) throw new Error("Customer not found");
    return mapCustomer(result.rows[0]);
  }

  async markInboxRead(customerId: string, readAt = nowIso()): Promise<Customer> {
    const result = await this.query<DbCustomer>(
      `update customers set inbox_last_read_at = $2, updated_at = $2 where id = $1 returning *`,
      [customerId, readAt],
    );
    if (!result.rows[0]) throw new Error("Customer not found");
    return mapCustomer(result.rows[0]);
  }

  async createInboxMessage(input: Omit<InboxMessage, "id" | "createdAt"> & { createdAt?: string }): Promise<InboxMessage> {
    const result = await this.query<DbInboxMessage>(
      `insert into inbox_messages (id, customer_id, case_id, assigned_case_id, assigned_by, assigned_at, direction, sender_type, text, external_message_id, webhook_event_id, delivery_status, delivery_error, sent_at, delivered_at, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) returning *`,
      [createId("inbox"), input.customerId, input.caseId ?? null, input.assignedCaseId ?? input.caseId ?? null, input.assignedBy ?? null, input.assignedAt ?? null, input.direction, input.senderType, input.text, input.externalMessageId ?? null, input.webhookEventId ?? null, input.deliveryStatus ?? null, input.deliveryError ?? null, input.sentAt ?? null, input.deliveredAt ?? null, input.createdAt ?? nowIso()],
    );
    return mapInboxMessage(result.rows[0]);
  }

  async assignInboxMessageToCase(messageId: string, input: { caseId: string; assignedBy: string; assignedAt?: string }): Promise<InboxMessage> {
    const current = await this.query<{ case_id: string | null }>("select case_id from inbox_messages where id = $1", [messageId]);
    if (!current.rows[0]) throw new Error("Inbox message not found");
    if (current.rows[0].case_id && current.rows[0].case_id !== input.caseId) throw new Error("Inbox message is already assigned to another case");
    const result = await this.query<DbInboxMessage>(
      "update inbox_messages set case_id = $2, assigned_case_id = $2, assigned_by = $3, assigned_at = $4 where id = $1 returning *",
      [messageId, input.caseId, input.assignedBy, input.assignedAt ?? nowIso()],
    );
    if (!result.rows[0]) throw new Error("Inbox message not found");
    return mapInboxMessage(result.rows[0]);
  }

  async assignInboxMessagesToCase(messageIds: string[], input: { caseId: string; assignedBy: string; assignedAt?: string; allowReassignment?: boolean }): Promise<InboxMessage[]> {
    if (messageIds.length === 0) return [];
    await this.ready();
    const client = await this.pool.connect();
    const assignedAt = input.assignedAt ?? nowIso();
    try {
      await client.query("begin");
      const result = await client.query<DbInboxMessage>(
        `update inbox_messages
         set case_id = $2, assigned_case_id = $2, assigned_by = $3, assigned_at = $4
         where id = any($1::text[]) and (case_id is null or $5 = true)
         returning *`,
        [messageIds, input.caseId, input.assignedBy, assignedAt, input.allowReassignment ?? false],
      );
      await client.query("commit");
      return result.rows.map(mapInboxMessage);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async getInboxMessageByExternalMessageId(externalMessageId: string): Promise<InboxMessage | undefined> {
    const result = await this.query<DbInboxMessage>("select * from inbox_messages where external_message_id = $1 limit 1", [externalMessageId]);
    return result.rows[0] ? mapInboxMessage(result.rows[0]) : undefined;
  }

  async getInboxMessageByWebhookEventId(webhookEventId: string): Promise<InboxMessage | undefined> {
    const result = await this.query<DbInboxMessage>("select * from inbox_messages where webhook_event_id = $1 limit 1", [webhookEventId]);
    return result.rows[0] ? mapInboxMessage(result.rows[0]) : undefined;
  }

  async getInboxUser(customerId: string): Promise<InboxUser | undefined> {
    const customerResult = await this.query<DbCustomer>("select * from customers where id = $1", [customerId]);
    if (!customerResult.rows[0]) return undefined;
    const messagesResult = await this.query<DbInboxMessage>(
      "select * from inbox_messages where customer_id = $1 and created_at >= now() - interval '14 days' order by created_at asc",
      [customerId],
    );
    const casesResult = await this.query<DbCase>("select * from support_cases where customer_id = $1 order by created_at desc", [customerId]);
    const cases = await Promise.all(casesResult.rows.map((row) => this.buildCaseDetail(mapCase(row))));
    const messages = messagesResult.rows.map(mapInboxMessage);
    return {
      customer: mapCustomer(customerResult.rows[0]),
      latestMessage: messages.at(-1),
      messages,
      cases: cases.filter((item): item is CaseDetail => Boolean(item)),
    };
  }

  async listInboxUsers(): Promise<InboxUser[]> {
    const result = await this.query<{ customer_id: string }>("select distinct customer_id from inbox_messages where created_at >= now() - interval '14 days'");
    const users = await Promise.all(result.rows.map((row) => this.getInboxUser(row.customer_id)));
    return users
      .filter((item): item is InboxUser => Boolean(item))
      .sort((left, right) => new Date(right.latestMessage?.createdAt ?? 0).getTime() - new Date(left.latestMessage?.createdAt ?? 0).getTime());
  }

  async deleteExpiredRawMessages(input: { cutoffAt: Date; batchSize: number; dryRun: boolean }): Promise<ChatRetentionCleanupResult> {
    const startedAt = Date.now();
    const cutoffAt = input.cutoffAt.toISOString();
    const inboxPredicate = "created_at < $1";
    const casePredicate = "created_at < $1 and (sender_type <> 'SYSTEM' or content_type <> 'SYSTEM_EVENT')";
    const legacyPredicate = "created_at < $1";
    const deletedInboxMessages = await this.deleteExpiredRows("inbox_messages", inboxPredicate, cutoffAt, input.batchSize, input.dryRun);
    const deletedCaseMessages = await this.deleteExpiredRows("case_messages", casePredicate, cutoffAt, input.batchSize, input.dryRun);
    const deletedLegacyMessages = await this.deleteExpiredRows("messages", legacyPredicate, cutoffAt, input.batchSize, input.dryRun);

    return {
      cutoffAt,
      dryRun: input.dryRun,
      batchSize: input.batchSize,
      deletedInboxMessages,
      deletedCaseMessages,
      deletedLegacyMessages,
      totalDeleted: deletedInboxMessages + deletedCaseMessages + deletedLegacyMessages,
      durationMs: Date.now() - startedAt,
    };
  }

  async createCase(input: {
    customerId: string;
    status?: CaseStatus;
    title?: string;
    category?: string;
    confidenceScore?: number;
    conversationStartedAt?: string;
  }): Promise<SupportCase> {
    await this.ready();
    const client = await this.pool.connect();
    const year = new Date().getUTCFullYear();
    try {
      await client.query("begin");
      await client.query(
        `insert into case_number_counters (sequence_year, next_number) values ($1, 1) on conflict (sequence_year) do nothing`,
        [year],
      );
      const counter = await client.query<{ next_number: string }>(
        "select next_number from case_number_counters where sequence_year = $1 for update",
        [year],
      );
      const sequenceNumber = Number(counter.rows[0]?.next_number ?? 1);
      const caseNumber = `OFF-${year}-${String(sequenceNumber).padStart(5, "0")}`;
      await client.query("update case_number_counters set next_number = $2 where sequence_year = $1", [year, sequenceNumber + 1]);
      const result = await client.query<DbCase>(
        `insert into support_cases (id, case_number, sequence_number, sequence_year, customer_id, title, status, category, confidence_score, conversation_started_at, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
         returning *`,
        [createId("case"), caseNumber, sequenceNumber, year, input.customerId, input.title ?? null, input.status ?? "new", input.category ?? null, input.confidenceScore ?? null, input.conversationStartedAt ?? nowIso(), nowIso()],
      );
      await client.query("commit");
      return mapCase(result.rows[0]);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async updateCase(id: string, patch: Partial<Omit<SupportCase, "id" | "customerId" | "createdAt">>): Promise<SupportCase> {
    const current = await this.getCaseRow(id);
    if (!current) {
      throw new Error("Case not found");
    }

    const result = await this.query<DbCase>(
      `update support_cases set
         status = $2,
         title = $3,
         ai_status = $4,
         data_status = $5,
         customer_sent_at = $6,
         system_received_at = $7,
         ai_analyzed_at = $8,
         teams_sent_at = $9,
         tech_replied_at = $10,
         line_sent_at = $11,
         line_delivered_at = $12,
         closed_at = $13,
         closed_by = $14,
         close_cause = $15,
         close_resolution = $16,
         close_prevention = $17,
         category = $18,
         priority = $19,
         confidence_score = $20,
         teams_thread_id = $21,
         teams_delivery_status = $22,
         teams_delivery_at = $23,
         teams_delivery_error = $24,
         initial_customer_message_id = $25,
         latest_customer_message_id = $26,
         problem_summary = $27,
         problem_summary_generated_at = $28,
         problem_summary_source_message_id = $29,
         problem_summary_version = $30,
         problem_summary_status = $31,
         assignee_name = $32,
         confidence_review_status = $33,
         confidence_reviewed_at = $34,
         confidence_reviewed_by = $35,
         case_understanding_feedback = $36,
         solution_selection_feedback = $37,
         conversation_started_at = $38,
         conversation_ended_at = $39,
         updated_at = $40
       where id = $1
       returning *`,
      [
        id,
        patch.status ?? current.status,
        patch.title ?? current.title,
        patch.aiStatus ?? current.ai_status,
        patch.dataStatus ?? current.data_status,
        patch.customerSentAt ?? current.customer_sent_at,
        patch.systemReceivedAt ?? current.system_received_at,
        patch.aiAnalyzedAt ?? current.ai_analyzed_at,
        patch.teamsSentAt ?? current.teams_sent_at,
        patch.techRepliedAt ?? current.tech_replied_at,
        patch.lineSentAt ?? current.line_sent_at,
        patch.lineDeliveredAt ?? current.line_delivered_at,
        "closedAt" in patch ? patch.closedAt ?? null : current.closed_at,
        "closedBy" in patch ? patch.closedBy ?? null : current.closed_by,
        "closeSummary" in patch ? patch.closeSummary?.cause ?? null : current.close_cause,
        "closeSummary" in patch ? patch.closeSummary?.resolution ?? null : current.close_resolution,
        "closeSummary" in patch ? patch.closeSummary?.prevention ?? null : current.close_prevention,
        patch.category ?? current.category,
        patch.priority ?? current.priority,
        patch.confidenceScore ?? current.confidence_score,
        patch.teamsThreadId ?? current.teams_thread_id,
        patch.teamsDeliveryStatus ?? current.teams_delivery_status,
        patch.teamsDeliveryAt ?? current.teams_delivery_at,
        "teamsDeliveryError" in patch ? patch.teamsDeliveryError ?? null : current.teams_delivery_error,
        patch.initialCustomerMessageId ?? current.initial_customer_message_id,
        patch.latestCustomerMessageId ?? current.latest_customer_message_id,
        "problemSummary" in patch ? patch.problemSummary ?? null : current.problem_summary,
        "problemSummaryGeneratedAt" in patch ? patch.problemSummaryGeneratedAt ?? null : current.problem_summary_generated_at,
        "problemSummarySourceMessageId" in patch ? patch.problemSummarySourceMessageId ?? null : current.problem_summary_source_message_id,
        patch.problemSummaryVersion ?? current.problem_summary_version ?? 1,
        patch.problemSummaryStatus ?? current.problem_summary_status ?? "PENDING",
        "assigneeName" in patch ? patch.assigneeName ?? null : current.assignee_name,
         patch.confidenceReviewStatus ?? current.confidence_review_status ?? "PENDING",
         "confidenceReviewedAt" in patch ? patch.confidenceReviewedAt ?? null : current.confidence_reviewed_at,
         "confidenceReviewedBy" in patch ? patch.confidenceReviewedBy ?? null : current.confidence_reviewed_by,
         "caseUnderstandingFeedback" in patch ? patch.caseUnderstandingFeedback ?? null : current.case_understanding_feedback,
         "solutionSelectionFeedback" in patch ? patch.solutionSelectionFeedback ?? null : current.solution_selection_feedback,
         "conversationStartedAt" in patch ? patch.conversationStartedAt ?? null : current.conversation_started_at,
         "conversationEndedAt" in patch ? patch.conversationEndedAt ?? null : current.conversation_ended_at,
         nowIso(),
      ],
    );

    return mapCase(result.rows[0]);
  }

  async createMessage(input: Omit<Message, "id" | "createdAt">): Promise<Message> {
    const message = normalizeCaseMessage(input);
    const result = await this.query<DbMessage>(
      `insert into case_messages (id, case_id, direction, channel, sender_type, content_type, message_type, original_text, normalized_text, display_text, parent_message_id, source_message_id, is_visible_to_customer, external_message_id, webhook_event_id, teams_message_id, delivery_status, delivery_error, retry_count, last_retry_at, received_at, processed_at, sent_at, delivered_at, failed_at, created_at, updated_at, metadata)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28)
       returning *`,
      [
        createId("msg"),
        message.caseId,
        message.direction,
        message.channel,
        message.senderType ?? "SYSTEM",
        message.contentType,
        message.messageType,
        message.originalText,
        message.normalizedText ?? null,
        message.displayText,
        message.parentMessageId ?? null,
        message.sourceMessageId ?? null,
        message.isVisibleToCustomer,
        message.externalMessageId ?? null,
        message.webhookEventId ?? null,
        message.teamsMessageId ?? null,
        message.deliveryStatus,
        message.deliveryError ?? null,
        message.retryCount,
        message.lastRetryAt ?? null,
        message.receivedAt ?? null,
        message.processedAt ?? null,
        message.sentAt ?? null,
        message.deliveredAt ?? null,
        message.failedAt ?? null,
        nowIso(),
        nowIso(),
        message.metadata ?? {},
      ],
    );

    return mapMessage(result.rows[0]);
  }

  async updateMessage(id: string, patch: Partial<Pick<Message, "direction" | "messageType" | "senderType" | "deliveryStatus" | "deliveryError" | "sentAt" | "deliveredAt" | "failedAt" | "metadata">>): Promise<Message> {
    const result = await this.query<DbMessage>(
      `update case_messages
       set direction = coalesce($2, direction),
           sender_type = coalesce($3, sender_type),
           message_type = coalesce($4, message_type),
           delivery_status = coalesce($5, delivery_status),
           delivery_error = coalesce($6, delivery_error),
           sent_at = coalesce($7, sent_at),
           delivered_at = coalesce($8, delivered_at),
           failed_at = coalesce($9, failed_at),
           metadata = case when $10::jsonb is null then metadata else metadata || $10::jsonb end,
           updated_at = now()
       where id = $1
       returning *`,
      [id, patch.direction ?? null, patch.senderType ?? null, patch.messageType ?? null, patch.deliveryStatus ?? null, patch.deliveryError ?? null, patch.sentAt ?? null, patch.deliveredAt ?? null, patch.failedAt ?? null, patch.metadata ? JSON.stringify(patch.metadata) : null],
    );
    if (!result.rows[0]) throw new Error("Message not found");
    return mapMessage(result.rows[0]);
  }

  async getMessageByExternalMessageId(externalMessageId: string): Promise<Message | undefined> {
    const result = await this.query<DbMessage>(
      "select * from case_messages where external_message_id = $1 limit 1",
      [externalMessageId],
    );

    return result.rows[0] ? mapMessage(result.rows[0]) : undefined;
  }

  async getMessageByWebhookEventId(webhookEventId: string): Promise<Message | undefined> {
    const result = await this.query<DbMessage>("select * from case_messages where webhook_event_id = $1 limit 1", [webhookEventId]);
    return result.rows[0] ? mapMessage(result.rows[0]) : undefined;
  }

  async createAnalysis(input: Omit<Analysis, "id" | "analysisId" | "createdAt" | "analysisVersion">): Promise<Analysis> {
    const result = await this.query<DbAnalysis>(
      `insert into analyses (
         id, case_id, message_id, analysis_version, analysis_type,
         summary, category, confidence, raw_json, created_at
       )
       select $1, $2, $3, coalesce(max(analysis_version), 0) + 1, $4, $5, $6, $7, $8, $9
       from analyses
       where case_id = $2
       returning *`,
      [
        createId("ana"),
        input.caseId,
        input.messageId,
        input.analysisType,
        input.summary ?? null,
        input.category ?? null,
        input.confidence,
        JSON.stringify(input.rawJson),
        nowIso(),
      ],
    );

    return mapAnalysis(result.rows[0]);
  }

  async upsertAiReviewFeedback(input: Omit<AiReviewFeedback, "id" | "createdAt" | "updatedAt">): Promise<AiReviewFeedback> {
    const timestamp = nowIso();
    const result = await this.query<DbAiReviewFeedback>(
      `insert into ai_review_feedback (
        id, case_id, analysis_id, analysis_version, feedback_type, result,
        review_source, reason, reviewed_by, created_at, updated_at
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      on conflict (case_id, analysis_version, feedback_type) do update set
        analysis_id = excluded.analysis_id,
        result = excluded.result,
        review_source = excluded.review_source,
        reason = excluded.reason,
        reviewed_by = excluded.reviewed_by,
        updated_at = excluded.updated_at
      returning *`,
      [
        createId("review"),
        input.caseId,
        input.analysisId ?? null,
        input.analysisVersion,
        input.feedbackType,
        input.result,
        input.reviewSource,
        input.reason ?? null,
        input.reviewedBy ?? null,
        timestamp,
        timestamp,
      ],
    );
    return mapAiReviewFeedback(result.rows[0]);
  }

  async listAiReviewFeedback(): Promise<AiReviewFeedback[]> {
    const result = await this.query<DbAiReviewFeedback>("select * from ai_review_feedback order by updated_at desc");
    return result.rows.map(mapAiReviewFeedback);
  }

  async listAiReviewFeedbackForReliability(options: { excludeCaseId?: string } = {}): Promise<AiReviewFeedback[]> {
    const result = await this.query<DbAiReviewFeedback>(
      `select feedback.*
       from ai_review_feedback feedback
       inner join analyses analysis
         on analysis.id = feedback.analysis_id
        and analysis.case_id = feedback.case_id
        and analysis.analysis_version = feedback.analysis_version
       where feedback.analysis_id is not null
         and feedback.review_source = 'CONFIDENCE_REVIEW'
         and ($1::text is null or feedback.case_id <> $1)
       order by feedback.updated_at desc`,
      [options.excludeCaseId ?? null],
    );
    return result.rows.map(mapAiReviewFeedback);
  }

  async listAiReviewFeedbackForMemory(options: { feedbackType?: AiReviewFeedback["feedbackType"]; result?: AiReviewFeedback["result"]; limit: number }) {
    const result = await this.query<DbAiReviewFeedbackMemory>(
      `select feedback.*, analysis.summary as analysis_summary, analysis.category as analysis_category,
              analysis.raw_json as analysis_raw_json, analysis.id as matched_analysis_id
       from ai_review_feedback feedback
       inner join analyses analysis
         on analysis.case_id = feedback.case_id
        and analysis.analysis_version = feedback.analysis_version
        and (
          feedback.analysis_id = analysis.id
          or (
            feedback.analysis_id is null
            and not exists (
              select 1
              from analyses duplicate_analysis
              where duplicate_analysis.case_id = analysis.case_id
                and duplicate_analysis.analysis_version = analysis.analysis_version
                and duplicate_analysis.id <> analysis.id
            )
          )
        )
       where ($1::text is null or feedback.feedback_type = $1)
         and ($2::text is null or feedback.result = $2)
       order by feedback.updated_at desc
       limit $3`,
      [options.feedbackType ?? null, options.result ?? null, Math.max(0, options.limit)],
    );
    return result.rows.map((row) => toAiReviewFeedbackMemoryItem(mapAiReviewFeedback(row), {
      caseId: row.case_id,
      analysisId: row.matched_analysis_id,
      analysisVersion: row.analysis_version,
      summary: row.analysis_summary ?? undefined,
      category: row.analysis_category ?? undefined,
      rawJson: row.analysis_raw_json,
    }));
  }

  async upsertCaseAiFeedback(input: Omit<CaseAiFeedback, "id" | "createdAt" | "updatedAt">): Promise<CaseAiFeedback> {
    const timestamp = nowIso();
    const result = await this.query<DbCaseAiFeedback>(
      `insert into case_ai_feedback (
        id, case_id, feedback_type, value, case_analysis_context_snapshot,
        ai_category, ai_summary, ai_solution, created_at, updated_at
      ) values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
      on conflict (case_id, feedback_type) do update set
        value = excluded.value,
        case_analysis_context_snapshot = excluded.case_analysis_context_snapshot,
        ai_category = excluded.ai_category,
        ai_summary = excluded.ai_summary,
        ai_solution = excluded.ai_solution,
        updated_at = excluded.updated_at
      returning *`,
      [
        createId("feedback"),
        input.caseId,
        input.feedbackType,
        input.value,
        JSON.stringify(input.caseAnalysisContextSnapshot),
        input.aiCategory ?? null,
        input.aiSummary ?? null,
        input.aiSolution ?? null,
        timestamp,
        timestamp,
      ],
    );
    return mapCaseAiFeedback(result.rows[0]);
  }

  async deleteCaseAiFeedback(caseId: string, feedbackType: CaseAiFeedback["feedbackType"]): Promise<void> {
    await this.query("delete from case_ai_feedback where case_id = $1 and feedback_type = $2", [caseId, feedbackType]);
  }

  async listCaseAiFeedback(): Promise<CaseAiFeedback[]> {
    const result = await this.query<DbCaseAiFeedback>("select * from case_ai_feedback order by updated_at desc");
    return result.rows.map(mapCaseAiFeedback);
  }

  async createSolution(input: Omit<Solution, "id" | "createdAt">): Promise<Solution> {
    const result = await this.query<DbSolution>(
      `insert into solutions (
         id, case_id, raw_reply_text, root_cause, solution_steps,
         rewritten_customer_text, confidence, validated_by_team, created_at
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning *`,
      [
        createId("sol"),
        input.caseId,
        input.rawReplyText,
        input.rootCause ?? null,
        input.solutionSteps,
        input.rewrittenCustomerText,
        input.confidence,
        input.validatedByTeam,
        nowIso(),
      ],
    );

    return mapSolution(result.rows[0]);
  }

  async updateSolution(id: string, patch: Partial<Pick<Solution, "confidence" | "validatedByTeam" | "validatedAt" | "validatedBy" | "autoAnswerReviewResult" | "autoAnswerReviewedAt" | "autoAnswerReviewedBy">>): Promise<Solution> {
    const result = await this.query<DbSolution>(
      `update solutions
       set confidence = coalesce($2, confidence),
           validated_by_team = $3,
           validated_at = $4,
           validated_by = $5,
           auto_answer_review_result = $6,
           auto_answer_reviewed_at = $7,
           auto_answer_reviewed_by = $8
       where id = $1 returning *`,
      [
        id,
        patch.confidence ?? null,
        patch.validatedByTeam,
        patch.validatedAt ?? null,
        patch.validatedBy ?? null,
        patch.autoAnswerReviewResult ?? null,
        patch.autoAnswerReviewedAt ?? null,
        patch.autoAnswerReviewedBy ?? null,
      ],
    );
    if (!result.rows[0]) throw new Error("Solution not found");
    return mapSolution(result.rows[0]);
  }

  async getAutomationSettings(): Promise<AutomationSettings> {
    const result = await this.query<DbAutomationSettings>(
      `select enabled, case_understanding_threshold, case_discrimination_threshold, emergency_disabled_at, updated_at
       from automation_settings where id = 'default'`,
    );
    if (!result.rows[0]) throw new Error("Automation settings not found");
    return mapAutomationSettings(result.rows[0]);
  }

  async updateAutomationSettings(patch: Partial<Pick<AutomationSettings, "enabled" | "caseUnderstandingThreshold" | "caseDiscriminationThreshold" | "emergencyDisabledAt">>): Promise<AutomationSettings> {
    const current = await this.getAutomationSettings();
    const next = {
      enabled: patch.enabled ?? current.enabled,
      caseUnderstandingThreshold: patch.caseUnderstandingThreshold ?? current.caseUnderstandingThreshold,
      caseDiscriminationThreshold: patch.caseDiscriminationThreshold ?? current.caseDiscriminationThreshold,
      emergencyDisabledAt: "emergencyDisabledAt" in patch
        ? patch.emergencyDisabledAt
        : current.emergencyDisabledAt,
    };
    const result = await this.query<DbAutomationSettings>(
      `update automation_settings
       set enabled = $1,
           case_understanding_threshold = $2,
           case_discrimination_threshold = $3,
           emergency_disabled_at = $4,
           updated_at = $5
       where id = 'default'
       returning enabled, case_understanding_threshold, case_discrimination_threshold, emergency_disabled_at, updated_at`,
      [
        next.enabled,
        next.caseUnderstandingThreshold,
        next.caseDiscriminationThreshold,
        next.emergencyDisabledAt ?? null,
        nowIso(),
      ],
    );
    if (!result.rows[0]) throw new Error("Automation settings not found");
    return mapAutomationSettings(result.rows[0]);
  }

  async createCaseMatchLog(input: Omit<CaseMatchLog, "id" | "createdAt">): Promise<CaseMatchLog> {
    const result = await this.query<DbCaseMatchLog>(
      `insert into case_match_logs (
        id, customer_id, incoming_message, candidate_case_ids, ai_intent,
        matched_case_id, confidence, reason, final_user_decision, created_at
      ) values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10) returning *`,
      [
        createId("match"),
        input.customerId,
        input.incomingMessage,
        JSON.stringify(input.candidateCaseIds),
        input.aiIntent,
        input.matchedCaseId ?? null,
        input.confidence,
        input.reason,
        input.finalUserDecision ?? null,
        nowIso(),
      ],
    );
    return mapCaseMatchLog(result.rows[0]);
  }

  async updateCaseMatchLogDecision(id: string, finalUserDecision: NonNullable<CaseMatchLog["finalUserDecision"]>): Promise<CaseMatchLog> {
    const result = await this.query<DbCaseMatchLog>(
      "update case_match_logs set final_user_decision = $2 where id = $1 returning *",
      [id, finalUserDecision],
    );
    if (!result.rows[0]) throw new Error("Case match log not found");
    return mapCaseMatchLog(result.rows[0]);
  }

  async listCases(): Promise<CaseDetail[]> {
    const result = await this.query<DbCase>("select * from support_cases order by created_at desc");
    const details = await Promise.all(result.rows.map((row) => this.buildCaseDetail(mapCase(row))));
    return details.filter((detail): detail is CaseDetail => Boolean(detail));
  }

  async getCaseDetail(id: string): Promise<CaseDetail | undefined> {
    const row = await this.getCaseRow(id);
    if (!row) return undefined;
    return this.buildCaseDetail(mapCase(row));
  }

  private async getCaseRow(id: string): Promise<DbCase | undefined> {
    const result = await this.query<DbCase>("select * from support_cases where id = $1", [id]);
    return result.rows[0];
  }

  private async deleteExpiredRows(table: "inbox_messages" | "case_messages" | "messages", predicate: string, cutoffAt: string, batchSize: number, dryRun: boolean) {
    const countResult = await this.query<{ count: string }>(`select count(*)::text as count from ${table} where ${predicate}`, [cutoffAt]);
    const total = Number(countResult.rows[0]?.count ?? 0);
    if (dryRun || total === 0) return total;

    let deleted = 0;
    while (true) {
      const result = await this.query<{ id: string }>(
        `with expired as (
           select id from ${table}
           where ${predicate}
           order by created_at asc
           limit $2
         )
         delete from ${table} target
         using expired
         where target.id = expired.id
         returning target.id`,
        [cutoffAt, batchSize],
      );
      deleted += result.rows.length;
      if (result.rows.length < batchSize) return deleted;
    }
  }

  private async buildCaseDetail(supportCase: SupportCase): Promise<CaseDetail | undefined> {
    const [customerResult, messageResult, analysisResult, solutionResult] = await Promise.all([
      this.query<DbCustomer>("select * from customers where id = $1", [supportCase.customerId]),
      this.query<DbMessage>("select * from case_messages where case_id = $1 order by created_at asc", [supportCase.id]),
      this.query<DbAnalysis>("select * from analyses where case_id = $1 order by created_at asc", [supportCase.id]),
      this.query<DbSolution>("select * from solutions where case_id = $1 order by created_at asc", [supportCase.id]),
    ]);

    const customer = customerResult.rows[0];
    if (!customer) return undefined;

    const messages = dedupeCaseMessages(messageResult.rows.map(mapMessage));
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
      customer: mapCustomer(customer),
      initialCustomerMessageId: supportCase.initialCustomerMessageId ?? customerMessages[0]?.id,
      latestCustomerMessageId: supportCase.latestCustomerMessageId ?? latestCustomerMessage?.id,
      hasUnreadCustomerMessage: Boolean(latestCustomerMessage && (!latestOutboundMessage || new Date(latestCustomerMessage.receivedAt ?? latestCustomerMessage.createdAt).getTime() > new Date(latestOutboundMessage.createdAt).getTime())),
      rawMessageTimelineExpired: messages.filter((message) => message.senderType !== "SYSTEM" || message.contentType !== "SYSTEM_EVENT").length === 0
        && new Date(supportCase.createdAt).getTime() < Date.now() - 14 * 24 * 60 * 60 * 1000,
      messages,
      analyses: analysisResult.rows.map(mapAnalysis),
      solutions: solutionResult.rows.map(mapSolution),
    };
  }
}
