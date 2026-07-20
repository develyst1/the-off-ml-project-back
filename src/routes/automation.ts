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

const LOG_PAGE_SIZES = new Set([10, 20, 50, 100]);

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseDateBoundary(value: string | undefined, endOfDay = false) {
  if (!value) return undefined;
  const date = new Date(`${value}${endOfDay ? "T23:59:59.999" : "T00:00:00.000"}`);
  return Number.isNaN(date.getTime()) ? undefined : date.getTime();
}

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
  const page = positiveInteger(c.req.query("page"), 1);
  const requestedPageSize = positiveInteger(c.req.query("pageSize"), 10);
  const pageSize = LOG_PAGE_SIZES.has(requestedPageSize) ? requestedPageSize : 10;
  const search = c.req.query("search")?.trim().toLocaleLowerCase();
  const eventType = c.req.query("eventType")?.trim();
  const status = c.req.query("status")?.trim();
  const dateFrom = parseDateBoundary(c.req.query("dateFrom"));
  const dateTo = parseDateBoundary(c.req.query("dateTo"), true);
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
        eventType: message.messageType ?? "UNKNOWN",
        status: message.deliveryStatus ?? "UNKNOWN",
        solutionText:
          item.solutions.at(-1)?.solutionSteps.join("\n") ||
          item.solutions.at(-1)?.rewrittenCustomerText ||
          item.solutions.at(-1)?.rawReplyText,
        teamsNotified: true,
      })),
  )
    .filter((item) => {
      const time = new Date(item.time).getTime();
      const searchable = `${item.caseNumber} ${item.customer} ${item.answerText} ${item.solutionText ?? ""}`.toLocaleLowerCase();
      return (!search || searchable.includes(search))
        && (!eventType || item.eventType === eventType)
        && (!status || item.status === status)
        && (dateFrom === undefined || time >= dateFrom)
        && (dateTo === undefined || time <= dateTo);
    })
    .sort((left, right) => new Date(right.time).getTime() - new Date(left.time).getTime());

  const totalItems = logs.length;
  const totalPages = Math.ceil(totalItems / pageSize);
  const safePage = totalPages === 0 ? 1 : Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;

  return c.json({
    data: {
      items: logs.slice(start, start + pageSize),
      totalItems,
      totalPages,
      page: safePage,
      pageSize,
    },
  });
});
