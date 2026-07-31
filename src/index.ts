import { app } from "./app";
import { env } from "./config/env";
import { startChatRetentionScheduler } from "./services/chat-retention-scheduler";

if (env.CHAT_RETENTION_SCHEDULER_ENABLED) {
  startChatRetentionScheduler();
}

const server = Bun.serve({
  port: env.PORT,
  fetch(request, server) {
    // Bun closes quiet requests after roughly 10 seconds by default. SSE must stay open
    // between messages, so disable that timeout only for this streaming endpoint.
    if (new URL(request.url).pathname === "/realtime/events") {
      server.timeout(request, 0);
    }
    return app.fetch(request);
  },
});

console.log(`Off ML Project backend listening on http://localhost:${env.PORT}`);
