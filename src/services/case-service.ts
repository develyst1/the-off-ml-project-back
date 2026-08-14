import type { CaseAiFeedback, CaseAnalysisContext, CaseDetail, CaseStatus, InboxMessage, Message, MessageChannel, PendingCaseSelection } from "../domain/types";
import { env } from "../config/env";
import { store } from "../repositories/store";
import { aiCenterClient, type CaseHistoryCandidate, type CaseHistoryMatchDecision } from "./ai-center-client";
import { lineClient } from "./line-client";
import { teamsClient } from "./teams-client";
import { realtimeEventHub } from "./realtime-event-hub";
import { inferPendingInformationFields } from "../lib/pending-information";
import { sanitizeCustomerFacingMessage } from "../lib/customer-facing-message";
import { actionableSolutionSteps } from "../lib/solution-quality";
import { isAutoAnswerAllowedForRelevance, isAutoAnswerAllowedForSolution } from "./automation-settings";
import { createHash } from "node:crypto";
import { analysisMessageIdentity } from "../repositories/case-message-normalizer";

const CLOSED_CASE_STATUSES: CaseStatus[] = ["closed", "resolved", "sent_to_customer"];
const CLOSED_INCOMING_CASE_STATUS_VALUES = new Set<string>([
  ...CLOSED_CASE_STATUSES,
  "cancelled",
]);
const RECENT_CLOSED_CASE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

type CaseHistoryMatchResult = {
  action: "ask_customer" | "create_new_case";
  decision: CaseHistoryMatchDecision;
  matchedCase?: CaseDetail;
  prompt?: string;
};

function latestByCreatedAt<T extends { createdAt: string }>(items: T[]) {
  return [...items].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0];
}

function isGenericResolutionOutcome(value: string) {
  return /(ข้อมูล.*อัปเดต.*เรียบร้อย|ใช้งาน.*ได้.*แล้ว|แก้ไข.*เรียบร้อย|ดำเนินการ.*เรียบร้อย|เรียบร้อยแล้ว)/u.test(value.trim());
}

function normalizeExtractedSolutionStep(value: string) {
  return value
    .replace(/\s*ปิดเคส\s+OFF-\d{4}-\d+\b/giu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function contextTime(message: Pick<Message, "createdAt" | "receivedAt" | "metadata">) {
  const sourceCreatedAt = typeof message.metadata?.sourceCreatedAt === "string" ? message.metadata.sourceCreatedAt : undefined;
  return sourceCreatedAt ?? message.receivedAt ?? message.createdAt;
}

function buildCaseAnalysisContext(input: {
  subject: string;
  detail: string;
  messages: Array<Pick<Message, "id" | "senderType" | "originalText" | "createdAt" | "receivedAt" | "metadata">>;
}): CaseAnalysisContext {
  const referenceMessages = input.messages
    .filter((message) => message.metadata?.isCaseReference === true)
    .sort((left, right) => new Date(contextTime(left)).getTime() - new Date(contextTime(right)).getTime() || left.id.localeCompare(right.id))
    .map((message, index) => ({
      messageId: typeof message.metadata?.sourceInboxMessageId === "string" ? message.metadata.sourceInboxMessageId : message.id,
      sender: message.senderType ?? "SYSTEM",
      content: message.originalText,
      createdAt: contextTime(message),
      lineReceivedAt: message.receivedAt,
      sequence: index + 1,
    }));

  return { subject: input.subject, detail: input.detail, referenceMessages };
}

function buildInboxCaseAnalysisContext(input: {
  subject: string;
  detail: string;
  messages: Array<{ id: string; senderType: "CUSTOMER" | "TECH" | "BOT"; text: string; createdAt: string }>;
}): CaseAnalysisContext {
  const referenceMessages = [...input.messages]
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() || left.id.localeCompare(right.id))
    .map((message, index) => ({
      messageId: message.id,
      sender: message.senderType,
      content: message.text,
      createdAt: message.createdAt,
      lineReceivedAt: message.createdAt,
      sequence: index + 1,
    }));
  return { subject: input.subject, detail: input.detail, referenceMessages };
}

function buildConversationCaseAnalysisContext(detail: CaseDetail): {
  context: CaseAnalysisContext;
  messages: Message[];
} {
  const startedAt = new Date(detail.conversationStartedAt ?? detail.createdAt).getTime();
  const endedAt = detail.conversationEndedAt
    ? new Date(detail.conversationEndedAt).getTime()
    : Number.POSITIVE_INFINITY;
  const messages = detail.messages
    .filter((message) => {
      const occurredAt = new Date(message.receivedAt ?? message.sentAt ?? message.deliveredAt ?? message.createdAt).getTime();
      return message.channel === "line"
        && ["CUSTOMER", "TECH", "BOT"].includes(message.senderType ?? "")
        && message.direction !== "INTERNAL"
        && message.messageType !== "SYSTEM_EVENT"
        && message.deliveryStatus?.toUpperCase() !== "FAILED"
        && message.metadata?.isCaseReference !== false
        && occurredAt >= startedAt
        && occurredAt <= endedAt;
    })
    .sort((left, right) => (
      new Date(contextTime(left)).getTime() - new Date(contextTime(right)).getTime()
      || left.id.localeCompare(right.id)
    ));

  const creationEvent = detail.messages.find((message) => message.metadata?.eventType === "CASE_CREATED_FROM_INBOX");
  const creationMetadata = creationEvent?.metadata ?? {};
  const initialDetail = typeof creationMetadata.caseDetail === "string" ? creationMetadata.caseDetail : undefined;
  const context: CaseAnalysisContext = {
    subject: detail.title ?? "",
    detail: detail.problemSummary ?? initialDetail ?? "",
    referenceMessages: messages.map((message, index) => ({
      messageId: message.id,
      sender: message.senderType ?? "SYSTEM",
      content: message.originalText,
      createdAt: contextTime(message),
      lineReceivedAt: message.receivedAt,
      sequence: index + 1,
    })),
  };

  return { context, messages };
}

function similarityScore(left: string, right: string) {
  const leftText = Array.from(left.toLocaleLowerCase().replace(/\s+/g, "")).slice(0, 1200);
  const rightText = Array.from(right.toLocaleLowerCase().replace(/\s+/g, "")).slice(0, 1200);
  if (!leftText.length || !rightText.length) return 0;
  const grams = (characters: string[]) => new Set(
    characters.length < 3 ? [characters.join("")] : characters.slice(0, -2).map((_, index) => characters.slice(index, index + 3).join("")),
  );
  const leftGrams = grams(leftText);
  const rightGrams = grams(rightText);
  let intersection = 0;
  leftGrams.forEach((gram) => { if (rightGrams.has(gram)) intersection += 1; });
  return intersection / Math.max(1, new Set([...leftGrams, ...rightGrams]).size);
}

function diagnosticId(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function logFeedbackMemoryDiagnostic(input: {
  feedback: Array<{
    caseId: string;
    analysisId: string | null;
    analysisVersion: number;
    feedbackType: "ISSUE_UNDERSTANDING" | "SOLUTION_SELECTION";
    result: "CORRECT" | "INCORRECT";
  }>;
  selected: Array<{
    caseId: string;
    analysisId: string | null;
    analysisVersion: number;
    feedbackType: "ISSUE_UNDERSTANDING" | "SOLUTION_SELECTION";
    result: "CORRECT" | "INCORRECT";
  }>;
  excludeCaseId?: string;
}) {
  if (!env.AI_FEEDBACK_MEMORY_DEBUG) return;

  const count = (items: typeof input.feedback, feedbackType: typeof input.feedback[number]["feedbackType"], result: typeof input.feedback[number]["result"]) => (
    items.filter((item) => item.feedbackType === feedbackType && item.result === result).length
  );
  console.info({
    event: "ai_feedback_memory_diagnostic",
    source: "ai_review_feedback",
    understandingCorrectCount: count(input.selected, "ISSUE_UNDERSTANDING", "CORRECT"),
    understandingIncorrectCount: count(input.selected, "ISSUE_UNDERSTANDING", "INCORRECT"),
    solutionCorrectCount: count(input.selected, "SOLUTION_SELECTION", "CORRECT"),
    solutionIncorrectCount: count(input.selected, "SOLUTION_SELECTION", "INCORRECT"),
    fetchedCountByGroup: {
      understandingCorrect: count(input.feedback, "ISSUE_UNDERSTANDING", "CORRECT"),
      understandingIncorrect: count(input.feedback, "ISSUE_UNDERSTANDING", "INCORRECT"),
      solutionCorrect: count(input.feedback, "SOLUTION_SELECTION", "CORRECT"),
      solutionIncorrect: count(input.feedback, "SOLUTION_SELECTION", "INCORRECT"),
    },
    selectedAnalysisReferences: input.selected.map((item) => ({
      caseIdHash: diagnosticId(item.caseId),
      analysisIdHash: item.analysisId ? diagnosticId(item.analysisId) : null,
      analysisVersion: item.analysisVersion,
    })),
    excludedCurrentCase: Boolean(input.excludeCaseId),
    excludedCurrentCaseHash: input.excludeCaseId ? diagnosticId(input.excludeCaseId) : null,
    maxPerGroup: 5,
    confidenceMutated: false,
  });
}

export async function feedbackExamplesForContext(context: CaseAnalysisContext, excludeCaseId?: string) {
  const currentText = [context.subject, context.detail, ...context.referenceMessages.map((message) => message.content)].join("\n");
  const feedback = (await Promise.all([
    ["ISSUE_UNDERSTANDING", "CORRECT"],
    ["ISSUE_UNDERSTANDING", "INCORRECT"],
    ["SOLUTION_SELECTION", "CORRECT"],
    ["SOLUTION_SELECTION", "INCORRECT"],
  ].map(([feedbackType, result]) => store.listAiReviewFeedbackForMemory({
    feedbackType: feedbackType as "ISSUE_UNDERSTANDING" | "SOLUTION_SELECTION",
    result: result as "CORRECT" | "INCORRECT",
    limit: 5,
  })))).flat();
  const ranked = feedback
    .filter((item) => item.caseId !== excludeCaseId)
    .map((item) => ({ item, score: similarityScore(currentText, item.context) }))
    .filter(({ score }) => score >= 0.08)
    .sort((left, right) => right.score - left.score || new Date(right.item.updatedAt).getTime() - new Date(left.item.updatedAt).getTime())
    .slice(0, 5);
  const selected = ranked.map(({ item }) => ({
      feedbackType: item.feedbackType,
      value: item.result,
      aiOutput: item.aiOutput,
      reason: item.reason,
      context: item.context,
  }));
  logFeedbackMemoryDiagnostic({
    feedback: feedback.map((item) => ({
      caseId: item.caseId,
      analysisId: item.analysisId,
      analysisVersion: item.analysisVersion,
      feedbackType: item.feedbackType,
      result: item.result,
    })),
    selected: ranked.map(({ item }) => ({
      caseId: item.caseId,
      analysisId: item.analysisId,
      analysisVersion: item.analysisVersion,
      feedbackType: item.feedbackType,
      result: item.result,
    })),
    excludeCaseId,
  });
  return selected;
}

function caseDetailText(detail: CaseDetail) {
  const definition = detail.messages.find((message) => message.metadata?.eventType === "CASE_CREATED_FROM_INBOX");
  return typeof definition?.metadata?.caseDetail === "string" ? definition.metadata.caseDetail : "";
}

function analysisContextFromDetail(detail: CaseDetail): CaseAnalysisContext {
  const latestCustomerAnalysis = latestByCreatedAt(detail.analyses.filter((analysis) => analysis.analysisType === "customer_message"));
  const rawContext = latestCustomerAnalysis?.rawJson as { caseAnalysisContext?: CaseAnalysisContext } | undefined;
  if (rawContext?.caseAnalysisContext?.subject && Array.isArray(rawContext.caseAnalysisContext.referenceMessages)) {
    return rawContext.caseAnalysisContext;
  }
  return buildCaseAnalysisContext({
    subject: detail.title ?? "",
    detail: caseDetailText(detail),
    messages: detail.messages,
  });
}

function aiSnapshotFromDetail(detail: CaseDetail) {
  const latestCustomerAnalysis = latestByCreatedAt(detail.analyses.filter((analysis) => analysis.analysisType === "customer_message"));
  const rawAnalysis = latestCustomerAnalysis?.rawJson as { extractedSolution?: unknown } | undefined;
  const latestSolution = latestByCreatedAt(detail.solutions);
  const latestTechAnalysis = latestByCreatedAt(detail.analyses.filter((analysis) => analysis.analysisType === "tech_solution"));
  const extractedSolution = latestTechAnalysis?.summary
    || latestSolution?.solutionSteps.join("\n")
    || (typeof rawAnalysis?.extractedSolution === "string" && rawAnalysis.extractedSolution.trim()
      ? rawAnalysis.extractedSolution.trim()
      : undefined);
  return {
    category: latestCustomerAnalysis?.category ?? detail.category,
    summary: latestCustomerAnalysis?.summary,
    solution: extractedSolution === "NO_ACTIONABLE_SOLUTION" ? undefined : extractedSolution,
  };
}

function buildCandidateKeywords(detail: CaseDetail) {
  return [...new Set(`${detail.title ?? ""} ${detail.category ?? ""}`
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((value) => value.length >= 2)
    .slice(0, 12))];
}

function buildCaseHistoryCandidate(detail: CaseDetail): CaseHistoryCandidate {
  const latestCustomerMessage = latestByCreatedAt(detail.messages.filter((message) => message.senderType === "CUSTOMER"));
  const latestSolution = latestByCreatedAt(detail.solutions);
  const latestAnalysis = latestByCreatedAt(detail.analyses.filter((analysis) => analysis.analysisType === "customer_message"));

  return {
    caseId: detail.id,
    caseNumber: detail.caseNumber,
    title: detail.title,
    summary: latestAnalysis?.summary?.slice(0, 500),
    category: detail.category,
    status: detail.status,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    latestCustomerMessage: latestCustomerMessage?.originalText.slice(0, 500),
    latestSolution: latestSolution?.rewrittenCustomerText.slice(0, 500),
    keywords: buildCandidateKeywords(detail),
  };
}

function isRecentClosedCase(detail: CaseDetail) {
  return !CLOSED_CASE_STATUSES.includes(detail.status)
    || Date.now() - new Date(detail.updatedAt).getTime() <= RECENT_CLOSED_CASE_MAX_AGE_MS;
}

function isPendingExpired(selection: PendingCaseSelection) {
  return !selection.expiresAt || new Date(selection.expiresAt).getTime() <= Date.now();
}

function shouldRefreshProblemSummary(text: string) {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) return false;
  if (/^(?:โอเค|โอเคค่ะ|ครับ|ค่ะ|ขอบคุณ|ขอบคุณค่ะ|ได้|ได้ค่ะ|ยังไม่ได้|ยังไม่หาย|ตกลง|รับทราบ|\+|-)$/iu.test(normalized)) return false;
  if (/^(?:เช้า|สาย|เที่ยง|บ่าย|เย็น|ค่ำ|ประมาณ)?\s*\d{1,2}(?::|นาฬิกา|โมง|\.)?\s*\d{0,2}\s*(?:นาที|น\.|โมง)?$/iu.test(normalized)) return false;
  return normalized.length >= 12 || /(รุ่น|อุปกรณ์|iphone|ipad|android|windows|mac|error|รหัส|เชื่อมต่อ|ค้าง|เด้ง|โหลด|ติดตั้ง|เสียง|หน้าจอ|ล็อกอิน|เข้าใช้|ไม่ได้|ไม่สามารถ|ลองแล้ว)/iu.test(normalized);
}

function requiresTechFollowUp(text: string) {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) return false;
  return !/^(?:ขอบคุณ(?:ครับ|ค่ะ|คะ)?|โอเค(?:ครับ|ค่ะ|คะ)?|รับทราบ(?:ครับ|ค่ะ|คะ)?|ได้(?:ครับ|ค่ะ|คะ)?|ตกลง(?:ครับ|ค่ะ|คะ)?|เข้าใจแล้ว(?:ครับ|ค่ะ|คะ)?|เรียบร้อย(?:แล้ว)?(?:ครับ|ค่ะ|คะ)?|ครับ|ค่ะ|คะ|👍|🙏)[.!！]*$/iu.test(normalized);
}

