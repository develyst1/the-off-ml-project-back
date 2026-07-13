import { env } from "../config/env";
import { InMemoryStore } from "./in-memory-store";
import { PostgresStore } from "./postgres-store";

export const store = env.DATABASE_URL ? new PostgresStore(env.DATABASE_URL) : new InMemoryStore();
