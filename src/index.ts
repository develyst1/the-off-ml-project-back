import { app } from "./app";
import { env } from "./config/env";
import { startChatRetentionScheduler } from "./services/chat-retention-scheduler";

if (env.CHAT_RETENTION_SCHEDULER_ENABLED) {
  startChatRetentionScheduler();
}

Bun.serve({
  port: env.PORT,
  fetch: app.fetch,
});

console.log(`Off ML Project backend listening on http://localhost:${env.PORT}`);
