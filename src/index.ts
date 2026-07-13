import { app } from "./app";
import { env } from "./config/env";

Bun.serve({
  port: env.PORT,
  fetch: app.fetch,
});

console.log(`Off Mai backend listening on http://localhost:${env.PORT}`);
