import type { CaseDetail, CaseStatus, Message, MessageChannel, PendingCaseSelection } from "../domain/types";
import { env } from "../config/env";
import { store } from "../repositories/store";
import { aiCenterClient, type CaseHistoryCandidate, type CaseHistoryMatchDecision } from "./ai-center-client";
import { lineClient } from "./line-client";
import { teamsClient } from "./teams-client";
import { inferPendingInformationFields } from "../lib/pending-information";
import { sanitizeCustomerFacingMessage } from "../lib/customer-facing-message";
import { isAutoAnswerAllowedForRelevance, isAutoAnswerAllowedForSolution } from "./automation-settings";

const CLOSED_CASE_STATUSES: CaseStatus[] = ["closed", "resolved", "sent_to_customer"];
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

async function extractAndStoreTechSolution(input: {
  detail: CaseDetail;
  messageId: string;
  techReplyText: string;
  rewrittenCustomerText: string;
}) {
  const originalCustomerText = input.detail.messages.find((item) => item.senderType === "CUSTOMER")?.originalText;
  const solutionAnalysis = await aiCenterClient.analyzeTechSolution({
    techReplyText: input.techReplyText,
    originalCustomerText,
  });
  const solutionSteps = solutionAnalysis.solutionSteps.map((step) => step.trim()).filter(Boolean);
  const normalizedSolutionAnalysis = {
    ...solutionAnalysis,
    solutionSteps: solutionSteps.length > 0 ? solutionSteps : [input.techReplyText],
    rewrittenCustomerText: solutionAnalysis.rewrittenCustomerText.trim() || input.rewrittenCustomerText,
  };

  await store.createAnalysis({
    caseId: input.detail.id,
    messageId: input.messageId,
    analysisType: "tech_solution",
    summary: normalizedSolutionAnalysis.solutionSteps.join("\n"),
    category: normalizedSolutionAnalysis.category,
    confidence: normalizedSolutionAnalysis.confidence,
    rawJson: normalizedSolutionAnalysis,
  });
  await store.createSolution({
    caseId: input.detail.id,
    rawReplyText: input.techReplyText,
    rootCause: normalizedSolutionAnalysis.rootCause,
    solutionSteps: normalizedSolutionAnalysis.solutionSteps,
    rewrittenCustomerText: normalizedSolutionAnalysis.rewrittenCustomerText,
    confidence: normalizedSolutionAnalysis.confidence,
    validatedByTeam: false,
  });

  return normalizedSolutionAnalysis;
}

