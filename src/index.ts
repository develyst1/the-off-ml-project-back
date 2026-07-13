import { app } from "./app";
import { env } from "./config/env";

Bun.serve({
  port: env.PORT,
  fetch: app.fetch,
});

console.log(`Off ML Project backend listening on http://localhost:${env.PORT}`);
