import { Hono } from "hono";
import { optionalString, readJsonObject, requiredString } from "../lib/request";
import { caseService } from "../services/case-service";
import { AutoAnswerNotificationError, notifyTeamsForAutoAnswer } from "../services/auto-answer-notification-service";
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

integrationRoutes.post("/teams/auto-answer-log", async (c) => {
  let body: Record<string, unknown>;
  let caseId: string;
  let caseMessageId: string;
  let solutionId: string | undefined;
  let analysisId: string | undefined;
  try {
    body = await readJsonObject(c);
    caseId = requiredString(body, "caseId");
    caseMessageId = requiredString(body, "caseMessageId");
    solutionId = optionalString(body, "solutionId");
    analysisId = optionalString(body, "analysisId");
  } catch {
    return c.json({ error: "invalid_request" }, 400);
  }
  const analysisVersionValue = body.analysisVersion;
  const analysisVersion = analysisVersionValue === undefined
    ? undefined
    : typeof analysisVersionValue === "number" && Number.isInteger(analysisVersionValue) && analysisVersionValue > 0
      ? analysisVersionValue
      : null;
  if (analysisVersion === null) {
    return c.json({ error: "analysisVersion_must_be_a_positive_integer" }, 400);
  }

  try {
    const data = await notifyTeamsForAutoAnswer({
      caseId,
      caseMessageId,
      solutionId,
      analysisId,
      analysisVersion,
    });
    return c.json({ data });
  } catch (error) {
    if (error instanceof AutoAnswerNotificationError) {
      return c.json({ error: error.code }, error.status);
    }
    throw error;
  }
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
