import type { Analysis, Message, Solution } from "../domain/types";
import { store } from "../repositories/store";
import { teamsClient } from "./teams-client";

export class AutoAnswerNotificationError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: 400 | 404,
  ) {
    super(code);
  }
}

type AutoAnswerAuditIdentity = {
  caseId: string;
  caseMessageId: string;
  solutionId?: string;
  analysisId?: string;
  analysisVersion?: number;
};

type RecordAutoAnswerInput = {
  caseId: string;
  answerText: string;
  solutionId: string;
  analysisId?: string;
  analysisVersion?: number;
  sourceMessageId: string;
  sentAt: string;
};

const recordLocks = new Map<string, Promise<unknown>>();
const notificationLocks = new Map<string, Promise<unknown>>();

async function withLock<T>(locks: Map<string, Promise<unknown>>, key: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(work);
  locks.set(key, current);
  try {
    return await current;
  } finally {
    if (locks.get(key) === current) locks.delete(key);
  }
}

function metadataString(message: Message, key: string) {
  const value = message.metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function metadataNumber(message: Message, key: string) {
  const value = message.metadata?.[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function validateOptionalIdentity<T>(actual: T | undefined, expected: T | undefined, code: string) {
  if (expected !== undefined && actual !== expected) {
    throw new AutoAnswerNotificationError(code, 400);
  }
}

async function getContext(input: AutoAnswerAuditIdentity): Promise<{
  audit: Message;
  analysis?: Analysis;
  solution: Solution;
  caseDetail: NonNullable<Awaited<ReturnType<typeof store.getCaseDetail>>>;
}> {
  const caseDetail = await store.getCaseDetail(input.caseId);
  if (!caseDetail) throw new AutoAnswerNotificationError("case_not_found", 404);

  const audit = caseDetail.messages.find((message) => message.id === input.caseMessageId);
  if (!audit || audit.messageType !== "AUTO_ANSWER") {
    throw new AutoAnswerNotificationError("auto_answer_audit_not_found", 404);
  }

  const solutionId = metadataString(audit, "autoAnswerSolutionId");
  if (!solutionId) throw new AutoAnswerNotificationError("auto_answer_solution_identity_missing", 400);
  validateOptionalIdentity(solutionId, input.solutionId, "solution_identity_mismatch");
  const solution = caseDetail.solutions.find((item) => item.id === solutionId);
  if (!solution) throw new AutoAnswerNotificationError("solution_not_found", 404);

  const analysisId = metadataString(audit, "autoAnswerAnalysisId");
  const analysisVersion = metadataNumber(audit, "autoAnswerAnalysisVersion");
  validateOptionalIdentity(analysisId, input.analysisId, "analysis_identity_mismatch");
  validateOptionalIdentity(analysisVersion, input.analysisVersion, "analysis_version_mismatch");
  const analysis = analysisId && analysisVersion
    ? caseDetail.analyses.find((item) => item.analysisId === analysisId && item.analysisVersion === analysisVersion)
    : undefined;
  if ((analysisId || analysisVersion) && !analysis) {
    throw new AutoAnswerNotificationError("analysis_not_found", 404);
  }

  return { audit, analysis, solution, caseDetail };
}

function deliveryErrorCode(error: unknown) {
  if (error instanceof Error && error.message.includes("not configured")) return "TEAMS_NOT_CONFIGURED";
  if (error instanceof Error && error.message.includes("invalid")) return "TEAMS_CONFIGURATION_INVALID";
  return "TEAMS_DELIVERY_FAILED";
}

export async function notifyTeamsForAutoAnswer(input: AutoAnswerAuditIdentity) {
  return withLock(notificationLocks, input.caseMessageId, async () => {
    const context = await getContext(input);
    if (context.audit.metadata?.autoAnswerTeamsNotified === true) {
      return { caseMessageId: context.audit.id, delivered: true, duplicate: true };
    }
    if (context.audit.metadata?.autoAnswerTeamsNotificationStatus === "SENDING") {
      return { caseMessageId: context.audit.id, delivered: false, duplicate: true };
    }

    await store.updateMessage(context.audit.id, {
      metadata: { autoAnswerTeamsNotificationStatus: "SENDING" },
    });

    let result: { delivered: boolean };
    try {
      result = await teamsClient.notifyAutoAnswer({
        caseId: context.caseDetail.id,
        caseNumber: context.caseDetail.caseNumber,
        caseMessageId: context.audit.id,
        customerName: context.caseDetail.customer.displayName ?? "LINE customer",
        lineUserId: context.caseDetail.customer.lineUserId,
        answerText: context.audit.originalText,
        solutionId: context.solution.id,
        solutionText: context.solution.solutionSteps.join("\n"),
        analysisId: context.analysis?.analysisId,
        analysisVersion: context.analysis?.analysisVersion,
        sentAt: context.audit.sentAt ?? context.audit.createdAt,
        lineDeliveryStatus: context.audit.deliveryStatus ?? "SENT",
      });
    } catch (error) {
      await store.updateMessage(context.audit.id, {
        metadata: {
          autoAnswerTeamsNotified: false,
          autoAnswerTeamsNotificationStatus: "FAILED",
          autoAnswerTeamsNotificationErrorCode: deliveryErrorCode(error),
        },
      });
      return { caseMessageId: context.audit.id, delivered: false, duplicate: false };
    }

    if (!result.delivered) {
      await store.updateMessage(context.audit.id, {
        metadata: {
          autoAnswerTeamsNotified: false,
          autoAnswerTeamsNotificationStatus: "FAILED",
          autoAnswerTeamsNotificationErrorCode: "TEAMS_NOT_CONFIGURED",
        },
      });
      return { caseMessageId: context.audit.id, delivered: false, duplicate: false };
    }

    await store.updateMessage(context.audit.id, {
      metadata: {
        autoAnswerTeamsNotified: true,
        autoAnswerTeamsNotificationStatus: "SENT",
        autoAnswerTeamsNotifiedAt: new Date().toISOString(),
        autoAnswerTeamsNotificationErrorCode: "",
      },
    });
    return { caseMessageId: context.audit.id, delivered: true, duplicate: false };
  });
}

export async function recordAutoAnswerAndNotify(input: RecordAutoAnswerInput) {
  const externalMessageId = `auto-answer:${input.sourceMessageId}`;
  return withLock(recordLocks, externalMessageId, async () => {
    let audit = await store.getMessageByExternalMessageId(externalMessageId);
    if (audit && (audit.caseId !== input.caseId || audit.messageType !== "AUTO_ANSWER")) {
      throw new AutoAnswerNotificationError("auto_answer_audit_identity_conflict", 400);
    }

    if (!audit) {
      try {
        audit = await store.createMessage({
          caseId: input.caseId,
          direction: "outbound_customer",
          channel: "line",
          originalText: input.answerText,
          senderType: "BOT",
          messageType: "AUTO_ANSWER",
          externalMessageId,
          sourceMessageId: input.sourceMessageId,
          deliveryStatus: "sent",
          sentAt: input.sentAt,
          deliveredAt: input.sentAt,
          metadata: {
            autoAnswerSolutionId: input.solutionId,
            autoAnswerAnalysisId: input.analysisId,
            autoAnswerAnalysisVersion: input.analysisVersion,
            autoAnswerSourceMessageId: input.sourceMessageId,
            autoAnswerTeamsNotified: false,
            autoAnswerTeamsNotificationStatus: "PENDING",
          },
        });
      } catch (error) {
        audit = await store.getMessageByExternalMessageId(externalMessageId);
        if (!audit) throw error;
      }
    }

    const notification = await notifyTeamsForAutoAnswer({
      caseId: input.caseId,
      caseMessageId: audit.id,
      solutionId: input.solutionId,
      analysisId: input.analysisId,
      analysisVersion: input.analysisVersion,
    });
    return { audit, notification };
  });
}