function isTemporaryCategory(category: string | undefined) {
  const normalized = category?.trim().toLocaleLowerCase() ?? "";
  return !normalized
    || ["-", "uncategorized", "ยังไม่ระบุหมวดหมู่", "ต้องการข้อมูลเพิ่มเติม"].includes(normalized);
}

async function updateProblemSummaryForMessage(detail: CaseDetail, message: Pick<Message, "id" | "originalText" | "senderType" | "createdAt">) {
  const customerMessages = [...detail.messages, message]
    .filter((item) => item.senderType === "CUSTOMER")
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime())
    .map((item) => item.originalText);
  const result = await aiCenterClient.generateProblemSummary({
    caseId: detail.id,
    caseTitle: detail.title,
    category: detail.category,
    initialCustomerMessage: customerMessages[0] ?? message.originalText,
    customerMessages,
    latestCustomerMessage: message.originalText,
    analysisSummaries: detail.analyses.filter((item) => item.analysisType === "customer_message").map((item) => item.summary ?? "").filter(Boolean),
    currentProblemSummary: detail.problemSummary,
  });
  const patch: Partial<Omit<CaseDetail, "id" | "customerId" | "createdAt" | "customer" | "messages" | "analyses" | "solutions">> = {
    latestCustomerMessageId: message.id,
    problemSummaryStatus: result.status,
  };
  if (result.status === "SUCCESS" && result.shouldUpdate && result.problemSummary.trim()) {
    patch.problemSummary = result.problemSummary.trim();
    patch.problemSummaryGeneratedAt = new Date().toISOString();
    patch.problemSummarySourceMessageId = message.id;
    patch.problemSummaryVersion = (detail.problemSummaryVersion ?? 0) + 1;
  }
  return store.updateCase(detail.id, patch);
}

function publishCaseAnalysisUpdated(analysis: {
  caseId: string;
  analysisId: string;
  analysisVersion: number;
  createdAt: string;
}) {
  realtimeEventHub.publish({
    name: "case.analysis.updated",
    data: {
      eventId: `case-analysis:${analysis.caseId}:${analysis.analysisId}`,
      caseId: analysis.caseId,
      analysisId: analysis.analysisId,
      analysisVersion: analysis.analysisVersion,
      createdAt: analysis.createdAt,
    },
  });
}

async function extractAndStoreTechSolution(input: {
  detail: CaseDetail;
  messageId: string;
  techReplyText: string;
  rewrittenCustomerText: string;
}) {
  const caseConversationMessages = buildConversationCaseAnalysisContext(input.detail).messages;
  const conversationTranscript = caseConversationMessages
    .map((message) => `${message.senderType === "CUSTOMER" ? "ผู้ใช้งาน" : message.senderType === "TECH" ? "ทีม Tech" : "ระบบ"}: ${message.originalText}`);
  conversationTranscript.push(`ทีม Tech: ${input.techReplyText}`);
  const originalCustomerText = caseConversationMessages.find((item) => item.senderType === "CUSTOMER")?.originalText
    ?? input.detail.problemSummary
    ?? input.detail.title;
  const solutionAnalysis = await aiCenterClient.analyzeTechSolution({
    techReplyText: conversationTranscript.join("\n"),
    originalCustomerText,
  });
  const solutionSteps = solutionAnalysis.hasTroubleshootingSteps === false
    ? []
    : actionableSolutionSteps(solutionAnalysis.solutionSteps);
  const teamActions = [...new Set((solutionAnalysis.teamActions ?? [])
    .map((action) => action.trim())
    .filter(Boolean))];
  // A completed internal action, such as restarting a stuck file-processing
  // service, is the actual resolution even when there is no end-user action
  // to put in `solutionSteps`.
  // Prefer the concrete action completed by Tech Support. A generic outcome
  // such as "ข้อมูลอัปเดตเรียบร้อยแล้ว" explains the result, not the fix.
  const specificSolutionSteps = solutionSteps
    .map(normalizeExtractedSolutionStep)
    .filter((step) => step && !isGenericResolutionOutcome(step));
  const extractedSolutionSteps = [...new Set([...teamActions.map(normalizeExtractedSolutionStep), ...specificSolutionSteps].filter(Boolean))];
  const normalizedSolutionAnalysis = {
    ...solutionAnalysis,
    hasTroubleshootingSteps: extractedSolutionSteps.length > 0,
    solutionSteps: extractedSolutionSteps,
    teamActions,
    rewrittenCustomerText: solutionAnalysis.rewrittenCustomerText.trim() || input.rewrittenCustomerText,
  };

  const savedAnalysis = await store.createAnalysis({
    caseId: input.detail.id,
    messageId: input.messageId,
    analysisType: "tech_solution",
    summary: normalizedSolutionAnalysis.solutionSteps.join("\n") || "NO_ACTIONABLE_SOLUTION",
    category: normalizedSolutionAnalysis.category,
    confidence: normalizedSolutionAnalysis.confidence,
    rawJson: normalizedSolutionAnalysis,
  });
  // A new extraction is a new version of the solution. Keep historical feedback
  // records, but require the team to review the current version independently.
  await store.updateCase(input.detail.id, { solutionSelectionFeedback: undefined });
  if (normalizedSolutionAnalysis.hasTroubleshootingSteps) {
    await store.createSolution({
      caseId: input.detail.id,
      rawReplyText: input.techReplyText,
      rootCause: normalizedSolutionAnalysis.rootCause,
      solutionSteps: normalizedSolutionAnalysis.solutionSteps,
      rewrittenCustomerText: normalizedSolutionAnalysis.rewrittenCustomerText,
      confidence: normalizedSolutionAnalysis.confidence,
      validatedByTeam: false,
    });
  }

  publishCaseAnalysisUpdated(savedAnalysis);

  return normalizedSolutionAnalysis;
}

