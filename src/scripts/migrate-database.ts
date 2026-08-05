import pg from "pg";
import { env } from "../config/env";
import { schemaSql } from "../repositories/schema";

if (!env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const { Pool } = pg;
const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
});

type PostgresError = {
  message?: string;
  code?: string;
  position?: string;
  detail?: string;
  hint?: string;
};

function splitSqlStatements(sql: string) {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let dollarQuote: string | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];

    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (dollarQuote) {
      if (sql.startsWith(dollarQuote, index)) {
        index += dollarQuote.length - 1;
        dollarQuote = null;
      }
      continue;
    }
    if (quote) {
      if (character === quote) {
        if (quote === "'" && next === "'") {
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "$") {
      const match = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        dollarQuote = match[0];
        index += dollarQuote.length - 1;
        continue;
      }
    }
    if (character === ";") {
      const statement = sql.slice(start, index + 1).trim();
      if (statement) statements.push(statement);
      start = index + 1;
    }
  }

  const trailingStatement = sql.slice(start).trim();
  if (trailingStatement) statements.push(trailingStatement);
  return statements;
}

function statementName(sql: string, index: number) {
  const firstSqlLine = sql
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("--"));
  return `schema_${index + 1}:${firstSqlLine?.slice(0, 100) ?? "unknown"}`;
}

async function runSchemaMigration() {
  const statements = splitSqlStatements(schemaSql);
  for (const [index, statement] of statements.entries()) {
    const name = statementName(statement, index);
    try {
      await pool.query(statement);
    } catch (error) {
      const migrationError = error as PostgresError;
      console.error(JSON.stringify({
        migrated: false,
        phase: "schema",
        statement: name,
        sql: statement,
        message: migrationError.message,
        code: migrationError.code,
        position: migrationError.position,
        detail: migrationError.detail,
        hint: migrationError.hint,
      }));
      throw error;
    }
  }
}

try {
  await runSchemaMigration();
  await pool.query("begin");
  await pool.query(`
    update support_cases c
    set initial_customer_message_id = coalesce(
          c.initial_customer_message_id,
          (select m.id
           from case_messages m
           where m.case_id = c.id
             and upper(m.direction) = 'INBOUND'
             and m.sender_type = 'CUSTOMER'
           order by coalesce(m.received_at, m.created_at) asc, m.created_at asc
           limit 1)
    where c.initial_customer_message_id is null;

    update support_cases c
    set latest_customer_message_id = coalesce(
          c.latest_customer_message_id,
          (select m.id
           from case_messages m
           where m.case_id = c.id
             and upper(m.direction) = 'INBOUND'
             and m.sender_type = 'CUSTOMER'
           order by coalesce(m.received_at, m.created_at) desc, m.created_at desc
           limit 1)
    where c.latest_customer_message_id is null;

    update support_cases c
    set problem_summary = coalesce(
          nullif(c.problem_summary, ''),
          (select nullif(a.summary, '')
           from analyses a
           where a.case_id = c.id
             and a.analysis_type = 'customer_message'
             and nullif(a.summary, '') is not null
           order by a.created_at desc
           limit 1)
    where nullif(c.problem_summary, '') is null;

    update support_cases c
    set problem_summary_generated_at = coalesce(
          c.problem_summary_generated_at,
          (select a.created_at
           from analyses a
           where a.case_id = c.id
             and a.analysis_type = 'customer_message'
             and nullif(a.summary, '') is not null
           order by a.created_at desc
           limit 1)),
        problem_summary_source_message_id = coalesce(
          c.problem_summary_source_message_id,
          (select a.message_id
           from analyses a
           where a.case_id = c.id
             and a.analysis_type = 'customer_message'
             and nullif(a.summary, '') is not null
           order by a.created_at desc
           limit 1)),
        problem_summary_status = case
          when nullif(c.problem_summary, '') is not null then 'SUCCESS'
          else c.problem_summary_status
        end
    where c.problem_summary_status is distinct from 'SUCCESS';
  `);
  const [{ rows: missingInitialRows }, { rows: missingSummaryRows }] = await Promise.all([
    pool.query<{ count: string }>("select count(*)::text as count from support_cases where initial_customer_message_id is null"),
    pool.query<{ count: string }>("select count(*)::text as count from support_cases where nullif(problem_summary, '') is null"),
  ]);
  await pool.query("commit");
  const [{ rows: legacyRows }, { rows: caseMessageRows }, { rows: unclearRows }] = await Promise.all([
    pool.query<{ count: string }>("select count(*)::text as count from messages"),
    pool.query<{ count: string }>("select count(*)::text as count from case_messages"),
    pool.query<{ count: string }>("select count(*)::text as count from case_messages where message_type = 'SYSTEM_EVENT'"),
  ]);
  console.log(JSON.stringify({
    migrated: true,
    legacyMessages: Number(legacyRows[0]?.count ?? 0),
    caseMessages: Number(caseMessageRows[0]?.count ?? 0),
    needsReview: Number(unclearRows[0]?.count ?? 0),
    missingInitialCustomerMessage: Number(missingInitialRows[0]?.count ?? 0),
    missingProblemSummary: Number(missingSummaryRows[0]?.count ?? 0),
  }));
} catch (error) {
  const migrationError = error as PostgresError;
  console.error(JSON.stringify({
    migrated: false,
    message: migrationError.message ?? "Database migration failed",
    code: migrationError.code,
    position: migrationError.position,
    detail: migrationError.detail,
    hint: migrationError.hint,
  }));
  await pool.query("rollback").catch(() => undefined);
  throw error;
} finally {
  await pool.end();
}
