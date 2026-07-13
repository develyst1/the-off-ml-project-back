import pg from "pg";
import { env } from "../config/env";

const { Pool } = pg;

if (!env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const targetUrl = new URL(env.DATABASE_URL);
const databaseName = targetUrl.pathname.replace("/", "");

if (!databaseName) {
  throw new Error("DATABASE_URL must include a database name");
}

const adminUrl = new URL(env.DATABASE_URL);
adminUrl.pathname = "/postgres";

const admin = new Pool({
  connectionString: adminUrl.toString(),
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
});

try {
  const existing = await admin.query("select 1 from pg_database where datname = $1", [databaseName]);

  if (existing.rowCount === 0) {
    const quotedName = `"${databaseName.replaceAll('"', '""')}"`;
    await admin.query(`create database ${quotedName}`);
    console.log(JSON.stringify({ created: true, database: databaseName }));
  } else {
    console.log(JSON.stringify({ created: false, database: databaseName }));
  }
} finally {
  await admin.end();
}