export const caseService = {
  async composeInboxReply(input: {
    customerId: string;
    mode: "DRAFT" | "REWRITE";
    rawSupportMessage?: string;
  }) {
    const inboxUser = await store.getInboxUser(input.customerId);
    if (!inboxUser) throw new Error("ไม่พบผู้ใช้ใน Inbox");

    const messages = [...inboxUser.messages].sort(
      (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
    );
    const conversationHistory = messages.map((message) => `${message.senderType}: ${message.text}`);
    const customerMessages = messages.filter((message) => message.senderType === "CUSTOMER");
    const techMessages = messages.filter((message) => message.senderType === "TECH").map((message) => message.text);
    const latestCustomerMessage = customerMessages.at(-1)?.text ?? "";

    if (input.mode === "REWRITE") {
      const result = await aiCenterClient.rewriteCustomerReply({
        caseNumber: "",
        caseTitle: "การสนทนาทาง LINE",
        originalCustomerMessage: customerMessages[0]?.text ?? "",
        conversationHistory,
        rawSupportMessage: input.rawSupportMessage?.trim() ?? "",
        mode: "NORMAL_REPLY",
      });
      if (result.usedFallback) throw new Error("AI ช่วยเรียบเรียงข้อความไม่สำเร็จ");
      return { message: result.rewrittenMessage };
    }

    const result = await aiCenterClient.composeCustomerReply({
      mode: "CUSTOMER_REPLY",
      caseNumber: "",
      caseTitle: "การสนทนาทาง LINE",
      originalCustomerMessage: customerMessages[0]?.text ?? "",
      latestCustomerMessage,
      conversationHistory,
      customerProvidedInformation: customerMessages.slice(1).map((message) => message.text),
      previouslyRequestedInformation: [],
      previousReplies: techMessages,
      caseSummary: latestCustomerMessage,
      currentCaseStatus: "INBOX_PENDING_REVIEW",
    });
    if (result.usedFallback) throw new Error("AI สร้างร่างคำตอบไม่สำเร็จ");
    return { message: result.suggestedMessage };
  },

  async composeInboxCaseDraft(input: {
    customerId: string;
    mode: "DRAFT" | "REWRITE";
    selectedMessageIds: string[];
    title?: string;
    description?: string;
  }) {
    const inboxUser = await store.getInboxUser(input.customerId);
    if (!inboxUser) throw new Error("ไม่พบผู้ใช้ใน Inbox");
    const selectedIds = new Set(input.selectedMessageIds);
    const selectedMessages = inboxUser.messages.filter((message) => selectedIds.has(message.id));
    const conversationContext = selectedMessages.map((message) => `${message.senderType === "CUSTOMER" ? "ผู้ใช้งาน" : "ทีม Tech"}: ${message.text}`);
    const sourceText = input.mode === "REWRITE"
      ? [input.title?.trim(), input.description?.trim(), ...conversationContext].filter(Boolean).join("\n")
      : conversationContext.join("\n");
    if (!sourceText.trim()) throw new Error("กรุณากรอกข้อมูลเคสหรือเลือกข้อความจากแชทก่อนใช้ AI");

    const latestCustomerMessage = [...selectedMessages].reverse().find((message) => message.senderType === "CUSTOMER")?.text ?? sourceText;
    const analysis = await aiCenterClient.analyzeCustomerMessage({
      text: latestCustomerMessage,
      conversationContext,
    });
    return {
      title: analysis.caseTitle?.trim() || input.title?.trim() || latestCustomerMessage.slice(0, 120),
      description: analysis.summary?.trim() || input.description?.trim() || sourceText,
    };
  },

  async openCaseFromInbox(customerId: string, input: {
    title?: string;
    description?: string;
    from?: string;
    to?: string;
    selectedMessageIds?: string[];
  } = {}) {
    const inboxUser = await store.getInboxUser(customerId);
    if (!inboxUser || inboxUser.messages.length === 0) {
      throw new Error("ยังไม่มีข้อความสำหรับเปิดเคส");
    }

    const latestMessageAt = Math.max(...inboxUser.messages.map((message) => new Date(message.createdAt).getTime()));
    const from = input.from ? new Date(input.from) : new Date(latestMessageAt - 24 * 60 * 60 * 1000);
    const to = input.to ? new Date(input.to) : new Date();
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
      throw new Error("ช่วงเวลาที่เลือกไม่ถูกต้อง");
    }
    if (to.getTime() - from.getTime() > 14 * 24 * 60 * 60 * 1000) {
      throw new Error("เลือกช่วงประวัติสนทนาได้ครั้งละไม่เกิน 14 วัน");
    }

    const messagesInRange = inboxUser.messages.filter((message) => {
      const timestamp = new Date(message.createdAt).getTime();
      return timestamp >= from.getTime() && timestamp <= to.getTime();
    });
    const conversationStartedAt = from.toISOString();
    const openedAt = new Date();
    const timelineMessages = inboxUser.messages.filter((message) => {
      const timestamp = new Date(message.createdAt).getTime();
      return timestamp >= from.getTime() && timestamp <= openedAt.getTime();
    });
    const hasManualCaseDetails = Boolean(input.title?.trim() && input.description?.trim());
    const selectedIds = input.selectedMessageIds?.length ? new Set(input.selectedMessageIds) : undefined;
    if (!hasManualCaseDetails && !selectedIds) {
      throw new Error("กรุณากรอกหัวข้อปัญหาและรายละเอียด หรือเลือกข้อความจากแชทอย่างน้อย 1 รายการเพื่อเปิดเคส");
    }
    const sourceMessages = selectedIds
      ? messagesInRange.filter((message) => selectedIds.has(message.id))
      : [];
    if (selectedIds && sourceMessages.length !== selectedIds.size) {
      throw new Error(selectedIds ? "กรุณาเลือกข้อความอย่างน้อย 1 รายการ" : "ไม่พบข้อความในช่วงเวลาที่เลือก");
    }

    const latestInbound = [...sourceMessages].reverse().find((message) => message.senderType === "CUSTOMER");
    const generatedDraft = hasManualCaseDetails
      ? undefined
      : await caseService.composeInboxCaseDraft({
        customerId,
        mode: "DRAFT",
        selectedMessageIds: selectedIds ? [...selectedIds] : [],
      });
    const resolvedTitle = input.title?.trim() || generatedDraft?.title;
    const resolvedDescription = input.description?.trim() || generatedDraft?.description;
    if (!resolvedTitle || !resolvedDescription) {
      throw new Error("ไม่สามารถสร้างข้อมูลเคสจากข้อความที่เลือกได้");
    }
    const caseAnalysisContext = buildInboxCaseAnalysisContext({
      subject: resolvedTitle,
      detail: resolvedDescription,
      // Only messages selected in the open-case modal are reference context
      // for the initial AI analysis. The complete range remains the case
      // timeline, but must not dilute the selected problem evidence.
      messages: sourceMessages,
    });
    const feedbackExamples = await feedbackExamplesForContext(caseAnalysisContext);
    const supportCase = await store.createCase({
      customerId,
      status: "analyzing",
      title: resolvedTitle,
      conversationStartedAt,
    });
    // Persist the new active case immediately after creation so an error in a
    // later analysis or Teams step cannot leave the conversation pointing at
    // the previous case (or no case at all).
    await store.setActiveCase(customerId, supportCase.id);

    if (selectedIds) {
      const assignedMessages = await store.assignInboxMessagesToCase([...selectedIds], {
        caseId: supportCase.id,
        assignedBy: "SYSTEM_OPEN_CASE",
        allowReassignment: true,
      });
      for (const message of assignedMessages) {
        realtimeEventHub.publish({
          name: "conversation.message.created",
          data: {
            eventId: `case:${supportCase.id}:assign:${message.id}`,
            messageId: message.id,
            conversationId: customerId,
            userId: customerId,
            caseId: supportCase.id,
            senderType: message.senderType,
            createdAt: message.createdAt,
            direction: message.direction,
          },
        });
      }
    }

    const copiedMessages = [] as Message[];
    for (const inboxMessage of timelineMessages) {
      const isCaseReference = selectedIds?.has(inboxMessage.id) ?? false;
      copiedMessages.push(await store.createMessage({
        caseId: supportCase.id,
        direction: inboxMessage.senderType === "CUSTOMER" ? "inbound_customer" : "outbound_tech",
        channel: "line",
        originalText: inboxMessage.text,
        senderType: inboxMessage.senderType === "CUSTOMER" ? "CUSTOMER" : inboxMessage.senderType === "BOT" ? "BOT" : "TECH",
        messageType: inboxMessage.senderType === "CUSTOMER" ? "CUSTOMER_MESSAGE" : inboxMessage.senderType === "BOT" ? "CASE_ACKNOWLEDGEMENT" : "TECH_GENERAL_MESSAGE",
        deliveryStatus: inboxMessage.senderType === "CUSTOMER" ? "RECEIVED" : inboxMessage.deliveryStatus ?? "SENT",
        receivedAt: inboxMessage.createdAt,
        sentAt: inboxMessage.sentAt ?? (inboxMessage.senderType === "CUSTOMER" ? undefined : inboxMessage.createdAt),
        deliveredAt: inboxMessage.deliveredAt,
        metadata: {
          isCaseReference,
          sourceInboxMessageId: inboxMessage.id,
          source: inboxMessage.senderType === "TECH" ? "tech_console" : inboxMessage.senderType === "BOT" ? "line_bot" : "line",
          sourceCreatedAt: inboxMessage.createdAt,
          linkedAt: new Date().toISOString(),
        },
      }));
    }

    if (selectedIds) {
      await store.createMessage({
        caseId: supportCase.id,
        direction: "INTERNAL",
        channel: "system",
        originalText: "บันทึกข้อความที่เลือกไว้เป็นข้อมูลอ้างอิงของเคส",
        // This is the LINE message sent by Tech Support, not the internal
        // CASE_CLOSED audit event created above. Keep it visible in the
        // conversation timeline after delivery succeeds.
        senderType: "TECH",
        contentType: "SYSTEM_EVENT",
        messageType: "SYSTEM_EVENT",
        deliveryStatus: "PROCESSED",
        metadata: {
          source: "SYSTEM",
          selectedInboxMessageIds: [...selectedIds],
        },
      });
    }

    if (resolvedDescription) {
      await store.createMessage({
        caseId: supportCase.id,
        direction: "INTERNAL",
        channel: "system",
        originalText: resolvedDescription,
        senderType: "SYSTEM",
        messageType: "SYSTEM_EVENT",
        deliveryStatus: "PROCESSED",
      });
    }

    await store.createMessage({
      caseId: supportCase.id,
      direction: "INTERNAL",
      channel: "system",
      originalText: "Case created from Inbox modal",
      senderType: "SYSTEM",
      contentType: "SYSTEM_EVENT",
      messageType: "SYSTEM_EVENT",
      deliveryStatus: "PROCESSED",
      metadata: {
        eventType: "CASE_CREATED_FROM_INBOX",
        caseSubject: resolvedTitle,
        caseDetail: resolvedDescription,
        selectedInboxMessageIds: selectedIds ? [...selectedIds] : [],
      },
    });

    {
      const sourceMessage = copiedMessages.filter((message) => message.senderType === "CUSTOMER").at(-1);
      const conversationContext = sourceMessages.map((message) => `${message.senderType === "CUSTOMER" ? "ผู้ใช้งาน" : "ทีม Tech"}: ${message.text}`);
      const analysis = await aiCenterClient.analyzeCustomerMessage({
        text: `${resolvedTitle}\n${resolvedDescription}`,
        caseAnalysisContext,
        feedbackExamples,
        conversationContext,
      });
      const savedAnalysis = await store.createAnalysis({
        caseId: supportCase.id,
        messageId: sourceMessage?.id,
        analysisType: "customer_message",
        summary: analysis.summary,
        category: analysis.category,
        confidence: analysis.confidence,
        rawJson: {
          ...analysis,
          analysisMode: "INITIAL_CASE_ANALYSIS",
          caseAnalysisContext,
          sourceMessageIds: copiedMessages
            .filter((message) => message.metadata?.isCaseReference === true)
            .map(analysisMessageIdentity),
          feedbackExamples,
        },
      });
      await store.updateCase(supportCase.id, {
        status: "awaiting_tech",
        title: resolvedTitle,
        category: analysis.category,
        priority: analysis.urgency,
        confidenceScore: analysis.confidence,
        customerSentAt: latestInbound?.createdAt,
        systemReceivedAt: new Date().toISOString(),
        aiAnalyzedAt: new Date().toISOString(),
        initialCustomerMessageId: copiedMessages.find((message) => message.senderType === "CUSTOMER")?.id,
        latestCustomerMessageId: sourceMessage?.id,
      });
      publishCaseAnalysisUpdated(savedAnalysis);
    }

    // The selected messages are the opening context; new messages are linked only
    // after this point while the case remains active.
    await store.setConversationState(customerId, "ACTIVE_CASE_CONVERSATION");

    const detail = await store.getCaseDetail(supportCase.id);
    if (!detail) throw new Error("Case detail missing after opening inbox conversation");
    try {
      await teamsClient.notifyCase(detail);
      await store.createMessage({
        caseId: supportCase.id,
        direction: "INTERNAL",
        channel: "system",
        originalText: `ส่งรายละเอียดเคส ${supportCase.caseNumber} ให้ทีม Tech Support ผ่าน Microsoft Teams แล้ว`,
        senderType: "SYSTEM",
        messageType: "CASE_FORWARDED",
        deliveryStatus: "PROCESSED",
      });
      await store.updateCase(supportCase.id, {
        teamsDeliveryStatus: "accepted",
        teamsDeliveryAt: new Date().toISOString(),
        teamsSentAt: new Date().toISOString(),
      });
    } catch (error) {
      await store.updateCase(supportCase.id, {
        teamsDeliveryStatus: "failed",
        teamsDeliveryAt: new Date().toISOString(),
        teamsDeliveryError: error instanceof Error ? error.message : String(error),
      });
    }
    return store.getCaseDetail(supportCase.id);
  },
  formatCaseTitle(detail: { title?: string; category?: string; messages: { direction: string; originalText: string; senderType?: string }[] }) {
    if (detail.title?.trim()) return detail.title.trim();
    const original = detail.messages.find((message) => message.senderType === "CUSTOMER")?.originalText ?? detail.category ?? "Tech Support";
    return original.trim();
  },
  async resolveIncomingCaseId(customerId: string) {
    const inboxUser = await store.getInboxUser(customerId);
    const allCases = inboxUser?.cases ?? [];
    const openCases = allCases.filter((item) => !CLOSED_INCOMING_CASE_STATUS_VALUES.has(item.status));
    const activeCaseId = inboxUser?.customer.activeCaseId;
    const activeCase = activeCaseId ? allCases.find((item) => item.id === activeCaseId) : undefined;
    const activeCaseIsOpen = Boolean(activeCase && !CLOSED_INCOMING_CASE_STATUS_VALUES.has(activeCase.status));
    let selectedCaseId: string | undefined;
    let assignmentReason: "ACTIVE_CASE_VALID" | "SINGLE_OPEN_CASE" | "MULTIPLE_OPEN_CASES" | "NO_OPEN_CASE" | "STALE_ACTIVE_CASE" | "ACTIVE_CASE_NOT_OWNED_BY_USER";

    if (activeCaseId && activeCase && !activeCaseIsOpen) {
      await store.setActiveCase(customerId);
      assignmentReason = "STALE_ACTIVE_CASE";
      if (openCases.length === 1) {
        selectedCaseId = openCases[0]?.id;
        if (selectedCaseId) await store.setActiveCase(customerId, selectedCaseId);
      }
    } else if (activeCaseId && !activeCase) {
      await store.setActiveCase(customerId);
      assignmentReason = "ACTIVE_CASE_NOT_OWNED_BY_USER";
      if (openCases.length === 1) {
        selectedCaseId = openCases[0]?.id;
        if (selectedCaseId) await store.setActiveCase(customerId, selectedCaseId);
      }
    } else if (activeCaseIsOpen && openCases.length === 1) {
      selectedCaseId = activeCase?.id;
      assignmentReason = "ACTIVE_CASE_VALID";
    } else if (openCases.length === 1) {
      selectedCaseId = openCases[0]?.id;
      assignmentReason = "SINGLE_OPEN_CASE";
      if (selectedCaseId) await store.setActiveCase(customerId, selectedCaseId);
    } else if (openCases.length > 1) {
      assignmentReason = "MULTIPLE_OPEN_CASES";
    } else {
      assignmentReason = "NO_OPEN_CASE";
    }

    console.info({
      event: "line_incoming_case_assignment",
      lineUserId: inboxUser?.customer.lineUserId,
      conversationId: customerId,
      activeCaseId,
      activeCaseFound: Boolean(activeCase),
      activeCaseStatus: activeCase?.status,
      openCaseIds: openCases.map((item) => item.id),
      openCaseStatuses: openCases.map((item) => item.status),
      openCaseCount: openCases.length,
      selectedCaseId,
      assignmentReason,
    });

    return selectedCaseId;
  },

  async linkInboxMessageToActiveCase(customerId: string, inboxMessage: InboxMessage, forcedCaseId?: string) {
    const activeCaseId = forcedCaseId ?? await caseService.resolveIncomingCaseId(customerId);
    if (!activeCaseId) return undefined;

    const detail = await store.getCaseDetail(activeCaseId);
    if (!detail || CLOSED_INCOMING_CASE_STATUS_VALUES.has(detail.status)) return undefined;
    if (detail.messages.some((message) => message.metadata?.sourceInboxMessageId === inboxMessage.id)) return detail;
    await store.assignInboxMessageToCase(inboxMessage.id, {
      caseId: activeCaseId,
      assignedBy: "SYSTEM_ACTIVE_CASE",
    });

    const isCustomer = inboxMessage.senderType === "CUSTOMER";
    const isBot = inboxMessage.senderType === "BOT";
    await store.createMessage({
      caseId: activeCaseId,
      direction: isCustomer ? "inbound_customer" : "OUTBOUND",
      channel: "line",
      originalText: inboxMessage.text,
      senderType: isCustomer ? "CUSTOMER" : isBot ? "BOT" : "TECH",
      contentType: "TEXT",
      messageType: isCustomer ? "CUSTOMER_ADDITIONAL_INFO" : "CUSTOMER_REPLY",
      isVisibleToCustomer: inboxMessage.deliveryStatus !== "FAILED",
      deliveryStatus: isCustomer ? "RECEIVED" : inboxMessage.deliveryStatus ?? "SENT",
      deliveryError: inboxMessage.deliveryError,
      externalMessageId: inboxMessage.externalMessageId,
      webhookEventId: inboxMessage.webhookEventId,
      receivedAt: isCustomer ? inboxMessage.createdAt : undefined,
      sentAt: inboxMessage.sentAt ?? (!isCustomer ? inboxMessage.createdAt : undefined),
      deliveredAt: inboxMessage.deliveredAt,
      metadata: {
        source: isCustomer ? "line" : "tech_console",
        sourceInboxMessageId: inboxMessage.id,
        sourceCreatedAt: inboxMessage.createdAt,
        assignedAt: inboxMessage.assignedAt,
      },
    });
    return store.getCaseDetail(activeCaseId);
  },

  async getCustomerCases(customerId: string) {
    return (await store.listCases())
      .filter((item) => item.customerId === customerId)
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  },

  async findReopenCandidates(customerId: string, text: string): Promise<CaseDetail[]> {
    const normalized = text.trim().toLowerCase();
    const terms = normalized
      .replace(/เปิดเคส|เคสที่|ของฉัน|ปัญหาเดิม|เรื่องที่แจ้ง|ยังไม่หาย|ขอเปิด|กลับมาตรวจสอบ/g, " ")
      .split(/\s+/)
      .filter((term) => term.length >= 2);
    const allCases = await this.getCustomerCases(customerId);
    const closedCases = allCases.filter((item) => ["closed", "sent_to_customer", "resolved"].includes(item.status));
    const cases = closedCases.length > 0 ? closedCases : allCases;
    const scored = cases.map((item) => {
      const searchable = [
        item.title,
        item.category,
        ...item.messages.map((message) => message.originalText),
        ...item.analyses.map((analysis) => analysis.summary),
      ].filter(Boolean).join(" ").toLowerCase();
      const matches = terms.filter((term) => searchable.includes(term)).length;
      const recency = Math.max(0, 10 - Math.floor((Date.now() - new Date(item.updatedAt).getTime()) / 86400000));
      return { item, score: matches * 100 + recency };
    });
    return scored
      .sort((left, right) => right.score - left.score)
      .slice(0, 3)
      .map(({ item }) => item);
  },

  selectionPrompt(cases: CaseDetail[]) {
    const rows = cases.map((item, index) => {
      const date = new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", year: "numeric" }).format(new Date(item.updatedAt));
      return `${index + 1}. ${caseService.formatCaseTitle(item)}\n   ปิด/อัปเดตเมื่อ ${date}`;
    });
    return `พบเคสที่ใกล้เคียงค่ะ ต้องการเปิดเรื่องไหนกลับมาตรวจสอบต่อคะ?\n\n${rows.join("\n\n")}\n\nพิมพ์เลข 1, 2 หรือ 3 ได้เลยค่ะ`;
  },

  confirmationPrompt(detail: CaseDetail) {
    const date = new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", year: "numeric" }).format(new Date(detail.createdAt));
    return `หมายถึงเคสนี้ใช่ไหมคะ?\n\n${detail.caseNumber}\nเรื่อง: ${caseService.formatCaseTitle(detail)}\nแจ้งเมื่อ: ${date}\n\nตอบ “ใช่” เพื่อเปิดเคสกลับมาตรวจสอบต่อ หรือพิมพ์ “ไม่ใช่” เพื่อเลือกเรื่องอื่นค่ะ`;
  },

  async setPendingCaseSelection(customerId: string, candidateCaseIds: string[], selectedCaseId?: string) {
    const selection: PendingCaseSelection = {
      mode: selectedCaseId ? "confirm" : "choose",
      candidateCaseIds,
      selectedCaseId,
      createdAt: new Date().toISOString(),
    };
    return store.setPendingCaseSelection(customerId, selection);
  },

  async setPendingInformationRequest(input: {
    customerId: string;
    caseId: string;
    questionType: "AI_MISSING_INFORMATION" | "TECH_REQUEST";
    requestedFields: string[];
  }) {
    const timestamp = new Date().toISOString();
    const requestedFields = input.requestedFields.length > 0
      ? inferPendingInformationFields(input.requestedFields)
      : ["additionalDetails"];
    await store.setPendingCaseSelection(input.customerId, {
      mode: "request_more_info",
      candidateCaseIds: [input.caseId],
      selectedCaseId: input.caseId,
      pendingAction: "REQUEST_MORE_INFO",
      pendingCaseId: input.caseId,
      pendingQuestionType: input.questionType,
      pendingRequestedFields: requestedFields,
      pendingCollectedFields: {},
      pendingCreatedAt: timestamp,
      createdAt: timestamp,
    });
    await store.setActiveCase(input.customerId, input.caseId);
    await store.setConversationState(input.customerId, "ACTIVE_CASE_CONVERSATION");
  },

  async reopenCase(customerId: string, caseId: string) {
    const detail = await store.getCaseDetail(caseId);
    if (!detail || detail.customerId !== customerId) throw new Error("Case not found");
    await store.updateCase(caseId, { status: "reopened", conversationEndedAt: undefined });
    await store.setPendingCaseSelection(customerId);
    await store.setActiveCase(customerId, caseId);
    const text = `เปิดเคส ${detail.caseNumber} กลับมาแล้วค่ะ เดี๋ยวทีมงานช่วยตรวจสอบต่อให้นะคะ`;
    const delivery = await lineClient.reply({ lineUserId: detail.customer.lineUserId, text });
    await store.createMessage({ caseId, direction: "outbound_customer", channel: "line", originalText: text, senderType: "BOT", messageType: "STATUS_UPDATE", deliveryStatus: delivery.delivered ? "delivered" : "pending" });
    return store.getCaseDetail(caseId);
  },
  async getActiveLineCase(customer: { id: string; activeCaseId?: string }) {
    const activeStatuses = ["analyzing", "awaiting_tech", "assigned", "tech_replied", "analyzing_solution", "awaiting_customer_info", "awaiting_confirmation", "reopened", "in_progress", "awaiting_tech_review"];
    if (customer.activeCaseId) {
      const activeCase = await store.getCaseDetail(customer.activeCaseId);
      if (activeCase && activeCase.customerId === customer.id && activeStatuses.includes(activeCase.status)) {
        return activeCase;
      }
    }

    return (await store.listCases())
      .filter((item) => item.customerId === customer.id && activeStatuses.includes(item.status))
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())[0];
  },

  async getCaseHistoryCandidates(customerId: string) {
    return (await this.getCustomerCases(customerId))
      .filter(isRecentClosedCase)
      .slice(0, env.CASE_MATCH_CANDIDATE_LIMIT);
  },

  async matchLineMessageAgainstHistory(input: {
    customerId: string;
    text: string;
    externalMessageId?: string;
    webhookEventId?: string;
    receivedAt?: string;
  }): Promise<CaseHistoryMatchResult> {
    const cases = await this.getCaseHistoryCandidates(input.customerId);
    const candidates = cases.map(buildCaseHistoryCandidate);
    const decision = await aiCenterClient.matchCustomerCaseHistory({
      newCustomerText: input.text,
      candidates,
    });
    const matchedCase = decision.matchedCaseId
      ? cases.find((item) => item.id === decision.matchedCaseId)
      : undefined;
    const shouldAskCustomer = Boolean(
      matchedCase
      && decision.confidence >= env.CASE_MATCH_CONFIDENCE_THRESHOLD
      && (
        (decision.intent === "CONTINUE_CASE" && decision.isSameProblem)
        || decision.intent === "UNCERTAIN"
      ),
    );
    const log = await store.createCaseMatchLog({
      customerId: input.customerId,
      incomingMessage: input.text,
      candidateCaseIds: candidates.map((candidate) => candidate.caseId),
      aiIntent: decision.intent,
      matchedCaseId: matchedCase?.id,
      confidence: decision.confidence,
      reason: decision.reason,
      finalUserDecision: shouldAskCustomer ? undefined : "auto_new_case",
    });

    if (!shouldAskCustomer || !matchedCase) {
      return { action: "create_new_case", decision, matchedCase };
    }

    const expiresAt = new Date(Date.now() + env.CASE_MATCH_PENDING_TTL_MINUTES * 60 * 1000).toISOString();
    await store.setPendingCaseSelection(input.customerId, {
      mode: "case_history_match",
      candidateCaseIds: candidates.map((candidate) => candidate.caseId),
      selectedCaseId: matchedCase.id,
      matchedCaseId: matchedCase.id,
      pendingText: input.text,
      matchConfidence: decision.confidence,
      matchReason: decision.reason,
      matchLogId: log.id,
      externalMessageId: input.externalMessageId,
      webhookEventId: input.webhookEventId,
      receivedAt: input.receivedAt,
      expiresAt,
      createdAt: new Date().toISOString(),
    });

    const isClosed = CLOSED_CASE_STATUSES.includes(matchedCase.status);
    const prompt = isClosed
      ? `ปัญหานี้คล้ายกับเคส ${matchedCase.caseNumber} ที่ปิดไปแล้วค่ะ\nเรื่อง: ${this.formatCaseTitle(matchedCase)}\n\nต้องการตรวจสอบต่อจากเคสเดิม หรือเปิดเป็นเคสใหม่คะ? ตอบ “เคสเดิม” หรือ “เคสใหม่” ได้เลยค่ะ`
      : `ดูเหมือนปัญหานี้อาจเกี่ยวข้องกับเคสเดิมค่ะ\nหมายเลขเคส: ${matchedCase.caseNumber}\nเรื่อง: ${this.formatCaseTitle(matchedCase)}\n\nต้องการคุยต่อในเคสเดิม หรือเปิดเป็นเคสใหม่คะ? ตอบ “เคสเดิม” หรือ “เคสใหม่” ได้เลยค่ะ`;

    return { action: "ask_customer", decision, matchedCase, prompt };
  },

  async resolvePendingCaseHistoryMatch(input: {
    customerId: string;
    selection: PendingCaseSelection;
    decision: "continue_existing_case" | "create_new_case" | "expired";
  }) {
    if (input.selection.matchLogId) {
      await store.updateCaseMatchLogDecision(input.selection.matchLogId, input.decision);
    }
    await store.setPendingCaseSelection(input.customerId);
  },

  async requestCaseSplitConfirmation(input: {
    caseId: string;
    text: string;
    relation: { confidence: number; reason: string };
    externalMessageId?: string;
    webhookEventId?: string;
    receivedAt?: string;
  }) {
    const detail = await store.getCaseDetail(input.caseId);
    if (!detail) throw new Error("Case not found");

    await store.setPendingCaseSelection(detail.customerId, {
      mode: "case_split_confirmation",
      candidateCaseIds: [detail.id],
      selectedCaseId: detail.id,
      pendingText: input.text,
      previousCaseStatus: detail.status,
      externalMessageId: input.externalMessageId,
      webhookEventId: input.webhookEventId,
      receivedAt: input.receivedAt,
      createdAt: new Date().toISOString(),
    });
    await store.updateCase(input.caseId, { status: "awaiting_confirmation" });
    return store.getCaseDetail(input.caseId);
  },

  async findRelatedLineCase(input: { customerId: string; newText: string; receivedAt?: string; minimumConfidence?: number }) {
    const cases = (await store.listCases())
      .filter((item) => item.customer.id === input.customerId && ["analyzing", "awaiting_tech", "assigned", "tech_replied", "analyzing_solution", "awaiting_customer_info", "awaiting_confirmation", "reopened", "in_progress", "awaiting_tech_review"].includes(item.status))
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
    const candidate = cases[0];
    if (!candidate) return undefined;

    const customerMessages = candidate.messages.filter((message) => message.senderType === "CUSTOMER");
    const originalCustomerText = customerMessages[0]?.originalText ?? candidate.problemSummary ?? candidate.title;
    if (!originalCustomerText) return undefined;

    const latestActivity = candidate.messages.reduce((latest, message) => {
      return Math.max(latest, new Date(message.createdAt).getTime());
    }, new Date(candidate.updatedAt).getTime());
    const receivedAt = input.receivedAt ? new Date(input.receivedAt).getTime() : Date.now();
    const elapsedHours = Math.max(0, (receivedAt - latestActivity) / (1000 * 60 * 60));
    const relation = await aiCenterClient.analyzeCaseRelation({
      originalCustomerText,
      caseCategory: candidate.category,
      recentConversation: candidate.messages.slice(-6).map((message) => `${message.direction}: ${message.originalText}`),
      newCustomerText: input.newText,
      elapsedHours,
      caseStatus: candidate.status,
    });

    console.log({
      event: "line_case_relation_decision",
      caseId: candidate.id,
      elapsedHours: Number(elapsedHours.toFixed(2)),
      related: relation.related,
      confidence: relation.confidence,
      reason: relation.reason,
    });

    return relation.related && relation.confidence >= (input.minimumConfidence ?? 0)
      ? candidate
      : undefined;
  },

  async appendLineMessageToCase(input: {
    caseId: string;
    text: string;
    resolvedText?: string;
    externalMessageId?: string;
    webhookEventId?: string;
    receivedAt?: string;
    notifyTech?: boolean;
    customerOutcome?: "ISSUE_RESOLVED" | "ISSUE_IMPROVED";
    outcomeConfidence?: number;
  }) {
    const detail = await store.getCaseDetail(input.caseId);
    if (!detail) throw new Error("Case not found");

    // Preserve the raw customer message, but give AI the topic-resolved meaning
    // when a short reply depends on the preceding conversation.
    const contextualText = input.resolvedText?.trim() || input.text;
    const shouldNotifyTech = input.notifyTech ?? requiresTechFollowUp(contextualText);

    const receivedAt = input.receivedAt ?? new Date().toISOString();
    const inboxMessage = await store.createInboxMessage({
      customerId: detail.customer.id,
      caseId: input.caseId,
      assignedCaseId: input.caseId,
      assignedBy: "SYSTEM_ACTIVE_CASE",
      assignedAt: new Date().toISOString(),
      direction: "INBOUND",
      senderType: "CUSTOMER",
      text: input.text,
      externalMessageId: input.externalMessageId,
      webhookEventId: input.webhookEventId,
      deliveryStatus: "DELIVERED",
      createdAt: receivedAt,
    });

    const message = await store.createMessage({
      caseId: input.caseId,
      direction: "inbound_customer",
      channel: "line",
      originalText: input.text,
      externalMessageId: input.externalMessageId,
      senderType: "CUSTOMER",
      messageType: "CUSTOMER_ADDITIONAL_INFO",
      normalizedText: input.text.trim().replace(/\s+/g, " "),
      webhookEventId: input.webhookEventId,
      receivedAt,
      metadata: {
        source: "line",
        sourceInboxMessageId: inboxMessage.id,
        sourceCreatedAt: receivedAt,
      },
    });
    realtimeEventHub.publish({
      name: "conversation.message.created",
      data: {
        eventId: `line:${input.webhookEventId ?? input.externalMessageId ?? inboxMessage.id}`,
        messageId: inboxMessage.id,
        conversationId: detail.customer.id,
        userId: detail.customer.id,
        caseId: inboxMessage.caseId,
        senderType: inboxMessage.senderType,
        createdAt: inboxMessage.createdAt,
        direction: inboxMessage.direction,
      },
    });
    const shouldAnalyze = shouldRefreshProblemSummary(contextualText);
    const currentConversationDetail = { ...detail, messages: [...detail.messages, message] };
    const currentAnalysisContext = shouldAnalyze
      ? buildConversationCaseAnalysisContext(currentConversationDetail)
      : undefined;
    const currentFeedbackExamples = currentAnalysisContext
      ? await feedbackExamplesForContext(currentAnalysisContext.context, input.caseId)
      : undefined;
    const currentConversation = currentAnalysisContext?.messages.map((currentMessage) => (
      `${currentMessage.senderType === "CUSTOMER" ? "ผู้ใช้งาน" : currentMessage.senderType === "TECH" ? "ทีม Tech" : "ระบบ"}: ${currentMessage.originalText}`
    ));
    const analysis = shouldAnalyze
      ? await aiCenterClient.analyzeCustomerMessage({
          text: currentConversation?.join("\n") || contextualText,
          customerDisplayName: detail.customer.displayName,
          conversationContext: currentConversation,
          caseAnalysisContext: currentAnalysisContext?.context,
          latestUserClarification: { content: contextualText, createdAt: receivedAt },
          feedbackExamples: currentFeedbackExamples,
        })
      : undefined;
    const lastBotQuestion = [...detail.messages]
      .reverse()
      .find((message) => message.senderType === "BOT" && message.messageType === "REQUEST_MORE_INFO")?.originalText;
    const approvedSolution = (await Promise.all(
        detail.solutions
          .slice()
          .reverse()
        .map(async (solution) => ({ solution, allowed: await isAutoAnswerAllowedForSolution(detail.confidenceScore, solution, { caseId: detail.id }) })),
    )).find((item) => item.allowed)?.solution;
    const solutionRelevance = approvedSolution
      ? await aiCenterClient.evaluateAutoAnswerSolutionRelevance({
          caseTitle: this.formatCaseTitle(detail),
          currentSummary: detail.problemSummary ?? detail.title ?? "",
          recentConversation: detail.messages.slice(-8).map((message) => `${message.direction}: ${message.originalText}`),
          latestCustomerMessage: contextualText,
          approvedSolutionSteps: approvedSolution.solutionSteps,
        })
      : undefined;
    const canAutoAnswer = Boolean(
      approvedSolution
      && solutionRelevance
      && await isAutoAnswerAllowedForRelevance(solutionRelevance),
    );
    console.log({
      event: "auto_answer_solution_relevance_decision",
      caseId: input.caseId,
      solutionId: approvedSolution?.id,
      relevant: solutionRelevance?.relevant ?? false,
      confidence: solutionRelevance?.confidence ?? 0,
      reason: solutionRelevance?.reason ?? "NO_APPROVED_SOLUTION",
      autoAnswerAllowed: canAutoAnswer,
    });
    const continuationReply = approvedSolution && canAutoAnswer
      ? await aiCenterClient.generateLineContinuationReply({
          replyType: "TROUBLESHOOTING_GUIDANCE",
          caseNumber: detail.caseNumber,
          caseTitle: this.formatCaseTitle(detail),
          originalCustomerText: detail.messages.find((message) => message.senderType === "CUSTOMER")?.originalText ?? input.text,
          latestCustomerMessage: contextualText,
          recentConversation: detail.messages.slice(-8).map((message) => `${message.direction}: ${message.originalText}`),
          newCustomerText: contextualText,
          lastBotQuestion,
          currentSummary: detail.problemSummary ?? detail.title ?? "",
          knownFacts: detail.messages
            .filter((message) => message.senderType === "CUSTOMER")
            .slice(-6)
            .map((message) => message.originalText),
          missingFacts: analysis?.missingInformation ?? [],
          currentCaseStatus: detail.status,
          approvedSolutionSteps: approvedSolution.solutionSteps,
        })
      : `ขอบคุณที่แจ้งข้อมูลเพิ่มเติมนะคะ สำหรับ${this.formatCaseTitle(detail)} ทีมงานจะตรวจสอบต่อให้ค่ะ`;

    let savedCustomerAnalysis: {
      caseId: string;
      analysisId: string;
      analysisVersion: number;
      createdAt: string;
    } | undefined;
    if (analysis) {
      const savedAnalysis = await store.createAnalysis({
        caseId: input.caseId,
        messageId: message.id,
        analysisType: "customer_message",
        summary: analysis.summary,
        category: analysis.category,
        confidence: analysis.confidence,
        rawJson: {
          ...analysis,
          analysisMode: "CASE_REANALYSIS",
          caseAnalysisContext: currentAnalysisContext?.context,
          sourceMessageIds: currentAnalysisContext?.messages.map(analysisMessageIdentity) ?? [],
          feedbackExamples: currentFeedbackExamples,
        },
      });
      savedCustomerAnalysis = savedAnalysis;
    }
    if (input.customerOutcome) {
      await store.createAnalysis({
        caseId: input.caseId,
        messageId: message.id,
        analysisType: "customer_outcome",
        summary: input.text,
        category: detail.category,
        confidence: Math.round(Math.max(0, Math.min(1, input.outcomeConfidence ?? 0)) * 100),
        rawJson: {
          outcome: input.customerOutcome === "ISSUE_RESOLVED" ? "RESOLVED" : "IMPROVED",
          customerConfirmation: input.text,
        },
      });
    }
    if (shouldAnalyze) {
      await updateProblemSummaryForMessage(detail, { ...message, senderType: "CUSTOMER" });
    } else {
      await store.updateCase(input.caseId, { latestCustomerMessageId: message.id });
    }
    await store.updateCase(input.caseId, {
      status: shouldNotifyTech ? "awaiting_tech" : detail.status,
      title: detail.title ?? analysis?.caseTitle,
      aiStatus: analysis ? (analysis.status === "AI_FAILED" ? "AI_FAILED" : analysis.status === "AI_LOW_CONFIDENCE" ? "AI_LOW_CONFIDENCE" : "AI_SUCCESS") : detail.aiStatus,
      aiAnalyzedAt: analysis ? new Date().toISOString() : detail.aiAnalyzedAt,
      category: analysis?.category && isTemporaryCategory(detail.category)
        ? analysis.category
        : detail.category ?? analysis?.category,
      priority: analysis?.urgency ?? detail.priority,
      confidenceScore: analysis?.confidence ?? detail.confidenceScore,
      latestCustomerMessageId: message.id,
    });
    if (savedCustomerAnalysis) publishCaseAnalysisUpdated(savedCustomerAnalysis);

    const updatedDetail = await store.getCaseDetail(input.caseId);
    if (!updatedDetail) throw new Error("Case detail missing after appending LINE message");

    console.log({
      event: "line_customer_followup_routing",
      caseId: input.caseId,
      shouldNotifyTech,
      reason: shouldNotifyTech ? "ACTIONABLE_CUSTOMER_UPDATE" : "ACKNOWLEDGEMENT_ONLY",
    });

    if (shouldNotifyTech && !canAutoAnswer) {
      try {
        await teamsClient.notifyCase(updatedDetail);
        await store.createMessage({
          caseId: input.caseId,
          direction: "outbound_tech",
          channel: "ms_teams",
          originalText: `ส่งข้อมูลล่าสุดของเคส ${updatedDetail.caseNumber} ให้ทีม Tech Support ผ่าน Microsoft Teams แล้ว`,
          senderType: "SYSTEM",
          messageType: "CASE_FORWARDED",
          deliveryStatus: "sent",
        });
        await store.updateCase(input.caseId, {
          teamsDeliveryStatus: "accepted",
          teamsDeliveryAt: new Date().toISOString(),
          teamsSentAt: new Date().toISOString(),
          teamsDeliveryError: undefined,
        });
      } catch (error) {
        await store.updateCase(input.caseId, {
          teamsDeliveryStatus: "failed",
          teamsDeliveryAt: new Date().toISOString(),
          teamsDeliveryError: error instanceof Error ? error.message : String(error),
          dataStatus: error instanceof Error && error.message.startsWith("DATA_INCOMPLETE") ? "DATA_INCOMPLETE" : undefined,
        });
        console.error({ event: "teams_related_case_delivery_failed", caseId: input.caseId, error: String(error) });
      }
    }

    const autoAnswerAnalysis = [...updatedDetail.analyses]
      .filter((item) => item.analysisType === "customer_message")
      .sort((left, right) => right.analysisVersion - left.analysisVersion)[0];

    return {
      detail: await store.getCaseDetail(input.caseId),
      continuationReply,
      autoAnswer: canAutoAnswer && approvedSolution
        ? {
            solutionId: approvedSolution.id,
            sourceMessageId: message.id,
            analysisId: autoAnswerAnalysis?.analysisId,
            analysisVersion: autoAnswerAnalysis?.analysisVersion,
          }
        : undefined,
    };
  },

  async acceptCase(caseId: string) {
    const detail = await store.getCaseDetail(caseId);
    if (!detail) throw new Error("Case not found");
    await store.updateCase(caseId, { status: "assigned" });
    return store.getCaseDetail(caseId);
  },

  async rewriteAdditionalInfoRequest(caseId: string, rawSupportMessage: string) {
    const detail = await store.getCaseDetail(caseId);
    if (!detail) throw new Error("Case not found");
    const rawText = sanitizeCustomerFacingMessage(rawSupportMessage);
    if (!rawText) throw new Error("กรุณากรอกข้อความที่ต้องการให้ AI เรียบเรียง");

    const rawMessage = await store.createMessage({
      caseId,
      direction: "INTERNAL",
      channel: "system",
      originalText: rawText,
      senderType: "TECH",
      messageType: "TECH_RAW_REPLY",
      metadata: {
        requestedBy: "TECH",
        generatedBy: "AI_ASSISTED_TECH",
      },
      isVisibleToCustomer: false,
    });

    const customerMessages = detail.messages.filter((message) => message.senderType === "CUSTOMER");
    const previousRequests = detail.messages.filter((message) => message.messageType === "REQUEST_MORE_INFO");
    const caseSummary = detail.analyses
      .filter((analysis) => analysis.analysisType === "customer_message")
      .at(-1)?.summary ?? "";

    const rewrite = await aiCenterClient.rewriteAdditionalInfoRequest({
      caseNumber: detail.caseNumber,
      caseTitle: caseService.formatCaseTitle(detail),
      caseSummary,
      originalCustomerMessage: customerMessages[0]?.originalText ?? "",
      conversationHistory: detail.messages.slice(-12).map((message) => `${message.senderType ?? message.direction}: ${message.originalText}`),
      customerProvidedInformation: customerMessages.map((message) => message.originalText),
      previouslyRequestedInformation: previousRequests.map((message) => message.originalText),
      rawSupportMessage: rawText,
      currentCaseStatus: detail.status,
    });

    const rewrittenMessage = rewrite.usedFallback ? undefined : await store.createMessage({
      caseId,
      direction: "INTERNAL",
      channel: "system",
      originalText: rewrite.rewrittenMessage,
      senderType: "AI",
      messageType: "AI_REWRITTEN_REPLY",
      sourceMessageId: rawMessage.id,
      isVisibleToCustomer: false,
    });

    return {
      rewrittenMessage: rewrite.rewrittenMessage,
      rawMessageId: rawMessage.id,
      rewrittenMessageId: rewrittenMessage?.id,
      usedFallback: rewrite.usedFallback,
    };
  },

  async generateMoreInfoRequest(caseId: string, requestedInformation?: string) {
    const detail = await store.getCaseDetail(caseId);
    if (!detail) throw new Error("Case not found");
    const customerMessages = detail.messages.filter((message) => message.senderType === "CUSTOMER");
    const previousRequests = detail.messages.filter((message) => message.messageType === "REQUEST_MORE_INFO");
    const caseSummary = detail.analyses
      .filter((analysis) => analysis.analysisType === "customer_message")
      .at(-1)?.summary ?? detail.title ?? "";

    const suggestion = await aiCenterClient.generateMoreInfoRequest({
      caseNumber: detail.caseNumber,
      caseTitle: caseService.formatCaseTitle(detail),
      originalCustomerMessage: customerMessages[0]?.originalText ?? "",
      caseSummary,
      conversationHistory: detail.messages.slice(-12).map((message) => `${message.senderType ?? message.direction}: ${message.originalText}`),
      customerProvidedInformation: customerMessages.map((message) => message.originalText),
      previouslyRequestedInformation: previousRequests.map((message) => message.originalText),
      requestedInformation: requestedInformation?.trim() || undefined,
    });

    let sourceMessageId: string | undefined;
    if (requestedInformation?.trim()) {
      const sourceMessage = await store.createMessage({
        caseId,
        direction: "INTERNAL",
        channel: "system",
        originalText: requestedInformation.trim(),
        senderType: "TECH",
        messageType: "TECH_RAW_REPLY",
        isVisibleToCustomer: false,
      });
      sourceMessageId = sourceMessage.id;
    }

    const aiMessage = await store.createMessage({
      caseId,
      direction: "INTERNAL",
      channel: "system",
      originalText: suggestion.suggestedMessage,
      senderType: "AI",
      messageType: "AI_REWRITTEN_REPLY",
      sourceMessageId,
      isVisibleToCustomer: false,
      metadata: { aiPurpose: "GENERATE_MORE_INFO_REQUEST" },
    });

    return { ...suggestion, rewrittenMessageId: aiMessage.id, sourceMessageId };
  },

  async composeAiMessage(input: {
    caseId: string;
    mode: "CUSTOMER_REPLY" | "REQUEST_MORE_INFO";
    supportInstruction?: string;
    requestedInformation?: string;
  }) {
    const detail = await store.getCaseDetail(input.caseId);
    if (!detail) throw new Error("Case not found");

    if (input.mode === "REQUEST_MORE_INFO") {
      const suggestion = await this.generateMoreInfoRequest(input.caseId, input.requestedInformation);
      return {
        mode: input.mode,
        suggestedMessage: suggestion.suggestedMessage,
        suggestedMode: "REQUEST_MORE_INFO" as const,
        reason: suggestion.reason,
        requestedFields: suggestion.requestedFields,
        missingInformation: suggestion.requestedFields,
        rewrittenMessageId: suggestion.rewrittenMessageId,
        sourceMessageId: suggestion.sourceMessageId,
      };
    }

    const confirmedSolution = [...detail.solutions]
      .filter((solution) => solution.validatedByTeam && actionableSolutionSteps(solution.solutionSteps).length > 0)
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
      .at(0);
    if (!confirmedSolution) {
      throw new Error("ยังไม่มีวิธีแก้จากทีม Tech ที่พร้อมใช้สร้างร่างตอบผู้ใช้งาน");
    }

    const customerMessages = detail.messages
      .filter((message) => message.senderType === "CUSTOMER" && (message.direction === "INBOUND" || message.direction === "inbound_customer"))
      .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
    const latestCustomerMessage = customerMessages.at(-1);
    const customerProvidedInformation = customerMessages.slice(1).map((message) => message.originalText);
    const previouslyRequestedInformation = detail.messages
      .filter((message) => message.messageType === "REQUEST_MORE_INFO")
      .map((message) => message.originalText);
    const previousReplies = [confirmedSolution.rawReplyText, confirmedSolution.rewrittenCustomerText].filter(Boolean);
    const caseSummary = detail.analyses
      .filter((analysis) => analysis.analysisType === "customer_message")
      .at(-1)?.summary ?? detail.title ?? "";
    const conversationHistory = [...detail.messages]
      .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime())
      .map((message) => `${message.senderType ?? message.direction}: ${message.originalText}`);

    const suggestion = await aiCenterClient.composeCustomerReply({
      mode: "CUSTOMER_REPLY",
      caseNumber: detail.caseNumber,
      caseTitle: caseService.formatCaseTitle(detail),
      originalCustomerMessage: customerMessages[0]?.originalText ?? "",
      latestCustomerMessage: latestCustomerMessage?.originalText ?? "",
      conversationHistory,
      customerProvidedInformation,
      previouslyRequestedInformation,
      previousReplies,
      caseSummary,
      currentCaseStatus: detail.status,
      supportInstruction: input.supportInstruction?.trim() || undefined,
    });

    let sourceMessageId: string | undefined;
    if (input.supportInstruction?.trim()) {
      const sourceMessage = await store.createMessage({
        caseId: input.caseId,
        direction: "INTERNAL",
        channel: "system",
        originalText: input.supportInstruction.trim(),
        senderType: "TECH",
        messageType: "TECH_RAW_REPLY",
        isVisibleToCustomer: false,
        metadata: { aiPurpose: "GENERATE_CUSTOMER_REPLY" },
      });
      sourceMessageId = sourceMessage.id;
    }

    const aiMessage = await store.createMessage({
      caseId: input.caseId,
      direction: "INTERNAL",
      channel: "system",
      originalText: suggestion.suggestedMessage || suggestion.reason,
      senderType: "AI",
      messageType: "AI_REWRITTEN_REPLY",
      sourceMessageId,
      isVisibleToCustomer: false,
      metadata: {
        aiPurpose: "GENERATE_CUSTOMER_REPLY",
        suggestedMode: suggestion.suggestedMode,
        missingInformation: suggestion.missingInformation,
      },
    });

    return {
      mode: input.mode,
      ...suggestion,
      requestedFields: [],
      rewrittenMessageId: aiMessage.id,
      sourceMessageId,
    };
  },

  async requestAdditionalInfo(caseId: string, text: string, sourceMessageId?: string) {
    const detail = await store.getCaseDetail(caseId);
    if (!detail) throw new Error("Case not found");
    const question = sanitizeCustomerFacingMessage(text);
    if (!question) throw new Error("กรุณากรอกข้อความที่จะส่งให้ผู้ใช้งาน");

    let sourceId = sourceMessageId;
    if (!sourceId) {
      const rawMessage = await store.createMessage({
        caseId,
        direction: "INTERNAL",
        channel: "system",
        originalText: question,
        senderType: "TECH",
        messageType: "TECH_RAW_REPLY",
        metadata: {
          requestedBy: "TECH",
          generatedBy: "TECH",
        },
        isVisibleToCustomer: false,
      });
      sourceId = rawMessage.id;
    }

    const messageText = `ขอข้อมูลเพิ่มเติมสำหรับเคส ${detail.caseNumber}\nเรื่อง: ${caseService.formatCaseTitle(detail)}\n\n${question}`;
    const delivery = await lineClient.reply({
      lineUserId: detail.customer.lineUserId,
      text: messageText,
    });

    await store.createMessage({
      caseId,
      direction: "outbound_customer",
      channel: "line",
      originalText: messageText,
      senderType: "TECH",
      messageType: "REQUEST_MORE_INFO",
      sourceMessageId: sourceId,
      metadata: {
        requestedBy: "TECH",
        generatedBy: sourceMessageId ? "AI_ASSISTED_TECH" : "TECH",
      },
      isVisibleToCustomer: true,
      deliveryStatus: delivery.delivered ? "delivered" : "pending",
    });

    const sentAt = new Date().toISOString();
    const inboxMessage = await store.createInboxMessage({
      customerId: detail.customer.id,
      caseId,
      assignedCaseId: caseId,
      assignedBy: "Tech Support Console",
      assignedAt: sentAt,
      direction: "OUTBOUND",
      senderType: "TECH",
      text: messageText,
      deliveryStatus: delivery.delivered ? "SENT" : "FAILED",
      sentAt: delivery.delivered ? sentAt : undefined,
      deliveredAt: delivery.delivered ? sentAt : undefined,
    });
    realtimeEventHub.publish({
      name: "conversation.message.created",
      data: {
        eventId: `case:${caseId}:request-info:${inboxMessage.id}`,
        messageId: inboxMessage.id,
        conversationId: detail.customer.id,
        userId: detail.customer.id,
        caseId,
        senderType: inboxMessage.senderType,
        createdAt: inboxMessage.createdAt,
        direction: inboxMessage.direction,
      },
    });

    await store.updateCase(caseId, {
      lineSentAt: new Date().toISOString(),
      lineDeliveredAt: delivery.delivered ? new Date().toISOString() : undefined,
    });

    await store.updateCase(caseId, { status: "awaiting_customer_info" });
    await this.setPendingInformationRequest({
      customerId: detail.customer.id,
      caseId,
      questionType: "TECH_REQUEST",
      requestedFields: [question],
    });
    return store.getCaseDetail(caseId);
  },

  async rewriteCustomerReply(caseId: string, rawSupportMessage: string, mode: "NORMAL_REPLY" | "CLOSING_REPLY") {
    const detail = await store.getCaseDetail(caseId);
    if (!detail) throw new Error("Case not found");
    const rawText = sanitizeCustomerFacingMessage(rawSupportMessage);
    if (!rawText) throw new Error("กรุณากรอกข้อความตอบกลับผู้ใช้งาน");

    const customerMessages = detail.messages.filter((message) => message.senderType === "CUSTOMER");
    const isClosingSummary = mode === "CLOSING_REPLY";
    return aiCenterClient.rewriteCustomerReply({
      caseNumber: detail.caseNumber,
      caseTitle: caseService.formatCaseTitle(detail),
      originalCustomerMessage: isClosingSummary ? "" : customerMessages[0]?.originalText ?? "",
      // Closing summaries use the operator's three fields as the source of truth,
      // with only a short recent history for tone and continuity.
      conversationHistory: isClosingSummary
        ? detail.messages.slice(-6).map((message) => `${message.senderType ?? message.direction}: ${message.originalText}`)
        : detail.messages.slice(-12).map((message) => `${message.senderType ?? message.direction}: ${message.originalText}`),
      rawSupportMessage: rawText,
      mode,
    });
  },

  async sendConsoleReply(input: { caseId: string; text: string; closeCase?: boolean; closedBy?: string; externalActionId?: string; closedWithoutTechConfirmation?: boolean; closeSummary?: { cause: string; resolution: string; prevention: string } }) {
    const detail = await store.getCaseDetail(input.caseId);
    if (!detail) throw new Error("Case not found");
    if (!detail.customer.lineUserId?.trim()) throw new Error("Customer LINE user ID is missing");
    if (detail.status === "closed" && !input.closeCase) throw new Error("เคสนี้ปิดแล้ว กรุณาเปิดเคสอีกครั้งก่อนตอบกลับผู้ใช้งาน");

    const text = sanitizeCustomerFacingMessage(input.text);
    if (!text) throw new Error("กรุณากรอกข้อความตอบกลับผู้ใช้งาน");

    const externalMessageId = input.externalActionId ? `teams-action:${input.externalActionId}` : undefined;
    if (externalMessageId) {
      const existing = await store.getMessageByExternalMessageId(externalMessageId);
      if (existing?.deliveryStatus === "SENT" || existing?.deliveryStatus === "DELIVERED" || existing?.deliveryStatus === "sent" || existing?.deliveryStatus === "delivered") {
        return detail;
      }
      if (existing) throw new Error("คำขอนี้เคยส่งไม่สำเร็จ กรุณาส่งใหม่ด้วย requestId ใหม่");
    }

    if (input.closeCase) {
      if (detail.status === "closed") throw new Error("Case is already closed");

      const responder = input.closedBy ?? "Tech Support Console";
      const followupText = `หากยังพบปัญหา สามารถตอบกลับพร้อมแจ้งหมายเลขเคส ${detail.caseNumber} ได้เลยค่ะ`;
      const genericFollowupText = "หากยังพบปัญหา สามารถตอบกลับพร้อมแจ้งหมายเลขเคสได้เลยค่ะ";
      const supportText = text.includes(genericFollowupText)
        ? text.replaceAll(genericFollowupText, followupText)
        : `${text}\n\n${followupText}`;
      const outboundText = [
        `ปิดเคส ${detail.caseNumber}`,
        `เรื่อง: ${caseService.formatCaseTitle(detail)}`,
        "",
        supportText,
      ].join("\n");
      const rawMessage = await store.createMessage({
        caseId: input.caseId,
        direction: "INTERNAL",
        channel: "system",
        originalText: text,
        senderType: "SYSTEM",
        contentType: "SYSTEM_EVENT",
        messageType: "CASE_CLOSED",
        isVisibleToCustomer: false,
        deliveryStatus: "PROCESSED",
        metadata: {
          source: "SYSTEM",
          eventType: "CASE_CLOSED",
          closedWithoutTechConfirmation: input.closedWithoutTechConfirmation === true,
          closeSummary: input.closeSummary,
        },
      });
      const outboundMessage = await store.createMessage({
        caseId: input.caseId,
        direction: "OUTBOUND",
        channel: "line",
        originalText: outboundText,
        senderType: "TECH",
        contentType: "TEXT",
        messageType: "CASE_CLOSED",
        sourceMessageId: rawMessage.id,
        isVisibleToCustomer: true,
        deliveryStatus: "PENDING",
        externalMessageId,
      });

      try {
        const delivery = await lineClient.reply({ lineUserId: detail.customer.lineUserId, text: outboundText });
        if (!delivery.delivered) throw new Error("LINE ยังไม่ยืนยันการส่งข้อความ");
      } catch (error) {
        await store.createInboxMessage({
          customerId: detail.customer.id,
          caseId: input.caseId,
          assignedCaseId: input.caseId,
          assignedBy: responder,
          assignedAt: new Date().toISOString(),
          direction: "OUTBOUND",
          senderType: "TECH",
          text: outboundText,
          deliveryStatus: "FAILED",
          deliveryError: error instanceof Error ? error.message : String(error),
        });
        await store.updateMessage(outboundMessage.id, {
          deliveryStatus: "FAILED",
          deliveryError: error instanceof Error ? error.message : String(error),
          failedAt: new Date().toISOString(),
        });
        throw new Error("LINE ส่งข้อความปิดเคสไม่สำเร็จ");
      }

      const sentAt = new Date().toISOString();
      await store.updateMessage(outboundMessage.id, {
        deliveryStatus: "SENT",
        sentAt,
        deliveredAt: sentAt,
      });
      // Persist the exact delivered LINE text to the shared inbox stream
      // before marking the case closed. If this fails, leave the case open
      // so the existing delivered case message can be synchronized safely.
      const inboxMessage = await store.createInboxMessage({
        customerId: detail.customer.id,
        caseId: input.caseId,
        assignedCaseId: input.caseId,
        assignedBy: responder,
        assignedAt: new Date().toISOString(),
        direction: "OUTBOUND",
        senderType: "TECH",
        text: outboundText,
        deliveryStatus: "SENT",
        sentAt,
        deliveredAt: sentAt,
        createdAt: sentAt,
      });
      await store.updateMessage(outboundMessage.id, {
        metadata: { inboxMessageId: inboxMessage.id },
      });
      realtimeEventHub.publish({
        name: "conversation.message.created",
        data: {
          eventId: `case:${input.caseId}:close:${outboundMessage.id}`,
          messageId: inboxMessage.id,
          conversationId: detail.customer.id,
          userId: detail.customer.id,
          caseId: input.caseId,
          senderType: inboxMessage.senderType,
          createdAt: inboxMessage.createdAt,
          direction: inboxMessage.direction,
        },
      });
      // Closing text is workflow communication, not new troubleshooting evidence.
      // Keep the latest solution extracted from an actual Tech reply unchanged.
      await store.updateCase(input.caseId, {
        status: "closed",
        closedAt: sentAt,
        conversationEndedAt: sentAt,
        closedBy: responder,
        closeSummary: input.closeSummary,
        lineSentAt: sentAt,
        lineDeliveredAt: sentAt,
        category: detail.category,
      });
      await store.createMessage({
        caseId: input.caseId,
        direction: "INTERNAL",
        channel: "system",
        originalText: input.closedWithoutTechConfirmation ? "ปิดเคสโดยไม่รอการยืนยันจากทีม Tech" : `ปิดเคสโดย ${responder}`,
        displayText: input.closedWithoutTechConfirmation ? "ปิดเคสโดยไม่รอการยืนยันจากทีม Tech" : `ปิดเคสโดย ${responder}`,
        senderType: "SYSTEM",
        contentType: "SYSTEM_EVENT",
        messageType: "CASE_CLOSED",
        isVisibleToCustomer: false,
        deliveryStatus: "PROCESSED",
        metadata: {
          source: "SYSTEM",
          eventType: "CASE_CLOSED",
          closedWithoutTechConfirmation: input.closedWithoutTechConfirmation === true,
          closedBy: responder,
          closeSummary: input.closeSummary,
        },
      });
      if (detail.customer.activeCaseId === input.caseId) {
        await store.setActiveCase(detail.customer.id);
      }
      if (detail.customer.pendingCaseSelection?.pendingCaseId === input.caseId) {
        await store.setPendingCaseSelection(detail.customer.id);
        await store.setConversationState(detail.customer.id, "IDLE");
      }
      return store.getCaseDetail(input.caseId);
    }

    // The LINE push is the commit point: do not alter the case until LINE accepts it.
    let delivery: { delivered: boolean };
    try {
      delivery = await lineClient.reply({ lineUserId: detail.customer.lineUserId, text });
      if (!delivery.delivered) throw new Error("LINE ยังไม่ยืนยันการส่งข้อความ");
    } catch (error) {
      await store.createInboxMessage({
        customerId: detail.customer.id,
        caseId: input.caseId,
        assignedCaseId: input.caseId,
        assignedBy: input.closedBy ?? "Tech Support Console",
        assignedAt: new Date().toISOString(),
        direction: "OUTBOUND",
        senderType: "TECH",
        text,
        deliveryStatus: "FAILED",
        deliveryError: error instanceof Error ? error.message : String(error),
      });
      await store.createMessage({
        caseId: input.caseId,
        direction: "OUTBOUND",
        channel: "line",
        originalText: text,
        senderType: "TECH",
        messageType: input.closeCase ? "CASE_CLOSED" : "CUSTOMER_REPLY",
        isVisibleToCustomer: false,
        deliveryStatus: "FAILED",
        deliveryError: error instanceof Error ? error.message : String(error),
        externalMessageId,
      });
      throw new Error("LINE ส่งข้อความไม่สำเร็จ");
    }

    const sentAt = new Date().toISOString();
    const rawMessage = await store.createMessage({
      caseId: input.caseId,
      direction: "INTERNAL",
      channel: "system",
      originalText: text,
      senderType: "TECH",
      messageType: "TECH_RAW_REPLY",
      isVisibleToCustomer: false,
      deliveryStatus: "PROCESSED",
    });

    const deliveredMessage = await store.createMessage({
      caseId: input.caseId,
      direction: "OUTBOUND",
      channel: "line",
      originalText: text,
      senderType: "TECH",
      messageType: input.closeCase ? "CASE_CLOSED" : "CUSTOMER_REPLY",
      sourceMessageId: rawMessage.id,
      isVisibleToCustomer: true,
      deliveryStatus: "SENT",
      sentAt,
      deliveredAt: sentAt,
      externalMessageId,
    });
    const inboxMessage = await store.createInboxMessage({
      customerId: detail.customer.id,
      caseId: input.caseId,
      assignedCaseId: input.caseId,
      assignedBy: input.closedBy ?? "Tech Support Console",
      assignedAt: sentAt,
      direction: "OUTBOUND",
      senderType: "TECH",
      text,
      deliveryStatus: "SENT",
      sentAt,
      deliveredAt: sentAt,
      createdAt: sentAt,
    });
    await store.updateMessage(deliveredMessage.id, {
      metadata: { inboxMessageId: inboxMessage.id },
    });
    realtimeEventHub.publish({
      name: "conversation.message.created",
      data: {
        eventId: `case:${input.caseId}:reply:${deliveredMessage.id}`,
        messageId: inboxMessage.id,
        conversationId: detail.customer.id,
        userId: detail.customer.id,
        caseId: input.caseId,
        senderType: inboxMessage.senderType,
        createdAt: inboxMessage.createdAt,
        direction: inboxMessage.direction,
      },
    });

    const solutionAnalysis = await extractAndStoreTechSolution({
      detail,
      messageId: rawMessage.id,
      techReplyText: text,
      rewrittenCustomerText: text,
    });

    if (input.closeCase) {
      await store.updateCase(input.caseId, {
        status: "closed",
        closedAt: sentAt,
        conversationEndedAt: sentAt,
        closedBy: input.closedBy ?? "Tech Support Console",
        lineSentAt: sentAt,
        lineDeliveredAt: sentAt,
        techRepliedAt: sentAt,
        category: solutionAnalysis.category ?? detail.category,
      });

      await store.createMessage({
        caseId: input.caseId,
        direction: "INTERNAL",
        channel: "system",
        originalText: "ปิดเคสโดยทีม Tech Support",
        senderType: "SYSTEM",
        contentType: "SYSTEM_EVENT",
        messageType: "SYSTEM_EVENT",
        isVisibleToCustomer: false,
        deliveryStatus: "PROCESSED",
      });

      if (detail.customer.activeCaseId === input.caseId) {
        await store.setActiveCase(detail.customer.id);
      }
      if (detail.customer.pendingCaseSelection?.pendingCaseId === input.caseId) {
        await store.setPendingCaseSelection(detail.customer.id);
        await store.setConversationState(detail.customer.id, "IDLE");
      }
    } else {
      // A normal reply must keep the current workflow state and active case intact.
      await store.updateCase(input.caseId, {
        lineSentAt: sentAt,
        lineDeliveredAt: sentAt,
        techRepliedAt: sentAt,
        category: solutionAnalysis.category ?? detail.category,
      });
    }

    return store.getCaseDetail(input.caseId);
  },

  async reopenCaseFromConsole(caseId: string, reopenedBy = "Tech Support Console", reopenReason = "อื่น ๆ") {
    const detail = await store.getCaseDetail(caseId);
    if (!detail) throw new Error("Case not found");
    if (detail.status !== "closed") return detail;

    const reopenedAt = new Date().toISOString();
    await store.updateCase(caseId, {
      status: "reopened",
      closedAt: undefined,
      closedBy: undefined,
      conversationEndedAt: undefined,
    });
    await store.setActiveCase(detail.customer.id, caseId);
    await store.createMessage({
      caseId,
      direction: "INTERNAL",
      channel: "system",
      originalText: `เปิดเคสอีกครั้ง: ${reopenReason}`,
      displayText: `เปิดเคสอีกครั้ง: ${reopenReason}`,
      senderType: "SYSTEM",
      contentType: "SYSTEM_EVENT",
      messageType: "CASE_REOPENED",
      isVisibleToCustomer: false,
      deliveryStatus: "PROCESSED",
      processedAt: reopenedAt,
      metadata: { source: "SYSTEM", eventType: "CASE_REOPENED", reopenReason, reopenedBy },
    });
    return store.getCaseDetail(caseId);
  },

  async notifyTeams(caseId: string) {
    const detail = await store.getCaseDetail(caseId);
    if (!detail) {
      throw new Error("Case not found");
    }

    try {
      const result = await teamsClient.notifyCase(detail);
      await store.createMessage({
        caseId,
        direction: "outbound_tech",
        channel: "ms_teams",
        originalText: `ส่งรายละเอียดเคส ${detail.caseNumber} ให้ทีม Tech Support ผ่าน Microsoft Teams แล้ว`,
        senderType: "SYSTEM",
        messageType: "CASE_FORWARDED",
        deliveryStatus: "sent",
      });
      await store.updateCase(caseId, {
        teamsDeliveryStatus: "accepted",
        teamsDeliveryAt: new Date().toISOString(),
        teamsSentAt: new Date().toISOString(),
        teamsDeliveryError: undefined,
      });
      return { ...result, case: await store.getCaseDetail(caseId) };
    } catch (error) {
      await store.updateCase(caseId, {
        teamsDeliveryStatus: "failed",
        teamsDeliveryAt: new Date().toISOString(),
        teamsDeliveryError: error instanceof Error ? error.message : String(error),
        dataStatus: error instanceof Error && error.message.startsWith("DATA_INCOMPLETE") ? "DATA_INCOMPLETE" : undefined,
      });
      throw error;
    }
  },

  async intakeLineMessage(input: {
    lineUserId: string;
    displayName?: string;
    text: string;
    externalMessageId?: string;
  }) {
    const customer = await store.upsertCustomer({
      lineUserId: input.lineUserId,
      displayName: input.displayName,
    });

    const supportCase = await store.createCase({
      customerId: customer.id,
      status: "analyzing",
    });

    const message = await store.createMessage({
      caseId: supportCase.id,
      direction: "inbound_customer",
      channel: "line",
      originalText: input.text,
      externalMessageId: input.externalMessageId,
    });

    const analysis = await aiCenterClient.analyzeCustomerMessage({
      text: input.text,
      customerDisplayName: input.displayName,
    });

    await store.createAnalysis({
      caseId: supportCase.id,
      messageId: message.id,
      analysisType: "customer_message",
      summary: analysis.summary,
      category: analysis.category,
      confidence: analysis.confidence,
      rawJson: analysis,
    });

    await store.updateCase(supportCase.id, {
      status: "awaiting_tech",
      title: analysis.caseTitle,
      category: analysis.category,
      priority: analysis.urgency,
      confidenceScore: analysis.confidence,
    });

    const detail = await store.getCaseDetail(supportCase.id);
    if (!detail) {
      throw new Error("Case detail missing after intake");
    }

    try {
      await teamsClient.notifyCase(detail);
      await store.createMessage({
        caseId: supportCase.id,
        direction: "outbound_tech",
        channel: "ms_teams",
        originalText: `ส่งรายละเอียดเคส ${supportCase.caseNumber} ให้ทีม Tech Support ผ่าน Microsoft Teams แล้ว`,
        senderType: "SYSTEM",
        messageType: "CASE_FORWARDED",
        deliveryStatus: "sent",
      });
      await store.updateCase(supportCase.id, {
        teamsDeliveryStatus: "accepted",
        teamsDeliveryAt: new Date().toISOString(),
        teamsSentAt: new Date().toISOString(),
        teamsDeliveryError: undefined,
      });
    } catch (error) {
      await store.updateCase(supportCase.id, {
        teamsDeliveryStatus: "failed",
        teamsDeliveryAt: new Date().toISOString(),
        teamsDeliveryError: error instanceof Error ? error.message : String(error),
        dataStatus: error instanceof Error && error.message.startsWith("DATA_INCOMPLETE") ? "DATA_INCOMPLETE" : undefined,
      });
      console.error({ event: "teams_case_delivery_failed", caseId: supportCase.id, error: String(error) });
    }
    return store.getCaseDetail(supportCase.id);
  },

  async receiveTeamsReply(input: {
    caseId: string;
    text: string;
    externalMessageId?: string;
    channel?: MessageChannel;
    contentType?: "TEXT" | "IMAGE" | "FILE";
    attachmentUrl?: string;
    closeAfterReply?: boolean;
  }) {
    if (input.externalMessageId) {
      const existingMessage = await store.getMessageByExternalMessageId(input.externalMessageId);
      if (existingMessage) {
        return store.getCaseDetail(existingMessage.caseId);
      }
    }

    const detail = await store.getCaseDetail(input.caseId);
    if (!detail) {
      throw new Error("Case not found");
    }

    await store.updateCase(input.caseId, { status: "tech_replied" });

    const message = await store.createMessage({
      caseId: input.caseId,
      direction: "inbound_tech",
      channel: input.channel ?? "ms_teams",
      originalText: input.text,
      externalMessageId: input.externalMessageId,
      senderType: "TECH",
      contentType: input.contentType ?? "TEXT",
      messageType: "TECH_RAW_REPLY",
      metadata: input.attachmentUrl ? { attachmentUrl: input.attachmentUrl } : undefined,
    });

    const originalCustomerText = detail.messages.find((item) => item.senderType === "CUSTOMER")?.originalText;
    const messageReview = await aiCenterClient.reviewTechMessageForCustomer({
      caseNumber: detail.caseNumber,
      caseTitle: caseService.formatCaseTitle(detail),
      customerOriginalMessage: originalCustomerText ?? "",
      conversationHistory: detail.messages.slice(-8).map((item) => `${item.direction}: ${item.originalText}`),
      techMessage: input.text,
      currentCaseStatus: detail.status,
    });

    await store.createAnalysis({
      caseId: input.caseId,
      messageId: message.id,
      analysisType: "tech_message_review",
      summary: messageReview.reason,
      category: detail.category,
      confidence: messageReview.reviewFailed ? 0 : 100,
      rawJson: messageReview,
    });

    const techMessageType = input.contentType === "IMAGE" || input.contentType === "FILE"
      ? "TECH_ATTACHMENT"
      : messageReview.messageType === "REQUEST_MORE_INFO"
        ? "TECH_MORE_INFO_REQUEST"
        : ["CUSTOMER_REPLY", "RESOLUTION", "CLOSE_CASE"].includes(messageReview.messageType)
          ? "TECH_SOLUTION"
          : "TECH_GENERAL_MESSAGE";
    await store.updateMessage(message.id, {
      direction: messageReview.messageType === "INTERNAL_NOTE" ? "INTERNAL" : message.direction,
      messageType: techMessageType,
      deliveryStatus: messageReview.messageType === "INTERNAL_NOTE" ? "PROCESSED" : message.deliveryStatus,
    });

    if (!messageReview.shouldSendToCustomer) {
      await store.updateCase(input.caseId, {
        status: messageReview.reviewFailed ? "awaiting_tech_review" : "assigned",
        techRepliedAt: new Date().toISOString(),
      });
      return store.getCaseDetail(input.caseId);
    }

    const rewrittenMessage = await store.createMessage({
      caseId: input.caseId,
      direction: "INTERNAL",
      channel: "system",
      originalText: messageReview.rewrittenMessage,
      senderType: "AI",
      messageType: "AI_REWRITTEN_REPLY",
      sourceMessageId: message.id,
      parentMessageId: message.id,
      isVisibleToCustomer: false,
      deliveryStatus: "sent",
    });

    const shouldExtractSolution = ["CUSTOMER_REPLY", "RESOLUTION"].includes(messageReview.messageType);
    let solutionAnalysis;
    if (shouldExtractSolution) {
      await store.updateCase(input.caseId, { status: "analyzing_solution" });
      const extractedAnalysis = await aiCenterClient.analyzeTechSolution({
        techReplyText: input.text,
        originalCustomerText,
      });
      const solutionSteps = extractedAnalysis.hasTroubleshootingSteps === false
        ? []
        : actionableSolutionSteps(extractedAnalysis.solutionSteps);
      const teamActions = [...new Set((extractedAnalysis.teamActions ?? [])
        .map((action) => action.trim())
        .filter(Boolean))];
      solutionAnalysis = {
        ...extractedAnalysis,
        hasTroubleshootingSteps: solutionSteps.length > 0,
        solutionSteps,
        teamActions,
      };
      await store.createAnalysis({
        caseId: input.caseId,
        messageId: message.id,
        analysisType: "tech_solution",
        summary: solutionAnalysis.solutionSteps.join("\n") || "NO_ACTIONABLE_SOLUTION",
        category: solutionAnalysis.category,
        confidence: solutionAnalysis.confidence,
        rawJson: solutionAnalysis,
      });
      if (solutionAnalysis.hasTroubleshootingSteps) {
        await store.createSolution({
          caseId: input.caseId,
          rawReplyText: input.text,
          rootCause: solutionAnalysis.rootCause,
          solutionSteps: solutionAnalysis.solutionSteps,
          rewrittenCustomerText: messageReview.rewrittenMessage,
          confidence: solutionAnalysis.confidence,
          validatedByTeam: false,
        });
      }
    }

    const closeCase = input.closeAfterReply || messageReview.messageType === "CLOSE_CASE";
    const nextStatus: CaseStatus = messageReview.messageType === "REQUEST_MORE_INFO"
      ? "awaiting_customer_info"
      : closeCase
        ? "closed"
        : messageReview.messageType === "STATUS_UPDATE"
          ? "in_progress"
          : "sent_to_customer";
    await store.updateCase(input.caseId, {
      status: nextStatus,
      techRepliedAt: new Date().toISOString(),
      category: solutionAnalysis?.category ?? detail.category,
    });

    const updatedDetail = await store.getCaseDetail(input.caseId);
    if (!updatedDetail) {
      throw new Error("Case detail missing after Teams reply");
    }

    const lineText = closeCase
      ? `ปิดเคส ${updatedDetail.caseNumber}\nเรื่อง: ${caseService.formatCaseTitle(updatedDetail)}\n\n${messageReview.rewrittenMessage}\n\nหากยังพบปัญหา สามารถตอบกลับพร้อมแจ้งหมายเลขเคส ${updatedDetail.caseNumber} ได้เลยค่ะ`
      : messageReview.messageType === "REQUEST_MORE_INFO"
        ? `ขอข้อมูลเพิ่มเติมสำหรับเคส ${updatedDetail.caseNumber}\nเรื่อง: ${caseService.formatCaseTitle(updatedDetail)}\n\n${messageReview.rewrittenMessage}`
        : `อัปเดตเคส ${updatedDetail.caseNumber}\nเรื่อง: ${caseService.formatCaseTitle(updatedDetail)}\n\n${messageReview.rewrittenMessage}`;
    const delivery = await lineClient.reply({
      lineUserId: updatedDetail.customer.lineUserId,
      text: lineText,
    });

    await store.createMessage({
      caseId: input.caseId,
      direction: "outbound_customer",
      channel: "line",
      originalText: lineText,
      senderType: "BOT",
      messageType: closeCase
        ? "CASE_CLOSED"
        : messageReview.messageType === "REQUEST_MORE_INFO"
          ? "REQUEST_MORE_INFO"
          : messageReview.messageType === "RESOLUTION"
            ? "RESOLUTION"
            : "CUSTOMER_REPLY",
      sourceMessageId: rewrittenMessage.id,
      parentMessageId: message.id,
      deliveryStatus: delivery.delivered ? "delivered" : "pending",
    });

    await store.updateCase(input.caseId, {
      lineSentAt: new Date().toISOString(),
      lineDeliveredAt: delivery.delivered ? new Date().toISOString() : undefined,
    });
    await store.setActiveCase(updatedDetail.customer.id, closeCase ? undefined : input.caseId);
    return store.getCaseDetail(input.caseId);
  },

  listCases() {
    return store.listCases();
  },

  getCase(caseId: string) {
    return store.getCaseDetail(caseId);
  },

  async assignInboxMessageToCase(input: { messageId: string; caseId: string; assignedBy: string }) {
    const supportCase = await store.getCaseDetail(input.caseId);
    if (!supportCase || CLOSED_CASE_STATUSES.includes(supportCase.status)) throw new Error("ไม่พบเคสที่เปิดอยู่สำหรับจัดข้อความ");
    const message = await store.assignInboxMessageToCase(input.messageId, { caseId: input.caseId, assignedBy: input.assignedBy });
    await this.linkInboxMessageToActiveCase(supportCase.customer.id, { ...message, caseId: input.caseId }, input.caseId);
    realtimeEventHub.publish({
      name: "conversation.message.created",
      data: {
        eventId: `inbox:${message.id}:assigned:${input.caseId}`,
        messageId: message.id,
        conversationId: supportCase.customer.id,
        userId: supportCase.customer.id,
        caseId: input.caseId,
        senderType: message.senderType,
        createdAt: message.createdAt,
        direction: message.direction,
      },
    });
    return message;
  },

  async backfillCaseReferenceMessages(caseId: string, assignedBy = "SYSTEM_REFERENCE_BACKFILL") {
    const detail = await store.getCaseDetail(caseId);
    if (!detail) throw new Error("Case not found");
    const referenceMessageIds = [...new Set(detail.messages
      .filter((message) => message.metadata?.isCaseReference === true)
      .map((message) => message.metadata?.sourceInboxMessageId)
      .filter((messageId): messageId is string => typeof messageId === "string" && messageId.trim().length > 0))];
    const assignedMessages = await store.assignInboxMessagesToCase(referenceMessageIds, {
      caseId,
      assignedBy,
    });
    const assignedAtByInboxId = new Map(assignedMessages.map((message) => [message.id, message.assignedAt]));
    for (const message of detail.messages) {
      const sourceInboxMessageId = message.metadata?.sourceInboxMessageId;
      if (typeof sourceInboxMessageId !== "string") continue;
      const assignedAt = assignedAtByInboxId.get(sourceInboxMessageId);
      if (!assignedAt) continue;
      await store.updateMessage(message.id, {
        metadata: { assignedAt },
      });
    }
    return {
      caseId,
      referenceMessageIds,
      assignedMessageIds: assignedMessages.map((message) => message.id),
    };
  },

  async setActiveCaseFromConsole(caseId: string) {
    const detail = await store.getCaseDetail(caseId);
    if (!detail || CLOSED_CASE_STATUSES.includes(detail.status)) throw new Error("เลือกได้เฉพาะเคสที่ยังเปิดอยู่");
    return store.setActiveCase(detail.customer.id, caseId);
  },

  async refreshExtractedSolution(caseId: string) {
    const detail = await store.getCaseDetail(caseId);
    if (!detail) throw new Error("Case not found");
    const latestTechMessage = [...detail.messages]
      .reverse()
      .find((message) => message.channel === "line" && message.senderType === "TECH" && message.deliveryStatus !== "FAILED");

    if (!latestTechMessage) {
      await store.createAnalysis({
        caseId,
        analysisType: "tech_solution",
        summary: "NO_ACTIONABLE_SOLUTION",
        confidence: 0,
        rawJson: { status: "PENDING_CONFIRMATION", reason: "NO_TECH_LINE_MESSAGE" },
      });
      await store.updateCase(caseId, { solutionSelectionFeedback: undefined });
      return store.getCaseDetail(caseId);
    }

    await extractAndStoreTechSolution({
      detail,
      messageId: latestTechMessage.id,
      techReplyText: latestTechMessage.originalText,
      rewrittenCustomerText: latestTechMessage.originalText,
    });
    return store.getCaseDetail(caseId);
  },

  async reanalyzeCase(caseId: string) {
    const detail = await store.getCaseDetail(caseId);
    if (!detail) throw new Error("Case not found");
    if (CLOSED_CASE_STATUSES.includes(detail.status)) throw new Error("ปิดเคสแล้ว ไม่สามารถอัปเดตผลวิเคราะห์ได้");

    const { context, messages } = buildConversationCaseAnalysisContext(detail);
    if (messages.length === 0) throw new Error("ยังไม่มีข้อความในช่วงเวลาของเคสให้วิเคราะห์");

    const feedbackExamples = await feedbackExamplesForContext(context, caseId);
    const conversationContext = messages.map((message) => `${message.senderType === "CUSTOMER" ? "ผู้ใช้งาน" : message.senderType === "TECH" ? "ทีม Tech" : "ระบบ"}: ${message.originalText}`);
    const latestCustomerMessage = [...messages].reverse().find((message) => message.senderType === "CUSTOMER");
    const analysis = await aiCenterClient.analyzeCustomerMessage({
      text: conversationContext.join("\n"),
      customerDisplayName: detail.customer.displayName,
      conversationContext,
      latestUserClarification: latestCustomerMessage
        ? { content: latestCustomerMessage.originalText, createdAt: contextTime(latestCustomerMessage) }
        : undefined,
      feedbackExamples,
    });
    if (analysis.status === "AI_FAILED") throw new Error("AI วิเคราะห์ไม่สำเร็จ จึงยังไม่บันทึกผลวิเคราะห์ใหม่");

    const sourceMessage = messages.at(-1);
    const savedAnalysis = await store.createAnalysis({
      caseId,
      messageId: sourceMessage?.id,
      analysisType: "customer_message",
      summary: analysis.summary,
      category: analysis.category,
      confidence: analysis.confidence,
      rawJson: {
        ...analysis,
        analysisMode: "CASE_REANALYSIS",
        caseAnalysisContext: context,
        sourceMessageIds: messages.map(analysisMessageIdentity),
        feedbackExamples,
      },
    });
    const analyzedAt = savedAnalysis.createdAt;
    const aiStatus = analysis.status === "AI_LOW_CONFIDENCE" ? "AI_LOW_CONFIDENCE" : "AI_SUCCESS";
    await store.updateCase(caseId, {
      aiStatus,
      aiAnalyzedAt: analyzedAt,
      category: analysis.category,
      priority: analysis.urgency,
      confidenceScore: analysis.confidence,
      latestCustomerMessageId: latestCustomerMessage?.id ?? detail.latestCustomerMessageId,
    });

    publishCaseAnalysisUpdated(savedAnalysis);

    const updatedDetail = await store.getCaseDetail(caseId);
    if (!updatedDetail) throw new Error("Case detail missing after re-analysis");
    return updatedDetail;
  },

  async getCaseByNumber(caseNumber: string) {
    const cases = await store.listCases();
    return cases.find((item) => item.caseNumber.toUpperCase() === caseNumber.trim().toUpperCase());
  },

  updateStatus(caseId: string, status: CaseStatus) {
    return store.updateCase(caseId, { status });
  },

  async updateAiFeedback(caseId: string, field: "caseUnderstandingFeedback" | "solutionSelectionFeedback", value: "CORRECT" | "INCORRECT" | null) {
    const detail = await store.getCaseDetail(caseId);
    if (!detail) throw new Error("Case not found");
    const feedbackType: CaseAiFeedback["feedbackType"] = field === "caseUnderstandingFeedback"
      ? "ISSUE_UNDERSTANDING"
      : "SOLUTION_SELECTION";

    if (value === null) {
      await store.deleteCaseAiFeedback(caseId, feedbackType);
    } else {
      const aiSnapshot = aiSnapshotFromDetail(detail);
      await store.upsertCaseAiFeedback({
        caseId,
        feedbackType,
        value,
        caseAnalysisContextSnapshot: analysisContextFromDetail(detail),
        aiCategory: aiSnapshot.category,
        aiSummary: aiSnapshot.summary,
        aiSolution: aiSnapshot.solution,
      });
    }
    await store.updateCase(caseId, { [field]: value ?? undefined });
    return store.getCaseDetail(caseId);
  },
};
