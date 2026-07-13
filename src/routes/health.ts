import { Hono } from "hono";

export const healthRoutes = new Hono();

healthRoutes.get("/", (c) =>
  c.json({
    ok: true,
    service: "off-ml-project-backend",
    timestamp: new Date().toISOString(),
  }),
);
