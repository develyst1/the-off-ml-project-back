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

try {
  await pool.query(schemaSql);
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
  await pool.query("rollback").catch(() => undefined);
  throw error;
} finally {
  await pool.end();
}
