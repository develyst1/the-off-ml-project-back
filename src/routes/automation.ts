import { Hono } from "hono";
import { readJsonObject } from "../lib/request";
import { caseService } from "../services/case-service";
import { isSolutionReadyForAutoAnswer } from "../services/auto-answer-guardrail";

type AutomationSettings = {
  enabled: boolean;
  caseUnderstandingThreshold: number;
  caseDiscriminationThreshold: number;
  emergencyDisabledAt?: string;
  updatedAt: string;
};

let settings: AutomationSettings = {
  enabled: true,
  caseUnderstandingThreshold: 98,
  caseDiscriminationThreshold: 98,
  updatedAt: new Date().toISOString(),
};

export const automationRoutes = new Hono();

automationRoutes.get("/settings", (c) => c.json({ data: settings }));

automationRoutes.patch("/settings", async (c) => {
  const body = await readJsonObject(c);
  const enabled = typeof body.enabled === "boolean" ? body.enabled : settings.enabled;
  const emergencyDisable = body.emergencyDisable === true;

  settings = {
    ...settings,
    enabled: emergencyDisable ? false : enabled,
    emergencyDisabledAt: emergencyDisable ? new Date().toISOString() : settings.emergencyDisabledAt,
    updatedAt: new Date().toISOString(),
  };

  return c.json({ data: settings });
});

automationRoutes.get("/solutions", async (c) => {
  const cases = await caseService.listCases();
  const solutions = cases.flatMap((item) =>
    item.solutions
      .filter((solution) => isSolutionReadyForAutoAnswer(
        item.confidenceScore,
        solution,
        settings,
      ))
      .map((solution) => ({
        id: solution.id,
        category: item.category ?? "-",
        solutionText: solution.solutionSteps.join("\n") || solution.rewrittenCustomerText,
        caseUnderstandingConfidence: item.confidenceScore ?? 0,
        caseDiscriminationConfidence: solution.confidence,
        status: "ready",
      })),
  );

  return c.json({ data: solutions });
});

automationRoutes.get("/logs", async (c) => {
  const cases = await caseService.listCases();
  const logs = cases.flatMap((item) =>
    item.messages
      .filter((message) => message.direction === "OUTBOUND" && message.isVisibleToCustomer)
      .map((message) => ({
        id: message.id,
        time: message.createdAt,
        caseNumber: item.caseNumber,
        customer: item.customer.displayName ?? "ลูกค้า LINE",
        answerText: message.originalText,
        solutionText:
          item.solutions.at(-1)?.solutionSteps.join("\n") ||
          item.solutions.at(-1)?.rewrittenCustomerText ||
          item.solutions.at(-1)?.rawReplyText,
        teamsNotified: true,
      })),
  );

  return c.json({ data: logs });
});
