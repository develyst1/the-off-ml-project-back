import type { Analysis, Message, Solution } from "../domain/types";
import { store } from "../repositories/store";
import { teamsClient } from "./teams-client";
import { realtimeEventHub } from "./realtime-event-hub";

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
  answerLibraryId?: string;
  analysisId?: string;
  analysisVersion?: number;
};

type RecordAutoAnswerInput = {
  caseId: string;
  answerText: string;
  solutionId: string;
  answerLibraryId?: string;
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
  const answerLibraryId = metadataString(audit, "autoAnswerLibraryId");
  validateOptionalIdentity(answerLibraryId, input.answerLibraryId, "answer_library_identity_mismatch");
  const caseSolution = caseDetail.solutions.find((item) => item.id === solutionId);
  const libraryEntry = caseSolution
    ? undefined
    : (typeof store.listAnswerLibrary === "function"
      ? (await store.listAnswerLibrary()).find((item) => item.sourceSolutionId === solutionId || item.id === solutionId)
      : undefined)
      ?? (await store.listCases())
        .flatMap((item) => item.solutions.map((candidate) => ({ candidate, sourceCase: item })))
        .find(({ candidate }) => candidate.id === solutionId);
  const catalogEntry = libraryEntry && "sourceSolutionId" in libraryEntry ? libraryEntry : undefined;
  const legacyEntry = libraryEntry && !catalogEntry
    ? libraryEntry as { candidate: Solution; sourceCase: NonNullable<Awaited<ReturnType<typeof store.getCaseDetail>>> }
    : undefined;
  const solution = caseSolution ?? (libraryEntry
    ? {
        id: catalogEntry?.sourceSolutionId ?? legacyEntry?.candidate.id ?? solutionId,
        caseId: catalogEntry?.sourceCaseId ?? legacyEntry?.sourceCase.id ?? caseDetail.id,
        rawReplyText: catalogEntry?.rewrittenCustomerText ?? legacyEntry?.candidate.rawReplyText ?? "",
        rootCause: undefined,
        solutionSteps: catalogEntry?.solutionSteps ?? legacyEntry?.candidate.solutionSteps ?? [],
        rewrittenCustomerText: catalogEntry?.rewrittenCustomerText ?? legacyEntry?.candidate.rewrittenCustomerText ?? "",
        confidence: catalogEntry?.confidence ?? legacyEntry?.candidate.confidence ?? 0,
        validatedByTeam: catalogEntry?.validatedByTeam ?? legacyEntry?.candidate.validatedByTeam ?? false,
        validatedAt: catalogEntry?.validatedAt ?? legacyEntry?.candidate.validatedAt,
        validatedBy: catalogEntry?.validatedBy ?? legacyEntry?.candidate.validatedBy,
        createdAt: catalogEntry?.createdAt ?? legacyEntry?.candidate.createdAt ?? new Date().toISOString(),
      }
    : undefined);
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
        answerLibraryId: metadataString(context.audit, "autoAnswerLibraryId"),
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
    const caseDetail = await store.getCaseDetail(input.caseId);
    if (!caseDetail) throw new AutoAnswerNotificationError("case_not_found", 404);

    // Keep the successful LINE Bot reply in the Inbox as well as the case audit.
    // The external identity makes webhook/retry handling idempotent.
    const inboxExternalMessageId = `auto-answer-inbox:${input.sourceMessageId}`;
    let inboxMessage = await store.getInboxMessageByExternalMessageId(inboxExternalMessageId);
    if (!inboxMessage) {
      try {
        inboxMessage = await store.createInboxMessage({
          customerId: caseDetail.customer.id,
          caseId: input.caseId,
          assignedCaseId: input.caseId,
          assignedBy: "AUTO_ANSWER",
          assignedAt: input.sentAt,
          direction: "OUTBOUND",
          senderType: "BOT",
          text: input.answerText,
          externalMessageId: inboxExternalMessageId,
          deliveryStatus: "SENT",
          sentAt: input.sentAt,
          deliveredAt: input.sentAt,
          createdAt: input.sentAt,
        });
      } catch (error) {
        inboxMessage = await store.getInboxMessageByExternalMessageId(inboxExternalMessageId);
        if (!inboxMessage) throw error;
      }
    }

    if (!inboxMessage) throw new Error("AUTO_ANSWER_INBOX_MESSAGE_MISSING");

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
            sourceInboxMessageId: inboxMessage.id,
            autoAnswerSolutionId: input.solutionId,
            autoAnswerLibraryId: input.answerLibraryId,
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
    } else if (audit.metadata?.sourceInboxMessageId !== inboxMessage.id) {
      await store.updateMessage(audit.id, {
        metadata: {
          ...audit.metadata,
          sourceInboxMessageId: inboxMessage.id,
        },
      });
    }

    realtimeEventHub.publish({
      name: "conversation.message.created",
      data: {
        eventId: `inbox:${inboxMessage.id}`,
        messageId: inboxMessage.id,
        conversationId: caseDetail.customer.id,
        userId: caseDetail.customer.id,
        caseId: input.caseId,
        senderType: inboxMessage.senderType,
        createdAt: inboxMessage.createdAt,
        direction: inboxMessage.direction,
      },
    });

    const notification = await notifyTeamsForAutoAnswer({
      caseId: input.caseId,
      caseMessageId: audit.id,
      solutionId: input.solutionId,
      answerLibraryId: input.answerLibraryId,
      analysisId: input.analysisId,
      analysisVersion: input.analysisVersion,
    });
    return { audit, notification };
  });
}
