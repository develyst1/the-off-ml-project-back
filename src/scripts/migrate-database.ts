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
  console.log("Database migration completed: support_cases.case_number is ready.");
} finally {
  await pool.end();
}
