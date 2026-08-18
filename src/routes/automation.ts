import { Hono } from "hono";
import { readJsonObject } from "../lib/request";
import { store } from "../repositories/store";
import { caseService } from "../services/case-service";
import { isSolutionReadyForAutoAnswer } from "../services/auto-answer-guardrail";
import { emergencyDisableAutoAnswer, getLearnedReliabilityForAutomation } from "../services/automation-settings";
import { LEARNED_RELIABILITY_MINIMUM_SAMPLE, LEARNED_RELIABILITY_THRESHOLD } from "../services/learned-reliability-service";
import type { AutomationSettings } from "../domain/types";
import { categoryLabelOf } from "../lib/category";
import { getLatestCustomerMessageAnalysis } from "../lib/analysis";

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

function matchesLogStatus(actualStatus: string | undefined, requestedStatus: string | undefined) {
  if (!requestedStatus) return true;
  const actual = (actualStatus ?? "UNKNOWN").toUpperCase();
  const requested = requestedStatus.toUpperCase();
  if (["SENT", "DELIVERED", "API_ACCEPTED"].includes(requested)) {
    return ["SENT", "DELIVERED", "API_ACCEPTED"].includes(actual);
  }
  return actual === requested;
}

export const automationRoutes = new Hono();

async function automationSettingsResponse(settings: AutomationSettings) {
  const learnedGate = await getLearnedReliabilityForAutomation();
  const learnedThreshold = settings.learnedReliabilityThreshold ?? Math.round(LEARNED_RELIABILITY_THRESHOLD * 100);

  return {
    ...settings,
    learnedReliability: learnedGate.reliability
      ? { threshold: learnedThreshold / 100, minimumSample: LEARNED_RELIABILITY_MINIMUM_SAMPLE, ...learnedGate.reliability }
      : null,
    learnedReliabilityDecision: {
      allowed: learnedGate.allowed,
      reason: learnedGate.reason,
    },
  };
}

automationRoutes.get("/settings", async (c) => {
  const settings = await store.getAutomationSettings();
  return c.json({ data: await automationSettingsResponse(settings) });
});

automationRoutes.patch("/settings", async (c) => {
  const body = await readJsonObject(c);
  const current = await store.getAutomationSettings();
  const enabled = typeof body.enabled === "boolean" ? body.enabled : current.enabled;
  const emergencyDisable = body.emergencyDisable === true;
  const parseThreshold = (key: string, fallback: number, minimum: number) => {
    if (!(key in body)) return fallback;
    const value = body[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > 100) {
      const label = key === "caseUnderstandingThreshold"
        ? "เกณฑ์ความมั่นใจด้านการเข้าใจเคส"
        : key === "caseDiscriminationThreshold"
          ? "เกณฑ์ความมั่นใจด้านวิธีแก้"
          : "เกณฑ์ความน่าเชื่อถือจากผลตรวจ";
      throw new Error(`${label} ต้องเป็นจำนวนเต็มระหว่าง ${minimum} ถึง 100`);
    }
    return value;
  };
  let caseUnderstandingThreshold: number;
  let caseDiscriminationThreshold: number;
  let learnedReliabilityThreshold: number;
  try {
    caseUnderstandingThreshold = parseThreshold("caseUnderstandingThreshold", current.caseUnderstandingThreshold, 80);
    caseDiscriminationThreshold = parseThreshold("caseDiscriminationThreshold", current.caseDiscriminationThreshold, 80);
    learnedReliabilityThreshold = parseThreshold("learnedReliabilityThreshold", current.learnedReliabilityThreshold, 70);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "ค่า Threshold ไม่ถูกต้อง" }, 400);
  }
  const updatedBy = typeof body.updatedBy === "string" && body.updatedBy.trim().length > 0
    ? body.updatedBy.trim().slice(0, 120)
    : "Tech Support Console";
  const patch = enabled
      ? {
        enabled: true,
        emergencyDisabledAt: undefined,
        caseUnderstandingThreshold,
        caseDiscriminationThreshold,
        learnedReliabilityThreshold,
        updatedBy,
      }
      : {
        enabled: false,
        caseUnderstandingThreshold,
        caseDiscriminationThreshold,
        learnedReliabilityThreshold,
        updatedBy,
      };

  const updated = emergencyDisable
    ? (await emergencyDisableAutoAnswer()).settings
    : await store.updateAutomationSettings(patch);
  return c.json({ data: await automationSettingsResponse(updated) });
});

automationRoutes.get("/solutions", async (c) => {
  const cases = await caseService.listCases();
  const settings = await store.getAutomationSettings();
  const library = typeof store.listAnswerLibrary === "function" ? await store.listAnswerLibrary() : [];
  const librarySourceIds = new Set(library.map((entry) => entry.sourceSolutionId));
  const legacy = cases.flatMap((item) => item.solutions
    .filter((solution) => !librarySourceIds.has(solution.id))
    .map((solution) => ({
      id: solution.id,
      sourceSolutionId: solution.id,
      sourceCaseId: item.id,
      category: getLatestCustomerMessageAnalysis(item.analyses)?.category ?? item.category ?? "อื่นๆ",
      solutionSteps: solution.solutionSteps,
      confidence: solution.confidence,
      validatedByTeam: solution.validatedByTeam,
      validatedAt: solution.validatedAt,
      status: solution.autoAnswerReviewResult === "REJECTED" ? "RETIRED" as const : "ACTIVE" as const,
    })));
  const solutions = [...library, ...legacy]
    .filter((entry) => entry.status === "ACTIVE")
    .filter((entry) => isSolutionReadyForAutoAnswer(undefined, entry, settings))
    .map((entry) => {
      const sourceCase = cases.find((item) => item.id === entry.sourceCaseId);
      return {
        id: entry.id,
        category: categoryLabelOf(entry.category),
        solutionText: entry.solutionSteps.join("\n"),
        caseUnderstandingConfidence: sourceCase?.confidenceScore ?? 0,
        caseDiscriminationConfidence: entry.confidence,
        status: "ready",
      };
    });

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
  const library = typeof store.listAnswerLibrary === "function" ? await store.listAnswerLibrary() : [];
  const logs = cases.flatMap((item) =>
    item.messages
      .filter((message) => message.messageType === "AUTO_ANSWER")
      .map((message) => {
        const solutionId = typeof message.metadata?.autoAnswerSolutionId === "string"
          ? message.metadata.autoAnswerSolutionId
          : undefined;
        const solution = solutionId
          ? item.solutions.find((candidate) => candidate.id === solutionId)
            ?? library.find((candidate) => candidate.sourceSolutionId === solutionId || candidate.id === solutionId)
          : undefined;

        return {
        id: message.id,
        time: message.createdAt,
        caseNumber: item.caseNumber,
        customer: item.customer.displayName ?? "ผู้ใช้งาน LINE",
        answerText: message.originalText,
        eventType: message.messageType ?? "UNKNOWN",
        status: message.deliveryStatus ?? "UNKNOWN",
        answerLibraryId: typeof message.metadata?.autoAnswerLibraryId === "string"
          ? message.metadata.autoAnswerLibraryId
          : undefined,
        solutionText: solution?.solutionSteps.join("\n"),
        teamsNotified: message.metadata?.autoAnswerTeamsNotified === true,
        };
      }),
  )
    .filter((item) => {
      const time = new Date(item.time).getTime();
      const searchable = `${item.caseNumber} ${item.customer} ${item.answerText} ${item.solutionText ?? ""}`.toLocaleLowerCase();
      return (!search || searchable.includes(search))
        && (!eventType || item.eventType === eventType)
        && matchesLogStatus(item.status, status)
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