export const caseService = {
  formatCaseTitle(detail: { title?: string; category?: string; messages: { direction: string; originalText: string; senderType?: string }[] }) {
    if (detail.title?.trim()) return detail.title.trim();
    const original = detail.messages.find((message) => message.senderType === "CUSTOMER")?.originalText ?? detail.category ?? "Tech Support";
    return original.trim();
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
    await store.updateCase(caseId, { status: "reopened" });
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

  async appendLineMessageToCase(input: { caseId: string; text: string; resolvedText?: string; externalMessageId?: string; webhookEventId?: string; receivedAt?: string; notifyTech?: boolean }) {
    const detail = await store.getCaseDetail(input.caseId);
    if (!detail) throw new Error("Case not found");

    // Preserve the raw customer message, but give AI the topic-resolved meaning
    // when a short reply depends on the preceding conversation.
    const contextualText = input.resolvedText?.trim() || input.text;
    const shouldNotifyTech = input.notifyTech ?? requiresTechFollowUp(contextualText);

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
      receivedAt: input.receivedAt,
    });
    const shouldAnalyze = shouldRefreshProblemSummary(contextualText);
    const analysis = shouldAnalyze
      ? await aiCenterClient.analyzeCustomerMessage({
          text: contextualText,
          customerDisplayName: detail.customer.displayName,
          conversationContext: detail.messages.slice(-8).map((message) => `${message.direction}: ${message.originalText}`),
        })
      : undefined;
    const lastBotQuestion = [...detail.messages]
      .reverse()
      .find((message) => message.senderType === "BOT" && message.messageType === "REQUEST_MORE_INFO")?.originalText;
    const approvedSolution = (await Promise.all(
      detail.solutions
        .slice()
        .reverse()
        .map(async (solution) => ({ solution, allowed: await isAutoAnswerAllowedForSolution(detail.confidenceScore, solution) })),
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

    if (analysis) {
      await store.createAnalysis({
        caseId: input.caseId,
        messageId: message.id,
        analysisType: "customer_message",
        summary: analysis.summary,
        category: analysis.category,
        confidence: analysis.confidence,
        rawJson: analysis,
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

    const updatedDetail = await store.getCaseDetail(input.caseId);
    if (!updatedDetail) throw new Error("Case detail missing after appending LINE message");

    console.log({
      event: "line_customer_followup_routing",
      caseId: input.caseId,
      shouldNotifyTech,
      reason: shouldNotifyTech ? "ACTIONABLE_CUSTOMER_UPDATE" : "ACKNOWLEDGEMENT_ONLY",
    });

    if (shouldNotifyTech) {
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

    return { detail: await store.getCaseDetail(input.caseId), continuationReply };
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

    const customerMessages = detail.messages
      .filter((message) => message.senderType === "CUSTOMER" && (message.direction === "INBOUND" || message.direction === "inbound_customer"))
      .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
    const latestCustomerMessage = customerMessages.at(-1);
    const customerProvidedInformation = customerMessages.slice(1).map((message) => message.originalText);
    const previouslyRequestedInformation = detail.messages
      .filter((message) => message.messageType === "REQUEST_MORE_INFO")
      .map((message) => message.originalText);
    const previousReplies = detail.messages
      .filter((message) => message.senderType === "TECH" && message.direction !== "INTERNAL")
      .map((message) => message.originalText);
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
    if (!question) throw new Error("กรุณากรอกข้อความที่จะส่งให้ลูกค้า");

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
    if (!rawText) throw new Error("กรุณากรอกข้อความตอบกลับลูกค้า");

    const customerMessages = detail.messages.filter((message) => message.senderType === "CUSTOMER");
    return aiCenterClient.rewriteCustomerReply({
      caseNumber: detail.caseNumber,
      caseTitle: caseService.formatCaseTitle(detail),
      originalCustomerMessage: customerMessages[0]?.originalText ?? "",
      conversationHistory: detail.messages.slice(-12).map((message) => `${message.senderType ?? message.direction}: ${message.originalText}`),
      rawSupportMessage: rawText,
      mode,
    });
  },

  async sendConsoleReply(input: { caseId: string; text: string; closeCase?: boolean; closedBy?: string; externalActionId?: string }) {
    const detail = await store.getCaseDetail(input.caseId);
    if (!detail) throw new Error("Case not found");
    if (!detail.customer.lineUserId?.trim()) throw new Error("Customer LINE user ID is missing");
    if (detail.status === "closed" && !input.closeCase) throw new Error("เคสนี้ปิดแล้ว กรุณาเปิดเคสอีกครั้งก่อนตอบกลับลูกค้า");

    const text = sanitizeCustomerFacingMessage(input.text);
    if (!text) throw new Error("กรุณากรอกข้อความตอบกลับลูกค้า");

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
        senderType: "TECH",
        messageType: "TECH_RAW_REPLY",
        isVisibleToCustomer: false,
        deliveryStatus: "PROCESSED",
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
      const solutionAnalysis = await extractAndStoreTechSolution({
        detail,
        messageId: rawMessage.id,
        techReplyText: text,
        rewrittenCustomerText: supportText,
      });
      await store.updateCase(input.caseId, {
        status: "closed",
        closedAt: sentAt,
        closedBy: responder,
        lineSentAt: sentAt,
        lineDeliveredAt: sentAt,
        techRepliedAt: sentAt,
        category: solutionAnalysis.category ?? detail.category,
      });
      await store.createMessage({
        caseId: input.caseId,
        direction: "INTERNAL",
        channel: "system",
        originalText: `ปิดเคสโดย ${responder}`,
        displayText: `ปิดเคสโดย ${responder}`,
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
      return store.getCaseDetail(input.caseId);
    }

    // The LINE push is the commit point: do not alter the case until LINE accepts it.
    let delivery: { delivered: boolean };
    try {
      delivery = await lineClient.reply({ lineUserId: detail.customer.lineUserId, text });
      if (!delivery.delivered) throw new Error("LINE ยังไม่ยืนยันการส่งข้อความ");
    } catch (error) {
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

    await store.createMessage({
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

  async reopenCaseFromConsole(caseId: string, reopenedBy = "Tech Support Console") {
    const detail = await store.getCaseDetail(caseId);
    if (!detail) throw new Error("Case not found");
    if (detail.status !== "closed") return detail;

    const reopenedAt = new Date().toISOString();
    await store.updateCase(caseId, { status: "reopened", closedAt: undefined, closedBy: undefined });
    await store.setActiveCase(detail.customer.id, caseId);
    await store.createMessage({
      caseId,
      direction: "INTERNAL",
      channel: "system",
      originalText: `เปิดเคสอีกครั้งโดย ${reopenedBy}`,
      senderType: "SYSTEM",
      contentType: "SYSTEM_EVENT",
      messageType: "CASE_REOPENED",
      isVisibleToCustomer: false,
      deliveryStatus: "PROCESSED",
      processedAt: reopenedAt,
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
      messageType: "TECH_RAW_REPLY",
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

    if (messageReview.messageType === "INTERNAL_NOTE") {
      await store.updateMessage(message.id, { direction: "INTERNAL", messageType: "INTERNAL_NOTE", deliveryStatus: "PROCESSED" });
    }

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

    const shouldExtractSolution = ["CUSTOMER_REPLY", "RESOLUTION", "CLOSE_CASE"].includes(messageReview.messageType)
      || input.closeAfterReply;
    let solutionAnalysis;
    if (shouldExtractSolution) {
      await store.updateCase(input.caseId, { status: "analyzing_solution" });
      solutionAnalysis = await aiCenterClient.analyzeTechSolution({
        techReplyText: input.text,
        originalCustomerText,
      });
      await store.createAnalysis({
        caseId: input.caseId,
        messageId: message.id,
        analysisType: "tech_solution",
        summary: solutionAnalysis.solutionSteps.join("\n"),
        category: solutionAnalysis.category,
        confidence: solutionAnalysis.confidence,
        rawJson: solutionAnalysis,
      });
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

  async getCaseByNumber(caseNumber: string) {
    const cases = await store.listCases();
    return cases.find((item) => item.caseNumber.toUpperCase() === caseNumber.trim().toUpperCase());
  },

  updateStatus(caseId: string, status: CaseStatus) {
    return store.updateCase(caseId, { status });
  },
};
