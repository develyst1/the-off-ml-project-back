import pg from "pg";
import { env } from "../config/env";
import type { Analysis, CaseDetail, CaseStatus, Customer, Message, PendingCaseSelection, Solution, SupportCase } from "../domain/types";
import { createId, nowIso } from "../lib/ids";
import type { CaseStore } from "./case-store";
import { schemaSql } from "./schema";

const { Pool } = pg;

type DbCustomer = {
  id: string;
  line_user_id: string;
  display_name: string | null;
  active_case_id: string | null;
  pending_case_selection: PendingCaseSelection | null;
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
  status: CaseStatus;
  category: string | null;
  priority: SupportCase["priority"] | null;
  confidence_score: string | number | null;
  teams_thread_id: string | null;
  teams_delivery_status: SupportCase["teamsDeliveryStatus"];
  teams_delivery_at: Date | null;
  teams_delivery_error: string | null;
  created_at: Date;
  updated_at: Date;
};

type DbMessage = {
  id: string;
  case_id: string;
  direction: Message["direction"];
  channel: Message["channel"];
  original_text: string;
  sender_type: Message["senderType"];
  message_type: Message["messageType"];
  delivery_status: Message["deliveryStatus"];
  external_message_id: string | null;
  created_at: Date;
};

type DbAnalysis = {
  id: string;
  case_id: string;
  message_id: string;
  analysis_type: Analysis["analysisType"];
  summary: string | null;
  category: string | null;
  confidence: string | number;
  raw_json: unknown;
  created_at: Date;
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
  created_at: Date;
};

function dateIso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : value;
}

function optionalNumber(value: string | number | null) {
  if (value === null) return undefined;
  return Number(value);
}

function mapCustomer(row: DbCustomer): Customer {
  return {
    id: row.id,
    lineUserId: row.line_user_id,
    displayName: row.display_name ?? undefined,
    activeCaseId: row.active_case_id ?? undefined,
    pendingCaseSelection: row.pending_case_selection ?? undefined,
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
    status: row.status,
    category: row.category ?? undefined,
    priority: row.priority ?? undefined,
    confidenceScore: optionalNumber(row.confidence_score),
    teamsThreadId: row.teams_thread_id ?? undefined,
    teamsDeliveryStatus: row.teams_delivery_status ?? "not_sent",
    teamsDeliveryAt: row.teams_delivery_at ? dateIso(row.teams_delivery_at) : undefined,
    teamsDeliveryError: row.teams_delivery_error ?? undefined,
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
    senderType: row.sender_type,
    messageType: row.message_type,
    deliveryStatus: row.delivery_status,
    externalMessageId: row.external_message_id ?? undefined,
    createdAt: dateIso(row.created_at),
  };
}

function mapAnalysis(row: DbAnalysis): Analysis {
  return {
    id: row.id,
    caseId: row.case_id,
    messageId: row.message_id,
    analysisType: row.analysis_type,
    summary: row.summary ?? undefined,
    category: row.category ?? undefined,
    confidence: Number(row.confidence),
    rawJson: row.raw_json,
    createdAt: dateIso(row.created_at),
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

  async createCase(input: {
    customerId: string;
    status?: CaseStatus;
    title?: string;
    category?: string;
    confidenceScore?: number;
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
        `insert into support_cases (id, case_number, sequence_number, sequence_year, customer_id, title, status, category, confidence_score, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
         returning *`,
        [createId("case"), caseNumber, sequenceNumber, year, input.customerId, input.title ?? null, input.status ?? "new", input.category ?? null, input.confidenceScore ?? null, nowIso()],
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
         category = $4,
         priority = $5,
         confidence_score = $6,
         teams_thread_id = $7,
         teams_delivery_status = $8,
         teams_delivery_at = $9,
         teams_delivery_error = $10,
         updated_at = $11
       where id = $1
       returning *`,
      [
        id,
        patch.status ?? current.status,
        patch.title ?? current.title,
        patch.category ?? current.category,
        patch.priority ?? current.priority,
        patch.confidenceScore ?? current.confidence_score,
        patch.teamsThreadId ?? current.teams_thread_id,
        patch.teamsDeliveryStatus ?? current.teams_delivery_status,
        patch.teamsDeliveryAt ?? current.teams_delivery_at,
        "teamsDeliveryError" in patch ? patch.teamsDeliveryError ?? null : current.teams_delivery_error,
        nowIso(),
      ],
    );

    return mapCase(result.rows[0]);
  }

  async createMessage(input: Omit<Message, "id" | "createdAt">): Promise<Message> {
    const result = await this.query<DbMessage>(
      `insert into messages (id, case_id, direction, channel, original_text, sender_type, message_type, delivery_status, external_message_id, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning *`,
      [
        createId("msg"),
        input.caseId,
        input.direction,
        input.channel,
        input.originalText,
        input.senderType ?? "SYSTEM",
        input.messageType ?? "text",
        input.deliveryStatus ?? "sent",
        input.externalMessageId ?? null,
        nowIso(),
      ],
    );

    return mapMessage(result.rows[0]);
  }

  async getMessageByExternalMessageId(externalMessageId: string): Promise<Message | undefined> {
    const result = await this.query<DbMessage>(
      "select * from messages where external_message_id = $1 limit 1",
      [externalMessageId],
    );

    return result.rows[0] ? mapMessage(result.rows[0]) : undefined;
  }

  async createAnalysis(input: Omit<Analysis, "id" | "createdAt">): Promise<Analysis> {
    const result = await this.query<DbAnalysis>(
      `insert into analyses (id, case_id, message_id, analysis_type, summary, category, confidence, raw_json, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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

  private async buildCaseDetail(supportCase: SupportCase): Promise<CaseDetail | undefined> {
    const [customerResult, messageResult, analysisResult, solutionResult] = await Promise.all([
      this.query<DbCustomer>("select * from customers where id = $1", [supportCase.customerId]),
      this.query<DbMessage>("select * from messages where case_id = $1 order by created_at asc", [supportCase.id]),
      this.query<DbAnalysis>("select * from analyses where case_id = $1 order by created_at asc", [supportCase.id]),
      this.query<DbSolution>("select * from solutions where case_id = $1 order by created_at asc", [supportCase.id]),
    ]);

    const customer = customerResult.rows[0];
    if (!customer) return undefined;

    return {
      ...supportCase,
      customer: mapCustomer(customer),
      messages: messageResult.rows.map(mapMessage),
      analyses: analysisResult.rows.map(mapAnalysis),
      solutions: solutionResult.rows.map(mapSolution),
    };
  }
}
