import { Hono } from "hono";
import { readJsonObject, requiredString } from "../lib/request";
import { caseService } from "../services/case-service";
import { lineClient } from "../services/line-client";
import { teamsClient } from "../services/teams-client";

export const integrationRoutes = new Hono();

integrationRoutes.get("/teams/status", (c) => c.json({
  data: teamsClient.getStatus(),
}));

integrationRoutes.post("/teams/notify", async (c) => {
  const body = await readJsonObject(c);
  const caseId = requiredString(body, "caseId");
  const detail = await caseService.getCase(caseId);

  if (!detail) {
    return c.json({ error: "case_not_found" }, 404);
  }

  return c.json({ data: await caseService.notifyTeams(caseId) });
});

integrationRoutes.post("/line/reply", async (c) => {
  const body = await readJsonObject(c);

  return c.json({
    data: await lineClient.reply({
      lineUserId: requiredString(body, "lineUserId"),
      text: requiredString(body, "text"),
    }),
  });
});
