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
  }));
} finally {
  await pool.end();
}
