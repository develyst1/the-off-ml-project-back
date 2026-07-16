import pg from "pg";
import { env } from "../config/env";

const { Pool } = pg;
const confirmation = Bun.env.CONFIRM_RESET === "RESET_TEST_DATA" || Bun.argv.includes("--confirm-reset");

if (!confirmation) {
  throw new Error("Refusing to reset data. Run with --confirm-reset.");
}

if (!env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required to reset test data.");
}

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
});

try {
  await pool.query("begin");
  await pool.query(`
    truncate table
      auto_answer_logs,
      confidence_matches,
      solutions,
      analyses,
      messages,
      support_cases,
      customers,
      case_number_counters
    restart identity cascade
  `);
  await pool.query(`
    update automation_settings
    set enabled = false,
        emergency_disabled_at = null,
        updated_at = now()
    where id = 'default'
  `);
  await pool.query("commit");
  console.log("Test cases and LINE conversation state have been reset.");
} catch (error) {
  await pool.query("rollback");
  throw error;
} finally {
  await pool.end();
}
