import { env } from "../config/env";
import { normalizeCategory } from "../lib/category";
import {
  PENDING_INFORMATION_FIELDS,
  type PendingInformationField,
  type PendingInformationValues,
  sanitizePendingInformationValues,
} from "../lib/pending-information";
import {
  CUSTOMER_REPLY_FALLBACK,
  MORE_INFO_REQUEST_FALLBACK,
  sanitizeCustomerFacingMessage,
} from "../lib/customer-facing-message";

type ChatRole = "system" | "user" | "assistant";

type ChatMessage = {
  role: ChatRole;
  content: string;
};

type AiCenterChatRequest = {
  provider?: string;
  model?: string;
  temperature: number;
  max_tokens: number;
  messages: ChatMessage[];
};

type AiCenterChatResponse = {
  success: boolean;
  data?: {
    provider: string;
    model: string;
    content: string;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
    latency_ms?: number;
  };
  error?: string;
};

export type CustomerMessageAnalysis = {
  summary: string;
  caseTitle: string;
  category: string;
  urgency: "low" | "medium" | "high" | "critical";
  sentiment: string;
  missingInformation: string[];
  suggestedTeamNote: string;
  extractedSolution?: string;
  confidence: number;
  status?: "AI_SUCCESS" | "AI_LOW_CONFIDENCE" | "AI_FAILED";
};

export type AiCaseTitleResult = {
  caseTitle: string;
};

export type ProblemSummaryResult = {
  problemSummary: string;
  shouldUpdate: boolean;
  reason: string;
  status: "SUCCESS" | "FAILED";
};

export type TechSolutionAnalysis = {
  rootCause?: string;
  solutionSteps: string[];
  hasTroubleshootingSteps?: boolean;
  teamActions?: string[];
  rewrittenCustomerText: string;
  category?: string;
  confidence: number;
};

export type TechMessageReview = {
  messageType: "CUSTOMER_REPLY" | "REQUEST_MORE_INFO" | "INTERNAL_NOTE" | "STATUS_UPDATE" | "RESOLUTION" | "CLOSE_CASE";
  shouldSendToCustomer: boolean;
  rewrittenMessage: string;
  reason: string;
  reviewFailed?: boolean;
};

export type InfoRequestRewrite = {
  rewrittenMessage: string;
  usedFallback?: boolean;
};

export const CUSTOMER_ANALYSIS_INSTRUCTIONS = [
  "Analyze the current case context as the primary source of truth. Do not analyze only the title or only the latest message.",
  "Use positiveUnderstanding and positiveSolutionSelection only as guidance for the matching task.",
  "Use negativeUnderstanding and negativeSolutionSelection only as mistakes to avoid for the matching task; never mix the two feedback types.",
  "Never copy an old case answer. Do not invent troubleshooting steps; return an empty extractedSolution when the current context has no confirmed solution.",
  "Read the current conversation in chronological order from oldest to newest.",
  "The latestUserClarification is the highest-priority current-case fact when it corrects, adds to, confirms, or rejects earlier information.",
  "When facts conflict, replace the older conflicting fact with the latest explicit clarification from the user. Do not state a corrected historical fact as the current issue.",
  "caseAnalysisContext.detail may be an earlier summary and is reference-only when it conflicts with the current conversation.",
  "Feedback examples and historical solution guidance are reference-only. Current conversation facts always take precedence and historical facts must never be copied into the current case.",
] as const;

export const CUSTOMER_ANALYSIS_SYSTEM_INSTRUCTIONS = [
  "Determine current facts from the current conversation before using any historical context.",
  "latestUserClarification has the highest factual priority.",
  "If latestUserClarification corrects, negates, replaces, or narrows an earlier fact, mark the earlier fact as superseded and do not state it as the current problem.",
  "Historical summaries and feedback examples cannot override current conversation facts.",
] as const;

type CustomerAnalysisFeedbackExample = {
  feedbackType: "ISSUE_UNDERSTANDING" | "SOLUTION_SELECTION";
  value: "CORRECT" | "INCORRECT";
  aiCategory?: string;
  aiSummary?: string;
  aiSolution?: string;
  aiOutput?: string;
  reason?: string | null;
  context: unknown;
};

export function feedbackGuidance(item: CustomerAnalysisFeedbackExample) {
  return {
    feedbackType: item.feedbackType,
    value: item.value,
    guidance: item.reason?.trim() || "Historical feedback is reasoning guidance only; do not copy its case facts.",
  };
}

export type MoreInfoRequestSuggestion = {
  suggestedMessage: string;
  requestedFields: string[];
  reason: string;
};

export type LineReplyType =
  | "INITIAL_CASE_ACK"
  | "FOLLOW_UP_ACK"
  | "FOLLOW_UP_QUESTION"
  | "TROUBLESHOOTING_GUIDANCE"
  | "OUT_OF_SCOPE_REPLY";

export const LINE_MESSAGE_INTENTS = [
  "NEW_SUPPORT_ISSUE",
  "FOLLOW_UP_EXISTING_CASE",
  "ISSUE_RESOLVED",
  "ISSUE_IMPROVED",
  "ISSUE_STILL_PRESENT",
  "ISSUE_WORSENED",
  "TROUBLESHOOTING_RESULT",
  "FOLLOW_UP_INFORMATION",
  "CASE_COUNT_QUERY",
  "CASE_HISTORY_QUERY",
  "CASE_STATUS_QUERY",
  "CASE_DETAIL_QUERY",
  "CLOSE_CASE_REQUEST",
  "REOPEN_CASE_REQUEST",
  "TECH_GENERAL_QUESTION",
  "OUT_OF_SCOPE",
  "SMALL_TALK",
  "GREETING",
  "THANK_YOU",
  "UNKNOWN",
] as const;

export type LineMessageIntentName = (typeof LINE_MESSAGE_INTENTS)[number];

export type LineMessageNextAction =
  | "ASK_CLOSE_CONFIRMATION"
  | "ACKNOWLEDGE_IMPROVEMENT"
  | "SEND_UPDATE_TO_TECH"
  | "ESCALATE_TO_TECH"
  | "ASK_CLARIFICATION"
  | "CREATE_CASE"
  | "NONE";

export type LineConversationCaseContext = {
  id: string;
  caseNumber: string;
  title?: string;
  summary?: string;
  status: string;
};

export type LineMessageIntentClassification = {
  intent: LineMessageIntentName;
  shouldCreateCase: boolean;
  shouldForwardToTeams?: boolean;
  teamsEventType?: "NEW_CASE" | "FOLLOW_UP" | "OUT_OF_SCOPE_MESSAGE" | "CASE_QUERY" | "NONE";
  targetCaseNumber: string | null;
  matchedActiveCaseId?: string | null;
  resolvedMessage?: string;
  resolvedMeaning?: string;
  shouldAppendToCase?: boolean;
  nextAction?: LineMessageNextAction;
  confidence: number;
  reason: string;
};

export type CustomerReplyComposeSuggestion = {
  suggestedMessage: string;
  suggestedMode: "CUSTOMER_REPLY" | "REQUEST_MORE_INFO";
  missingInformation: string[];
  reason: string;
  usedFallback?: boolean;
};

export type PendingInformationExtraction = {
  values: PendingInformationValues;
};

export type CaseRelationAnalysis = {
  related: boolean;
  confidence: number;
  reason: string;
};

export type AutoAnswerSolutionRelevance = {
  relevant: boolean;
  confidence: number;
  reason: string;
};

export type CaseHistoryCandidate = {
  caseId: string;
  caseNumber: string;
  title?: string;
  summary?: string;
  category?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  latestCustomerMessage?: string;
  latestSolution?: string;
  keywords: string[];
};

export type CaseHistoryMatchDecision = {
  intent: "CONTINUE_CASE" | "NEW_CASE" | "UNCERTAIN";
  matchedCaseId?: string;
  matchedCaseNumber?: string;
  confidence: number;
  reason: string;
  interpretedProblem: string;
  isSameProblem: boolean;
};

function fallbackCustomerAnalysis(text: string): CustomerMessageAnalysis {
  return {
    summary: text.length > 120 ? `${text.slice(0, 117)}...` : text,
    caseTitle: shortenCaseTitle(text),
    category: "ยังไม่ระบุหมวดหมู่",
    urgency: "medium",
    sentiment: "unknown",
    missingInformation: [],
    suggestedTeamNote: "ตรวจสอบรายละเอียดเคสและตอบกลับวิธีแก้ไขใน MS Teams",
    confidence: 50,
    status: "AI_FAILED",
  };
}

function shortenCaseTitle(text: string) {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length <= 50) return normalized;
  return `${normalized.slice(0, 47).trimEnd()}...`;
}

export function createSafeFallbackCaseTitle(customerMessage: string): string {
  const normalized = customerMessage
    .replace(/\s+/g, " ")
    .replace(/[\r\n]+/g, " ")
    .trim();

  if (!normalized) return "ปัญหาการใช้งานที่ผู้ใช้งานแจ้ง";
  if (normalized.length <= 100) return normalized;
  return `${normalized.slice(0, 100).trimEnd()}…`;
}

function parseAiCaseTitle(content: string): AiCaseTitleResult | undefined {
  const parsed = parseJsonObject<Partial<AiCaseTitleResult>>(content, {});
  const caseTitle = typeof parsed.caseTitle === "string"
    ? parsed.caseTitle.replace(/\s+/g, " ").trim()
    : "";

  if (
    caseTitle.length < 3
    || caseTitle.length > 120
    || /[\r\n]/u.test(caseTitle)
    || /[?？]|\b(ไหม|หรือไม่|อย่างไร|ทำอย่างไร|ลอง|แนะนำ|รบกวน|ขอทราบ)\b/iu.test(caseTitle)
  ) {
    return undefined;
  }

  return { caseTitle };
}

const CASE_TITLE_SYSTEM_PROMPT = `
คุณมีหน้าที่สรุปข้อความแจ้งปัญหาของผู้ใช้งานให้เป็นหัวข้อปัญหาสั้น ๆ สำหรับระบบ Tech Support

กฎ:
- คงความหมายเดิมของผู้ใช้งาน
- แก้คำสะกดและเรียบเรียงให้อ่านง่าย
- สรุปเฉพาะอาการหรือปัญหาหลัก ความยาวประมาณ 5-15 คำ
- ไม่ขึ้นต้นด้วย "ผู้ใช้งานแจ้งว่า"
- ไม่ใส่หมายเลขเคส วิธีแก้ คำถาม หรือการวิเคราะห์สาเหตุเกินข้อมูล
- ไม่แต่งชื่ออุปกรณ์ ระบบ หรือรายละเอียดใหม่
- คืนค่า JSON เท่านั้นตามรูปแบบ {"caseTitle":"หัวข้อปัญหาที่สรุปแล้ว"}
`;

function fallbackInfoRequest(input: { category?: string; originalCustomerText: string }) {
  const searchable = `${input.category ?? ""} ${input.originalCustomerText}`.toLowerCase();
  if (/จ่ายไฟ|ไฟไม่เข้า|ไฟล์/.test(searchable)) {
    return "รบกวนส่งเลขทะเบียนรถ และช่วงเวลาที่ทำรายการให้หน่อยนะคะ";
  }
  if (/เข้าสู่ระบบ|login|รหัสผ่าน/.test(searchable)) {
    return "หน้าจอขึ้นข้อความแจ้งเตือนว่าอะไรคะ และลองเข้าสู่ระบบผ่านช่องทางไหนแล้วบ้าง";
  }
  return "รบกวนส่งข้อความแจ้งเตือนที่พบ และช่วงเวลาที่เริ่มเกิดปัญหาให้หน่อยนะคะ";
}

function failedTechMessageReview(reason: string): TechMessageReview {
  return {
    messageType: "INTERNAL_NOTE",
    shouldSendToCustomer: false,
    rewrittenMessage: "",
    reason,
    reviewFailed: true,
  };
}

function fallbackTechSolution(text: string): TechSolutionAnalysis {
  return {
    rootCause: undefined,
    solutionSteps: [],
    hasTroubleshootingSteps: false,
    teamActions: [],
    rewrittenCustomerText: text,
    category: "ยังไม่ระบุหมวดหมู่",
    confidence: 50,
  };
}

function fallbackCaseRelation(input: { caseStatus?: string }): CaseRelationAnalysis {
  return {
    related: input.caseStatus === "awaiting_customer_info",
    confidence: input.caseStatus === "awaiting_customer_info" ? 60 : 0,
    reason: input.caseStatus === "awaiting_customer_info"
      ? "ผู้ใช้งานกำลังตอบกลับจากคำขอข้อมูลเพิ่มเติมของเคสเดิม"
      : "ยังไม่มีผลวิเคราะห์ความเกี่ยวข้องจาก AI CENTER",
  };
}

function fallbackAutoAnswerSolutionRelevance(): AutoAnswerSolutionRelevance {
  return {
    relevant: false,
    confidence: 0,
    reason: "AI_CENTER_UNAVAILABLE",
  };
}

function fallbackCaseHistoryMatch(): CaseHistoryMatchDecision {
  return {
    intent: "NEW_CASE",
    confidence: 0,
    reason: "AI_CENTER_UNAVAILABLE",
    interpretedProblem: "",
    isSameProblem: false,
  };
}

function normalizeMatchConfidence(value: unknown) {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) return 0;
  return Math.max(0, Math.min(1, numberValue > 1 ? numberValue / 100 : numberValue));
}

function buildChatPayload(messages: ChatMessage[]): AiCenterChatRequest {
  return {
    provider: env.AI_CENTER_PROVIDER || undefined,
    model: env.AI_CENTER_MODEL || undefined,
    temperature: env.AI_CENTER_TEMPERATURE,
    max_tokens: env.AI_CENTER_MAX_TOKENS,
    messages,
  };
}

async function chatWithAiCenter(messages: ChatMessage[]): Promise<string | undefined> {
  if (!env.AI_CENTER_BASE_URL) {
    return undefined;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.AI_CENTER_TIMEOUT_MS);
  let response: Response;

  try {
    response = await fetch(new URL("/chat", env.AI_CENTER_BASE_URL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildChatPayload(messages)),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`AI CENTER timed out after ${env.AI_CENTER_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`AI CENTER /chat request failed: ${response.status}`);
  }

  const body = (await response.json()) as AiCenterChatResponse;

  if (!body.success || !body.data?.content) {
    throw new Error(body.error ?? "AI CENTER /chat returned an empty response");
  }

  return body.data.content;
}

function parseJsonObject<T>(content: string, fallback: T): T {
  const trimmed = content.trim();
  const jsonBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = jsonBlock?.[1] ?? trimmed;

  try {
    return JSON.parse(candidate) as T;
  } catch {
    return fallback;
  }
}

export const aiCenterClient = {
  async extractPendingInformation(input: {
    text: string;
    requestedFields: PendingInformationField[];
    existingValues: PendingInformationValues;
    caseTitle: string;
  }): Promise<PendingInformationExtraction> {
    const fallback = { values: {} };
    try {
      const content = await chatWithAiCenter([
        {
          role: "system",
          content: "คุณเป็นผู้ช่วยสกัดข้อมูลเพิ่มเติมสำหรับเคส Tech Support ตอบกลับเป็น JSON เท่านั้น",
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "extract_requested_customer_information",
            rules: [
              "สกัดเฉพาะข้อมูลที่มีในข้อความล่าสุด ห้ามเดา",
              "ใช้เฉพาะ key ที่ระบุใน requestedFields",
              `key ที่รองรับมีเพียง: ${PENDING_INFORMATION_FIELDS.join(", ")}`,
              "หากไม่พบข้อมูลของ field ใด ให้ไม่ต้องส่ง key นั้นกลับมา",
            ],
            required_schema: { values: "object keyed by requestedFields" },
            ...input,
          }),
        },
      ]);
      if (!content) return fallback;
      const parsed = parseJsonObject<PendingInformationExtraction>(content, fallback);
      return {
        values: sanitizePendingInformationValues(parsed.values as Record<string, unknown>, input.requestedFields),
      };
    } catch (error) {
      console.error({ event: "ai_center_pending_information_extract_failed", message: String(error) });
      return fallback;
    }
  },

  async generateCaseTitle(customerMessage: string): Promise<string> {
    const normalizedMessage = customerMessage.trim();
    const fallback = createSafeFallbackCaseTitle(normalizedMessage);
    if (!normalizedMessage) return fallback;

    try {
      const content = await chatWithAiCenter([
        { role: "system", content: CASE_TITLE_SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            task: "summarize_customer_problem_as_case_title",
            customerMessage: normalizedMessage,
            required_schema: { caseTitle: "string" },
          }),
        },
      ]);

      const result = content ? parseAiCaseTitle(content) : undefined;
      return result?.caseTitle ?? fallback;
    } catch (error) {
      console.error({
        event: "ai_center_case_title_generation_failed",
        message: error instanceof Error ? error.message : "Unexpected AI CENTER error",
        customerMessageLength: normalizedMessage.length,
      });
      return fallback;
    }
  },

  async generateLineContinuationReply(input: {
    replyType?: LineReplyType;
    caseNumber?: string;
    caseTitle?: string;
    originalCustomerText: string;
    latestCustomerMessage?: string;
    recentConversation: string[];
    newCustomerText: string;
    lastBotQuestion?: string;
    currentSummary?: string;
    knownFacts?: string[];
    missingFacts?: string[];
    currentCaseStatus?: string;
    requestedNextQuestion?: string;
    approvedSolutionSteps?: string[];
  }) {
    const replyType = input.replyType ?? "FOLLOW_UP_QUESTION";
    const fallback = replyType === "INITIAL_CASE_ACK"
      ? `รับเรื่องเรียบร้อยแล้วค่ะ\n\nหมายเลขเคส: ${input.caseNumber ?? "-"}\nเรื่อง: ${input.caseTitle ?? "ปัญหาที่แจ้ง"}\n\nทีมงานกำลังตรวจสอบให้นะคะ`
      : replyType === "FOLLOW_UP_ACK"
      ? "รับทราบค่ะ เดี๋ยวส่งข้อมูลนี้ให้ทีม Tech ตรวจสอบต่อให้นะคะ"
      : replyType === "FOLLOW_UP_QUESTION"
      ? (input.missingFacts?.length
        ? `ขอทราบเพิ่มเติมค่ะ ${input.missingFacts.slice(0, 2).join(" และ ")} ได้ไหมคะ`
        : "รับทราบค่ะ เดี๋ยวตรวจสอบข้อมูลนี้ต่อให้นะคะ")
      : replyType === "OUT_OF_SCOPE_REPLY"
      ? "ขออภัยค่ะ เรื่องนี้อยู่นอกขอบเขตการดูแลของทีม Tech Support หากมีปัญหาด้านระบบหรือการใช้งาน แจ้งรายละเอียดมาได้เลยนะคะ"
      : "ขอบคุณสำหรับข้อมูลค่ะ เดี๋ยวทีมงานตรวจสอบต่อจากรายละเอียดนี้ให้นะคะ";

    try {
      const content = await chatWithAiCenter([
        {
          role: "system",
          content: "คุณคือเจ้าหน้าที่ Tech Support ที่ตอบผู้ใช้งานผ่าน LINE เป็นภาษาไทยสุภาพ เป็นกันเอง และต่อเนื่องเหมือนเจ้าหน้าที่จริง ห้ามเปิดเผยข้อมูลภายในระบบ",
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "compose_contextual_line_reply",
            rules: [
              "เลือกแนวทางตาม replyType ที่ระบุ",
              "INITIAL_CASE_ACK ใช้ตอนสร้างเคสใหม่เท่านั้น ต้องแสดงหมายเลขเคสและสรุปปัญหาแบบสั้น ๆ เพียงครั้งนี้ แล้วจบด้วยการแจ้งว่าทีมงานกำลังตรวจสอบ ห้ามถามคำถาม ห้ามขอข้อมูลเพิ่ม และห้ามให้ขั้นตอนแก้ปัญหาหลังสร้างเคส",
              "FOLLOW_UP_ACK ใช้เมื่อข้อความเป็นข้อมูลต่อเนื่องของเคสเดิม ให้ตอบรับสั้น ๆ โดยไม่ถามคำถามและไม่แนะนำขั้นตอนแก้ปัญหา",
              "FOLLOW_UP_QUESTION ใช้เมื่อข้อมูลยังไม่พอ ห้ามแสดงหมายเลขเคสหรือชื่อเรื่องซ้ำ ห้ามทวนข้อความล่าสุดทั้งประโยค ให้ตีความข้อความล่าสุดร่วมกับ lastBotQuestion แล้วถามต่อไม่เกิน 1-2 คำถาม",
              "TROUBLESHOOTING_GUIDANCE ใช้เมื่อมีข้อมูลพอ ให้แนะนำขั้นตอนตรวจสอบที่อ้างอิงจากข้อมูลที่มีเท่านั้น และถามผลหลังทำ ห้ามปิดเคสอัตโนมัติ",
              "TROUBLESHOOTING_GUIDANCE ใช้ได้เฉพาะเมื่อ approvedSolutionSteps มีค่าเท่านั้น ให้ใช้ขั้นตอนที่ยืนยันแล้วนี้เป็นแหล่งข้อมูลเดียว ห้ามแต่งขั้นตอนเพิ่ม",
              "OUT_OF_SCOPE_REPLY ใช้ปฏิเสธอย่างสุภาพและสั้น ๆ โดยไม่สร้างเคส ไม่กล่าวถึงข้อมูลภายในระบบ และไม่ให้ข้อมูลที่ไม่มีหลักฐาน",
              "ถ้ายังไม่มีหลักฐานพอสำหรับคำแนะนำทางเทคนิค ให้รับทราบสั้น ๆ และบอกว่าจะตรวจสอบต่อแทนการเดา",
              "ห้ามพูดเลขเคส ชื่อเรื่อง หรือคำว่าเพิ่มข้อมูลในเคสซ้ำใน FOLLOW_UP_QUESTION และ TROUBLESHOOTING_GUIDANCE",
              "ห้ามพูดว่าบันทึกข้อมูลลงระบบ ห้ามแสดง confidence, category, status ภายใน หรือพูดถึง AI",
              "ห้ามแต่งผลการตรวจสอบ ห้ามรับปากว่าจะแก้ไขได้แน่นอน และถ้าผู้ใช้งานทำตามคำแนะนำแล้วแต่ยังไม่ได้ ให้ตอบรับและบอกว่าจะตรวจสอบต่อ",
              "ใช้ย่อหน้าสั้น ๆ ถ้ามีหลายขั้นตอนให้เรียงเป็นข้อ และลงท้ายด้วย ค่ะ หรือ นะคะ",
              "ตอบเป็นข้อความธรรมดาเท่านั้น ไม่ต้องใส่เครื่องหมายคำพูดและไม่ต้องใส่ JSON",
            ],
            replyType,
            caseNumber: input.caseNumber,
            caseTitle: input.caseTitle,
            latestCustomerMessage: input.latestCustomerMessage ?? input.newCustomerText,
            originalCustomerText: input.originalCustomerText,
            lastBotQuestion: input.lastBotQuestion,
            currentSummary: input.currentSummary,
            knownFacts: input.knownFacts ?? [],
            missingFacts: input.missingFacts ?? [],
            currentCaseStatus: input.currentCaseStatus,
            requestedNextQuestion: input.requestedNextQuestion,
            approvedSolutionSteps: input.approvedSolutionSteps ?? [],
            recentConversation: input.recentConversation,
          }),
        },
      ]);

      const reply = content?.trim();
      if (!reply || reply.length > 700 || reply.includes("http://") || reply.includes("https://")) return fallback;
      let cleanedReply = reply.replace(/^['"]|['"]$/g, "").trim();
      if (replyType !== "INITIAL_CASE_ACK" && input.caseNumber) {
        cleanedReply = cleanedReply.replace(new RegExp(`\\b${input.caseNumber}\\b`, "gi"), "").replace(/\n{3,}/g, "\n\n").trim();
      }
      if (replyType === "INITIAL_CASE_ACK" && /[?？]|ไหม|ขอทราบ|รบกวนส่ง|ลองทำ/iu.test(cleanedReply)) return fallback;
      if ((replyType === "FOLLOW_UP_ACK" || replyType === "OUT_OF_SCOPE_REPLY") && /[?？]|ไหม|ขอทราบ|รบกวนส่ง/iu.test(cleanedReply)) return fallback;
      if (!/(ค่ะ|นะคะ)[.!?]?$/u.test(cleanedReply)) return fallback;
      return cleanedReply;
    } catch (error) {
      console.error({
        event: "ai_center_continuation_reply_failed",
        message: error instanceof Error ? error.message : "Unexpected AI CENTER error",
      });
      return fallback;
    }
  },

  async classifyLineMessageIntent(input: {
    latestMessage: string;
    lastKnownTopic?: string;
    resolvedMessage?: string;
    recentConversation?: Array<{ sender: string; message: string; createdAt?: string }>;
    lastBotMessage?: string;
    lastBotQuestion?: string;
    activeCases: Array<{ id: string; caseNumber: string; title?: string; summary?: string; status: string; updatedAt: string }>;
    recentCases: Array<{ id: string; caseNumber: string; title?: string; summary?: string; status: string; updatedAt: string }>;
    activeCaseNumber?: string;
    conversationState?: string;
    activeCase?: LineConversationCaseContext;
    lastTechInstruction?: string;
    lastTroubleshootingStep?: string;
    knownFacts?: string[];
    troubleshootingStepsTried?: string[];
  }): Promise<LineMessageIntentClassification> {
    const fallback: LineMessageIntentClassification = {
      intent: "UNKNOWN",
      shouldCreateCase: false,
      targetCaseNumber: null,
      matchedActiveCaseId: null,
      shouldAppendToCase: false,
      nextAction: "ASK_CLARIFICATION",
      confidence: 0,
      reason: "AI_CENTER_UNAVAILABLE_OR_INVALID_RESPONSE",
    };

    try {
      const content = await chatWithAiCenter([
        {
          role: "system",
          content: "คุณคือ AI จำแนก intent ของข้อความผู้ใช้งาน LINE สำหรับระบบ Tech Support ตอบเป็น JSON เท่านั้น ห้ามสร้างหรือเปลี่ยนข้อมูลเคส ห้ามถือว่าทุกข้อความเป็นการแจ้งปัญหาใหม่",
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "classify_line_message_intent_before_case_creation",
            allowedIntents: LINE_MESSAGE_INTENTS,
            requiredSchema: {
              intent: "one of allowedIntents",
              shouldCreateCase: "boolean",
              shouldAppendToCase: "boolean",
              nextAction: "ASK_CLOSE_CONFIRMATION | ACKNOWLEDGE_IMPROVEMENT | SEND_UPDATE_TO_TECH | ESCALATE_TO_TECH | ASK_CLARIFICATION | CREATE_CASE | NONE",
              shouldForwardToTeams: "boolean",
              teamsEventType: "NEW_CASE | FOLLOW_UP | OUT_OF_SCOPE_MESSAGE | CASE_QUERY | NONE",
              targetCaseNumber: "string or null",
              matchedActiveCaseId: "active case id or null",
              resolvedMessage: "context-resolved message or null",
              resolvedMeaning: "meaning of the latest message in active-case context or null",
              confidence: "number from 0 to 1",
              reason: "short Thai explanation",
            },
            rules: [
              "Use active-case context before deciding that a message is a new issue. The context contains recent conversation, last Tech instruction, last bot question, known facts, and troubleshooting steps already tried.",
              "When an active case exists, short results such as 'still slow', 'works now', 'better', 'not fixed', and 'worse' are outcomes for that case, not new issues by themselves.",
              "ISSUE_RESOLVED: customer clearly says the original symptom is gone or working. Append to the active case, do not close automatically, nextAction=ASK_CLOSE_CONFIRMATION.",
              "ISSUE_IMPROVED: symptom improved but not confirmed resolved. Append to the active case; nextAction=ACKNOWLEDGE_IMPROVEMENT.",
              "ISSUE_STILL_PRESENT: a tried step did not fix the original symptom. Append to the active case; nextAction=SEND_UPDATE_TO_TECH.",
              "ISSUE_WORSENED: symptom became worse or a new serious symptom appears while troubleshooting. Append to the active case; nextAction=ESCALATE_TO_TECH.",
              "TROUBLESHOOTING_RESULT is a concrete result after an instructed check. FOLLOW_UP_INFORMATION is an answer or additional fact for the active case. Both shouldAppendToCase=true.",
              "If no active-case context exists, or several active cases are equally plausible, use UNKNOWN and nextAction=ASK_CLARIFICATION. Never create a case from an ambiguous short message.",
              "NEW_SUPPORT_ISSUE ใช้เมื่อผู้ใช้แจ้งอาการหรือปัญหาการใช้งานใหม่อย่างชัดเจนเท่านั้น",
              "FOLLOW_UP_EXISTING_CASE ใช้เมื่อข้อความเป็นคำตอบต่อคำถามก่อนหน้า ให้ข้อมูลเพิ่ม หรือแจ้งผลหลังทดลองแก้ปัญหา",
              "คำถามจำนวนเคส ประวัติเคส สถานะเคส หรือรายละเอียดเคส ห้ามสร้างเคสใหม่",
              "คำถามด้านเทคนิคทั่วไปที่ยังไม่ได้แจ้งอาการจริงให้เป็น TECH_GENERAL_QUESTION และห้ามสร้างเคส; ระบบจะขอให้ผู้ใช้แจ้งอาการที่พบแทนการตอบความรู้ทั่วไป",
              "เรื่องการชำระเงิน การโอนเงิน บัตร ใบเสร็จ หรือคืนเงินให้เป็น OUT_OF_SCOPE และห้ามสร้างเคส",
              "เรื่องที่อยู่นอกขอบเขตการดูแลให้เป็น OUT_OF_SCOPE และห้ามสร้างเคส; SMALL_TALK ใช้เฉพาะการคุยเล่นเท่านั้น",
              "คำทักทายและคำขอบคุณห้ามสร้างเคส",
              "ถ้าไม่มั่นใจให้เป็น UNKNOWN และ shouldCreateCase=false",
              "confidence ต่ำกว่า 0.70 ให้ shouldCreateCase=false",
              "ถ้ามีเลขเคส ให้ใส่ targetCaseNumber เฉพาะเลขที่ปรากฏในข้อความ",
              "ถ้ามี active case เดียวและข้อความสั้นเป็นคำตอบต่อคำถามล่าสุด ให้ใช้ FOLLOW_UP_EXISTING_CASE",
              "ต้องพิจารณาข้อความล่าสุดร่วมกับ recentConversation, lastBotQuestion, lastKnownTopic และ resolvedMessage เสมอ",
              "ข้อความสั้น เช่น ช้า, ค้าง, หลุด, ยังไม่ได้, ไฟยังติด หรือเปิดไม่ขึ้น ห้ามเป็น UNKNOWN หากมีหัวข้อเดิมที่เชื่อถือได้",
              "ห้ามเปิดเผยข้อมูลจากเคสอื่น และอย่าเดา target case เมื่อไม่ชัดเจน",
            ],
            ...input,
          }),
        },
      ]);
      if (!content) return fallback;
      const parsed = parseJsonObject<Partial<LineMessageIntentClassification>>(content, fallback);
      const intent = LINE_MESSAGE_INTENTS.includes(parsed.intent as LineMessageIntentName)
        ? parsed.intent as LineMessageIntentName
        : "UNKNOWN";
      const confidence = typeof parsed.confidence === "number"
        ? Math.max(0, Math.min(1, parsed.confidence > 1 ? parsed.confidence / 100 : parsed.confidence))
        : 0;
      const requestedCaseNumber = typeof parsed.targetCaseNumber === "string" ? parsed.targetCaseNumber.trim() : "";
      const requestedActiveCaseId = typeof parsed.matchedActiveCaseId === "string" ? parsed.matchedActiveCaseId.trim() : "";
      const knownCaseNumbers = new Set([...input.activeCases, ...input.recentCases].map((item) => item.caseNumber.toLowerCase()));
      const knownActiveCaseIds = new Set(input.activeCases.map((item) => item.id));
      const nextAction = [
        "ASK_CLOSE_CONFIRMATION",
        "ACKNOWLEDGE_IMPROVEMENT",
        "SEND_UPDATE_TO_TECH",
        "ESCALATE_TO_TECH",
        "ASK_CLARIFICATION",
        "CREATE_CASE",
        "NONE",
      ].includes(parsed.nextAction ?? "")
        ? parsed.nextAction as LineMessageNextAction
        : intent === "ISSUE_RESOLVED"
        ? "ASK_CLOSE_CONFIRMATION"
        : intent === "ISSUE_IMPROVED"
        ? "ACKNOWLEDGE_IMPROVEMENT"
        : intent === "ISSUE_WORSENED"
        ? "ESCALATE_TO_TECH"
        : intent === "ISSUE_STILL_PRESENT" || intent === "TROUBLESHOOTING_RESULT"
        ? "SEND_UPDATE_TO_TECH"
        : intent === "NEW_SUPPORT_ISSUE"
        ? "CREATE_CASE"
        : "ASK_CLARIFICATION";
      return {
        intent,
        shouldCreateCase: intent === "NEW_SUPPORT_ISSUE"
          && parsed.shouldCreateCase === true
          && confidence >= 0.7,
        shouldForwardToTeams: parsed.shouldForwardToTeams === true,
        teamsEventType: parsed.teamsEventType === "NEW_CASE"
          || parsed.teamsEventType === "FOLLOW_UP"
          || parsed.teamsEventType === "OUT_OF_SCOPE_MESSAGE"
          || parsed.teamsEventType === "CASE_QUERY"
          || parsed.teamsEventType === "NONE"
          ? parsed.teamsEventType
          : undefined,
        targetCaseNumber: requestedCaseNumber
          && (input.latestMessage.toLowerCase().includes(requestedCaseNumber.toLowerCase()) || knownCaseNumbers.has(requestedCaseNumber.toLowerCase()))
          ? requestedCaseNumber
          : null,
        matchedActiveCaseId: requestedActiveCaseId && knownActiveCaseIds.has(requestedActiveCaseId) ? requestedActiveCaseId : null,
        resolvedMessage: typeof parsed.resolvedMessage === "string" && parsed.resolvedMessage.trim()
          ? parsed.resolvedMessage.trim()
          : input.resolvedMessage,
        resolvedMeaning: typeof parsed.resolvedMeaning === "string" && parsed.resolvedMeaning.trim()
          ? parsed.resolvedMeaning.trim()
          : undefined,
        shouldAppendToCase: parsed.shouldAppendToCase === true
          || ["ISSUE_RESOLVED", "ISSUE_IMPROVED", "ISSUE_STILL_PRESENT", "ISSUE_WORSENED", "TROUBLESHOOTING_RESULT", "FOLLOW_UP_INFORMATION"].includes(intent),
        nextAction,
        confidence,
        reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "AI จำแนกข้อความแล้ว",
      };
    } catch (error) {
      console.error({ event: "ai_center_line_intent_classification_failed", message: String(error) });
      return fallback;
    }
  },

  async analyzeCaseRelation(input: {
    originalCustomerText: string;
    caseCategory?: string;
    recentConversation: string[];
    newCustomerText: string;
    elapsedHours: number;
    caseStatus?: string;
  }): Promise<CaseRelationAnalysis> {
    const fallback = fallbackCaseRelation(input);
    try {
      const content = await chatWithAiCenter([
        {
          role: "system",
          content: "คุณคือ AI ตรวจสอบว่าข้อความ LINE ใหม่เกี่ยวข้องกับเคสเดิมหรือไม่ ตอบเป็น JSON เท่านั้น",
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "judge_case_relation",
            rules: [
              "ใช้ข้อความต้นฉบับของเคสเป็นหัวเรื่องหลัก",
              "พิจารณาบทสนทนาล่าสุดและสถานะเคสประกอบ",
              "ถ้าเป็นการตอบข้อมูลที่ทีมขอ หรือเป็นปัญหาเดียวกัน ให้ related=true",
              "ถ้าเปลี่ยนหัวเรื่องหรือเป็นปัญหาคนละเรื่อง ให้ related=false",
              "เวลาไม่ใช่เหตุผลเดียวในการตัดสิน: ภายใน 2 ชั่วโมงก็ต้องตรวจเนื้อหา และเกิน 2 ชั่วโมงก็ยังต่อเคสเดิมได้ถ้าเกี่ยวข้อง",
            ],
            required_schema: {
              related: "boolean",
              confidence: "number 0-100",
              reason: "string",
            },
            originalCustomerText: input.originalCustomerText,
            caseCategory: input.caseCategory,
            recentConversation: input.recentConversation,
            newCustomerText: input.newCustomerText,
            elapsedHours: input.elapsedHours,
            caseStatus: input.caseStatus,
          }),
        },
      ]);

      if (!content) return fallback;
      return parseJsonObject<CaseRelationAnalysis>(content, fallback);
    } catch (error) {
      console.error({
        event: "ai_center_case_relation_failed",
        message: error instanceof Error ? error.message : "Unexpected AI CENTER error",
      });
      return fallback;
    }
  },

  async evaluateAutoAnswerSolutionRelevance(input: {
    caseTitle?: string;
    currentSummary?: string;
    recentConversation: string[];
    latestCustomerMessage: string;
    approvedSolutionSteps: string[];
  }): Promise<AutoAnswerSolutionRelevance> {
    const fallback = fallbackAutoAnswerSolutionRelevance();
    try {
      const content = await chatWithAiCenter([
        {
          role: "system",
          content: "You decide whether an already approved support solution is relevant to the customer's newest LINE message. Return JSON only.",
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "judge_auto_answer_solution_relevance",
            rules: [
              "Mark relevant=true only when the newest customer message is clearly about the same symptom, a result of a suggested step, or a direct follow-up to the approved solution.",
              "Mark relevant=false when the customer introduces another problem, a different product or feature, or when context is insufficient.",
              "Never infer relevance merely because the message belongs to the same open case.",
              "When uncertain, return relevant=false.",
            ],
            required_schema: {
              relevant: "boolean",
              confidence: "number 0-100",
              reason: "string",
            },
            caseTitle: input.caseTitle,
            currentSummary: input.currentSummary,
            recentConversation: input.recentConversation,
            latestCustomerMessage: input.latestCustomerMessage,
            approvedSolutionSteps: input.approvedSolutionSteps,
          }),
        },
      ]);

      if (!content) return fallback;
      return parseJsonObject<AutoAnswerSolutionRelevance>(content, fallback);
    } catch (error) {
      console.error({
        event: "ai_center_auto_answer_solution_relevance_failed",
        message: error instanceof Error ? error.message : "Unexpected AI CENTER error",
      });
      return fallback;
    }
  },

  async matchCustomerCaseHistory(input: { newCustomerText: string; candidates: CaseHistoryCandidate[] }): Promise<CaseHistoryMatchDecision> {
    const fallback = fallbackCaseHistoryMatch();
    if (input.candidates.length === 0) return fallback;

    try {
      const content = await chatWithAiCenter([
        {
          role: "system",
          content: "คุณเป็น AI สำหรับตัดสินความเกี่ยวข้องของข้อความผู้ใช้งานและประวัติเคส ตอบเป็น JSON เท่านั้น",
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "match_customer_message_to_case_history",
            rules: [
              "พิจารณาเฉพาะ candidateCases ที่ backend ส่งให้เท่านั้น",
              "ห้ามสร้างหรือเดา caseId และ caseNumber ใหม่",
              "CONTINUE_CASE ใช้เมื่อข้อความเป็นปัญหาเดิมหรือข้อมูลต่อเนื่องของเคสเดียวกัน",
              "NEW_CASE ใช้เมื่อไม่เกี่ยวข้องกับ candidate ใด",
              "UNCERTAIN ใช้เมื่อมีความกำกวมและมี candidate ที่ใกล้เคียงจริง",
              "ต้องใช้เนื้อหา ปัญหา หมวดหมู่ สถานะ และเวลาประกอบ ไม่ใช้เวลาเพียงอย่างเดียว",
            ],
            required_schema: {
              intent: "CONTINUE_CASE | NEW_CASE | UNCERTAIN",
              matchedCaseId: "candidate caseId or null",
              matchedCaseNumber: "candidate caseNumber or null",
              confidence: "number 0-1",
              reason: "string",
              interpretedProblem: "string",
              isSameProblem: "boolean",
            },
            newCustomerText: input.newCustomerText,
            candidateCases: input.candidates,
          }),
        },
      ]);

      if (!content) return fallback;
      const parsed = parseJsonObject<Partial<CaseHistoryMatchDecision>>(content, fallback);
      const intent = parsed.intent === "CONTINUE_CASE" || parsed.intent === "UNCERTAIN" || parsed.intent === "NEW_CASE"
        ? parsed.intent
        : "NEW_CASE";
      const matched = input.candidates.find((candidate) => candidate.caseId === parsed.matchedCaseId);

      return {
        intent: matched ? intent : "NEW_CASE",
        matchedCaseId: matched?.caseId,
        matchedCaseNumber: matched?.caseNumber,
        confidence: normalizeMatchConfidence(parsed.confidence),
        reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : fallback.reason,
        interpretedProblem: typeof parsed.interpretedProblem === "string" ? parsed.interpretedProblem.trim() : "",
        isSameProblem: Boolean(parsed.isSameProblem) && Boolean(matched),
      };
    } catch (error) {
      console.error({
        event: "ai_center_case_history_match_failed",
        message: error instanceof Error ? error.message : "Unexpected AI CENTER error",
      });
      return fallback;
    }
  },

  async analyzeCustomerMessage(input: {
    text: string;
    customerDisplayName?: string;
    conversationContext?: string[];
    caseAnalysisContext?: unknown;
    latestUserClarification?: { content: string; createdAt: string };
    feedbackExamples?: CustomerAnalysisFeedbackExample[];
  }) {
    const fallback = fallbackCustomerAnalysis(input.text);
    const feedbackMemory = {
      positiveUnderstanding: input.feedbackExamples?.filter((item) => item.feedbackType === "ISSUE_UNDERSTANDING" && item.value === "CORRECT").map(feedbackGuidance) ?? [],
      negativeUnderstanding: input.feedbackExamples?.filter((item) => item.feedbackType === "ISSUE_UNDERSTANDING" && item.value === "INCORRECT").map(feedbackGuidance) ?? [],
      positiveSolutionSelection: input.feedbackExamples?.filter((item) => item.feedbackType === "SOLUTION_SELECTION" && item.value === "CORRECT").map(feedbackGuidance) ?? [],
      negativeSolutionSelection: input.feedbackExamples?.filter((item) => item.feedbackType === "SOLUTION_SELECTION" && item.value === "INCORRECT").map(feedbackGuidance) ?? [],
    };
    try {
      const content = await chatWithAiCenter([
      {
        role: "system",
        content:
          "คุณคือ AI วิเคราะห์เคส Tech Support ของระบบ Off ML Project ตอบกลับเป็น JSON เท่านั้น ห้ามมี markdown หรือคำอธิบายเพิ่ม",
      },
      {
        role: "system",
        content: CUSTOMER_ANALYSIS_SYSTEM_INSTRUCTIONS.join(" "),
      },
      {
        role: "user",
        content: JSON.stringify({
          task: "analyze_customer_message",
          required_schema: {
            summary: "string",
            caseTitle: "หัวข้อภาษาไทยสั้น 30-50 ตัวอักษร อิงข้อความผู้ใช้งานเท่านั้น",
            category: "เลือกเพียงหนึ่งหมวดหมู่ภาษาไทยที่ใกล้ที่สุดจาก: ปัญหาการเชื่อมต่อเครือข่าย | ปัญหาการเข้าสู่ระบบ | ปัญหาการอัปเดตสถานะ | ปัญหาฮาร์ดแวร์ | ปัญหาซอฟต์แวร์ | ปัญหาการแสดงข้อมูล | อื่นๆ",
            urgency: "low | medium | high | critical",
            sentiment: "string",
            missingInformation: ["string"],
            suggestedTeamNote: "string",
            extractedSolution: "string; use an empty string when the current case has no confirmed troubleshooting steps",
            confidence: "number 0-100",
          },
          customerDisplayName: input.customerDisplayName,
          conversationContext: input.conversationContext,
          currentConversation: input.conversationContext,
          latestUserClarification: input.latestUserClarification,
          caseAnalysisContext: input.caseAnalysisContext,
          analysisPriority: {
            primary: ["currentConversation", "latestUserClarification"],
            secondary: ["case title", "basic metadata"],
            referenceOnly: ["historicalCaseSummary", "feedbackGuidance"],
          },
          feedbackGuidance: feedbackMemory,
          instructions: CUSTOMER_ANALYSIS_INSTRUCTIONS,
          text: input.text,
        }),
      },
    ]);

      if (!content) return fallback;
      const parsed = parseJsonObject<CustomerMessageAnalysis>(content, fallback);
      return {
        ...parsed,
        caseTitle: shortenCaseTitle(parsed.caseTitle || parsed.summary || input.text),
        category: normalizeCategory(parsed.category),
        status: parsed.confidence < 70 ? "AI_LOW_CONFIDENCE" : "AI_SUCCESS",
      };
    } catch (error) {
      console.error({
        event: "ai_center_customer_analysis_failed",
        message: error instanceof Error ? error.message : "Unexpected AI CENTER error",
      });
      return fallback;
    }
  },

  async generateProblemSummary(input: {
    caseId: string;
    caseTitle?: string;
    category?: string;
    initialCustomerMessage: string;
    customerMessages: string[];
    latestCustomerMessage: string;
    analysisSummaries: string[];
    currentProblemSummary?: string;
  }): Promise<ProblemSummaryResult> {
    const fallback: ProblemSummaryResult = {
      problemSummary: input.currentProblemSummary?.trim() ?? "",
      shouldUpdate: false,
      reason: "AI_CENTER_UNAVAILABLE",
      status: "FAILED",
    };
    try {
      const content = await chatWithAiCenter([
        {
          role: "system",
          content: "คุณมีหน้าที่สรุปปัญหาที่ผู้ใช้งานแจ้งเพื่อแสดงในหน้า Case Inbox สำหรับทีม Tech Support ตอบ JSON เท่านั้น",
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "generate_case_problem_summary",
            rules: [
              "ใช้ข้อมูลจาก caseId ปัจจุบันเท่านั้น",
              "สรุปใจความสำคัญเป็นภาษาไทย 30-100 ตัวอักษร",
              "รักษาความหมายเดิมของผู้ใช้งานและแก้คำสะกดได้",
              "ไม่ต้องใส่หมายเลขเคส คำขึ้นต้นว่าผู้ใช้งานแจ้งว่า หรือคำลงท้ายค่ะ/ครับ",
              "ระบุอุปกรณ์ ระบบ อาการ รหัสข้อผิดพลาด หรือขั้นตอนที่ลองแล้วเมื่อมีข้อมูลรองรับ",
              "ห้ามแต่งสาเหตุและห้ามสรุปว่าปัญหาได้รับการแก้ไขโดยไม่มีหลักฐาน",
              "ข้อความสั้น เช่น โอเค ครับ ขอบคุณ ยังไม่ได้ หรือข้อมูลเวลาอย่างเดียว ห้ามแทนสรุปเดิม",
            ],
            required_schema: {
              problemSummary: "string",
              shouldUpdate: "boolean",
              reason: "string",
            },
            ...input,
          }),
        },
      ]);
      if (!content) return fallback;
      const parsed = parseJsonObject<{ problemSummary?: string; shouldUpdate?: boolean; reason?: string }>(content, {});
      const summary = parsed.problemSummary?.trim() ?? "";
      if (!summary) {
        return {
          ...fallback,
          reason: parsed.reason?.trim() || "EMPTY_PROBLEM_SUMMARY",
          status: "SUCCESS",
        };
      }
      return {
        problemSummary: summary.slice(0, 200),
        shouldUpdate: parsed.shouldUpdate !== false,
        reason: parsed.reason?.trim() || "SUMMARY_CREATED",
        status: "SUCCESS",
      };
    } catch (error) {
      console.error({ event: "ai_center_problem_summary_failed", caseId: input.caseId, message: String(error) });
      return fallback;
    }
  },

  async analyzeTechSolution(input: { techReplyText: string; originalCustomerText?: string }) {
    const fallback = fallbackTechSolution(input.techReplyText);
    try {
      const content = await chatWithAiCenter([
      {
        role: "system",
        content:
          "คุณคือ AI สกัดวิธีแก้ปัญหาจากคำตอบทีม Tech Support และปรับข้อความให้ผู้ใช้งานเข้าใจง่าย ตอบกลับเป็น JSON เท่านั้น",
      },
      {
        role: "user",
        content: JSON.stringify({
          task: "analyze_tech_solution_and_rewrite_customer_reply",
          required_schema: {
            rootCause: "string | undefined",
            solutionSteps: ["string"],
            hasTroubleshootingSteps: "boolean; true only for concrete troubleshooting or resolution steps, never for acknowledgements, status updates, or closing messages",
            teamActions: ["string; concrete internal action already completed by Tech Support. Infer this from the meaning of the full reply, not keyword matching. Capture the completed action and its target, for example recreated a record, corrected access permissions, replaced a damaged file, or adjusted a system setting. Never include greetings, promises, customer instructions, or generic closing statements"],
            rewrittenCustomerText: "string",
            category: "ชื่อหมวดหมู่ภาษาไทยที่เข้าใจง่าย | undefined",
            confidence: "number 0-100",
          },
          originalCustomerText: input.originalCustomerText,
          techReplyText: input.techReplyText,
          rules: [
            "Do not treat a closing message, acknowledgement, status update, or promise to investigate as a solution.",
            "When Tech Support has already completed a concrete internal recovery action, such as restarting a stuck service or reprocessing a file, include that completed action in solutionSteps as the extracted resolution. Return an empty solutionSteps array only when there is no confirmed corrective action.",
            "Classify teamActions semantically from the whole Tech reply, not from a fixed word list. Record completed internal Tech actions even when they are not suitable as customer troubleshooting steps.",
          ],
        }),
      },
    ]);

      if (!content) return fallback;
      const parsed = parseJsonObject<TechSolutionAnalysis>(content, fallback);
      return { ...parsed, category: normalizeCategory(parsed.category) };
    } catch (error) {
      console.error({ event: "ai_center_tech_solution_analysis_failed", message: String(error) });
      return fallback;
    }
  },

  async generateTargetedInfoRequest(input: {
    caseTitle: string;
    category?: string;
    originalCustomerText: string;
    recentConversation: string[];
    requestedText?: string;
  }) {
    const fallback = fallbackInfoRequest(input);
    try {
      const content = await chatWithAiCenter([
        {
          role: "system",
          content: "คุณเป็นเจ้าหน้าที่ Tech Support ที่ขอข้อมูลเพิ่มจากผู้ใช้งานทาง LINE ตอบเป็นข้อความภาษาไทยเพียง 1 ประโยค",
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "write_targeted_information_request",
            rules: [
              "ถามข้อมูลสำคัญที่เกี่ยวข้องไม่เกิน 1-2 รายการ",
              "ห้ามถามข้อมูลที่ผู้ใช้งานให้มาแล้ว",
              "ห้ามใช้คำถามกว้าง ๆ เช่น ขอรายละเอียดเพิ่ม หรือ คุณเจออะไรไปบ้าง",
              "ใช้ภาษาไทยสุภาพและลงท้ายด้วย ค่ะ หรือ นะคะ",
              "ห้ามเพิ่มข้อเท็จจริงที่ไม่มีในบทสนทนา",
              "ตอบเป็นข้อความธรรมดาเท่านั้น",
            ],
            caseTitle: input.caseTitle,
            category: input.category,
            originalCustomerText: input.originalCustomerText,
            recentConversation: input.recentConversation,
            requestedText: input.requestedText,
          }),
        },
      ]);
      const reply = content?.trim().replace(/^['"]|['"]$/g, "");
      if (!reply || reply.length > 240 || !/(ค่ะ|นะคะ)[.!?]?$/u.test(reply)) return fallback;
      return sanitizeCustomerFacingMessage(reply) || fallback;
    } catch (error) {
      console.error({ event: "ai_center_info_request_failed", message: String(error) });
      return fallback;
    }
  },

  async rewriteAdditionalInfoRequest(input: {
    caseNumber: string;
    caseTitle: string;
    caseSummary: string;
    originalCustomerMessage: string;
    conversationHistory: string[];
    customerProvidedInformation: string[];
    previouslyRequestedInformation: string[];
    rawSupportMessage: string;
    currentCaseStatus: string;
  }): Promise<InfoRequestRewrite> {
    const fallbackMessage = sanitizeCustomerFacingMessage(input.rawSupportMessage) || MORE_INFO_REQUEST_FALLBACK;

    try {
      const content = await chatWithAiCenter([
        {
          role: "system",
          content:
            "คุณมีหน้าที่เรียบเรียงข้อความจากทีม Tech Support เพื่อขอข้อมูลเพิ่มเติมผ่าน LINE ตอบกลับเป็น JSON เท่านั้น ห้ามเรียกผู้รับว่า ผู้ใช้งาน หรือ คุณผู้ใช้งาน",
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "rewrite_customer_information_request",
            rules: [
              "รักษาความหมายและเจตนาของข้อความจากทีม Tech Support",
              "ใช้เฉพาะบริบทของเคสนี้ ห้ามปะปนข้อมูลจากเคสอื่น",
              "ใช้ภาษาไทยสุภาพ เป็นธรรมชาติ เข้าใจง่าย และลงท้ายด้วย ค่ะ หรือ นะคะ",
              "ความยาว 1-3 ประโยค ถามเฉพาะข้อมูลที่ต้องการให้ชัดเจน ไม่เกิน 3 รายการ",
              "ห้ามถามข้อมูลที่ผู้ใช้งานให้มาแล้วหรือที่เคยขอไปแล้ว เว้นแต่ข้อมูลนั้นยังไม่ครบ",
              "ห้ามเพิ่มข้อมูลหรือคำขอที่ทีมไม่ได้ระบุ ห้ามรับปากว่าจะแก้ปัญหาได้แน่นอน",
              "ห้ามใช้คำว่า ผู้ใช้งาน, คุณผู้ใช้งาน, เรียนผู้ใช้งาน, เรียนคุณผู้ใช้งาน, เรียนท่าน, ทางผู้ใช้งาน หรือ รบกวนผู้ใช้งาน ในข้อความที่จะแสดงให้ผู้รับ",
              "ไม่ต้องใส่คำขึ้นต้นแบบจดหมายหรือคำเรียกผู้รับโดยตรง",
              "ห้ามอธิบายการทำงานของ AI และส่งกลับเฉพาะข้อความพร้อมแสดงให้ผู้ใช้งาน",
            ],
            required_schema: { rewrittenMessage: "string" },
            ...input,
          }),
        },
      ]);

      if (!content) throw new Error("AI_CENTER_EMPTY_RESPONSE");
      const parsed = parseJsonObject<InfoRequestRewrite>(content, { rewrittenMessage: "" });
      const rewrittenMessage = sanitizeCustomerFacingMessage(parsed.rewrittenMessage?.trim() ?? "");
      if (!rewrittenMessage || rewrittenMessage.length > 600 || !/(ค่ะ|นะคะ)[.!?]?$/u.test(rewrittenMessage)) {
        throw new Error("AI_CENTER_INVALID_REWRITE");
      }

      return { rewrittenMessage };
    } catch (error) {
      console.error({ event: "ai_center_info_request_rewrite_failed", message: String(error) });
      return { rewrittenMessage: fallbackMessage, usedFallback: true };
    }
  },

  async generateMoreInfoRequest(input: {
    caseNumber: string;
    caseTitle: string;
    originalCustomerMessage: string;
    caseSummary: string;
    conversationHistory: string[];
    customerProvidedInformation: string[];
    previouslyRequestedInformation: string[];
    requestedInformation?: string;
  }): Promise<MoreInfoRequestSuggestion> {
    const fallback: MoreInfoRequestSuggestion = {
      suggestedMessage: MORE_INFO_REQUEST_FALLBACK,
      requestedFields: [],
      reason: "AI ไม่สามารถระบุข้อมูลที่ขาดได้",
    };
    try {
      const content = await chatWithAiCenter([
        {
          role: "system",
          content: "คุณช่วยทีม Tech Support สร้างข้อความขอข้อมูลเพิ่มเติมผ่าน LINE ตอบกลับเป็น JSON เท่านั้น ห้ามเรียกผู้รับว่า ผู้ใช้งาน หรือ คุณผู้ใช้งาน",
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "generate_more_information_request",
            required_schema: { suggestedMessage: "string", requestedFields: "string[]", reason: "string" },
            rules: [
              "วิเคราะห์ว่าข้อมูลใดยังขาดจริงจากบริบททั้งหมด",
              "ห้ามถามข้อมูลที่ผู้ใช้งานให้มาแล้วหรือเคยตอบไปแล้ว",
              "ถามไม่เกิน 1-3 รายการ ใช้ภาษาไทยสุภาพ เป็นธรรมชาติ และลงท้ายด้วย ค่ะ หรือ นะคะ",
              "ห้ามใช้คำถามกว้าง เช่น ขอรายละเอียดเพิ่มเติม",
              "ห้ามกล่าวถึง AI หรือรับปากว่าจะแก้ปัญหาได้แน่นอน",
              "ห้ามใช้คำว่า ผู้ใช้งาน, คุณผู้ใช้งาน, เรียนผู้ใช้งาน, เรียนคุณผู้ใช้งาน, เรียนท่าน, ทางผู้ใช้งาน หรือ รบกวนผู้ใช้งาน ในข้อความที่จะแสดงให้ผู้รับ",
              "ไม่ต้องใส่คำขึ้นต้นแบบจดหมายหรือคำเรียกผู้รับโดยตรง",
              "ส่งเฉพาะข้อความที่เจ้าหน้าที่ตรวจสอบก่อนส่งได้",
              `requestedFields ต้องเลือกเฉพาะ key เหล่านี้: ${PENDING_INFORMATION_FIELDS.join(", ")}`,
            ],
            ...input,
          }),
        },
      ]);
      if (!content) return fallback;
      const parsed = parseJsonObject<Partial<MoreInfoRequestSuggestion>>(content, fallback);
      const suggestedMessage = sanitizeCustomerFacingMessage(parsed.suggestedMessage?.trim() ?? "");
      const requestedFields = Array.isArray(parsed.requestedFields)
        ? parsed.requestedFields.filter((field): field is string => typeof field === "string").map((field) => field.trim()).filter(Boolean).slice(0, 3)
        : [];
      if (!suggestedMessage || suggestedMessage.length > 600) return fallback;
      return { suggestedMessage, requestedFields, reason: parsed.reason?.trim() || "AI วิเคราะห์จากข้อมูลในเคสแล้ว" };
    } catch (error) {
      console.error({ event: "ai_center_more_info_generation_failed", message: String(error) });
      return fallback;
    }
  },

  async composeCustomerReply(input: {
    mode: "CUSTOMER_REPLY";
    caseNumber: string;
    caseTitle: string;
    originalCustomerMessage: string;
    latestCustomerMessage: string;
    conversationHistory: string[];
    customerProvidedInformation: string[];
    previouslyRequestedInformation: string[];
    previousReplies: string[];
    caseSummary: string;
    currentCaseStatus: string;
    supportInstruction?: string;
  }): Promise<CustomerReplyComposeSuggestion> {
    const fallback: CustomerReplyComposeSuggestion = {
      suggestedMessage: CUSTOMER_REPLY_FALLBACK,
      suggestedMode: "CUSTOMER_REPLY",
      missingInformation: [],
      reason: "AI ไม่สามารถสร้างร่างคำตอบได้ จึงใช้ข้อความสำรองที่สุภาพ",
      usedFallback: true,
    };

    try {
      const content = await chatWithAiCenter([
        {
          role: "system",
          content: "คุณช่วยทีม Tech Support ร่างข้อความตอบกลับผ่าน LINE ให้ตอบเป็น JSON เท่านั้น ห้ามเรียกผู้รับว่า ผู้ใช้งาน หรือ คุณผู้ใช้งาน",
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "compose_customer_reply_from_latest_customer_message",
            required_schema: {
              suggestedMessage: "string",
              suggestedMode: "CUSTOMER_REPLY | REQUEST_MORE_INFO",
              missingInformation: "string[]",
              reason: "string",
            },
            rules: [
              "อ่าน latestCustomerMessage เป็นหลัก และใช้ conversationHistory เพื่อเข้าใจบริบทของเคสเดียวกัน",
              "ห้ามถามข้อมูลที่ผู้ใช้งานให้มาแล้ว หรือแนะนำขั้นตอนเดิมซ้ำโดยไม่มีเหตุผล",
              "หากผู้ใช้งานตอบคำถามของทีม ให้นำข้อมูลนั้นมาใช้ในคำตอบทันที",
              "ใช้ภาษาไทยสุภาพ เป็นธรรมชาติ เข้าใจง่าย ความยาว 1-4 ประโยค และลงท้ายด้วย ค่ะ หรือ นะคะ",
              "ให้แนวทางตรวจสอบทีละขั้นตอนอย่างกระชับเมื่อมีข้อมูลเพียงพอ",
              "ห้ามแต่งผลการตรวจสอบ ห้ามรับปากว่าจะแก้ไขได้แน่นอน และห้ามกล่าวถึง AI",
              "ใช้ supportInstruction เป็นใจความจากทีม Tech เป็นหลัก ห้ามสร้างวิธีแก้หรือคำถามใหม่ที่ทีมไม่ได้ระบุ",
              "ห้ามใช้คำว่า ผู้ใช้งาน, คุณผู้ใช้งาน, เรียนผู้ใช้งาน, เรียนคุณผู้ใช้งาน, เรียนท่าน, ทางผู้ใช้งาน หรือ รบกวนผู้ใช้งาน ในข้อความที่จะแสดงให้ผู้รับ",
              "ไม่ต้องใส่คำขึ้นต้นแบบจดหมายหรือคำเรียกผู้รับโดยตรง",
              "ห้ามใส่หมายเลขเคสหรือหัวข้อเคสใน suggestedMessage เพราะระบบจะเติมภายหลัง",
              "หากข้อมูลไม่พอจริง ให้ suggestedMode เป็น REQUEST_MORE_INFO, suggestedMessage ว่าง และระบุ missingInformation",
            ],
            ...input,
          }),
        },
      ]);
      if (!content) return fallback;
      const parsed = parseJsonObject<Partial<CustomerReplyComposeSuggestion>>(content, fallback);
      const suggestedMode = parsed.suggestedMode === "REQUEST_MORE_INFO" ? "REQUEST_MORE_INFO" : "CUSTOMER_REPLY";
      const missingInformation = Array.isArray(parsed.missingInformation)
        ? parsed.missingInformation.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean).slice(0, 5)
        : [];
      const suggestedMessage = typeof parsed.suggestedMessage === "string"
        ? sanitizeCustomerFacingMessage(parsed.suggestedMessage)
        : "";
      if (suggestedMode === "CUSTOMER_REPLY" && (!suggestedMessage || suggestedMessage.length > 1000)) return fallback;
      return {
        suggestedMessage,
        suggestedMode,
        missingInformation,
        reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "AI สร้างร่างคำตอบจากบริบทของเคสแล้ว",
        usedFallback: false,
      };
    } catch (error) {
      console.error({ event: "ai_center_customer_reply_compose_failed", message: String(error) });
      return fallback;
    }
  },

  async rewriteCustomerReply(input: {
    caseNumber: string;
    caseTitle: string;
    originalCustomerMessage: string;
    conversationHistory: string[];
    rawSupportMessage: string;
    mode: "NORMAL_REPLY" | "CLOSING_REPLY";
  }): Promise<{ rewrittenMessage: string; usedFallback?: boolean }> {
    const safeRawMessage = sanitizeCustomerFacingMessage(input.rawSupportMessage);
    const fallback = input.mode === "CLOSING_REPLY"
      ? `${safeRawMessage}\n\nระบบกำลังปิดเคสนี้ให้ก่อนนะคะ หากยังพบปัญหาสามารถติดต่อกลับมาได้ค่ะ`
      : safeRawMessage || CUSTOMER_REPLY_FALLBACK;

    try {
      const content = await chatWithAiCenter([
        {
          role: "system",
          content: "คุณเป็นเจ้าหน้าที่ Tech Support ที่ช่วยเรียบเรียงข้อความตอบกลับผ่าน LINE ตอบเป็น JSON เท่านั้น ห้ามเรียกผู้รับว่า ผู้ใช้งาน หรือ คุณผู้ใช้งาน",
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "rewrite_customer_reply",
            required_schema: { rewrittenMessage: "string" },
            rules: [
              "Use polite, natural Thai and preserve the support team's factual meaning.",
              "Do not invent investigation results or promise that the issue is fixed.",
              "NORMAL_REPLY: concise reply for the customer, 1-3 sentences.",
              "CLOSING_REPLY: include the result summary, state that this case is being closed, and say the customer can contact support again if the problem continues.",
              "CLOSING_REPLY: weight rawSupportMessage at 60% as the source of truth for cause, resolution, and prevention. Use conversationHistory at 40% only to make the Thai wording continuous and polite.",
              "CLOSING_REPLY: never replace, contradict, or invent cause, resolution, prevention, investigation results, or promises from conversationHistory. If history conflicts with rawSupportMessage, follow rawSupportMessage.",
              "ใช้ rawSupportMessage เป็นใจความหลัก ห้ามสร้างวิธีแก้หรือผลตรวจสอบใหม่",
              "ห้ามใช้คำว่า ผู้ใช้งาน, คุณผู้ใช้งาน, เรียนผู้ใช้งาน, เรียนคุณผู้ใช้งาน, เรียนท่าน, ทางผู้ใช้งาน หรือ รบกวนผู้ใช้งาน ในข้อความที่จะแสดงให้ผู้รับ",
              "ไม่ต้องใส่คำขึ้นต้นแบบจดหมายหรือคำเรียกผู้รับโดยตรง",
            ],
            ...input,
          }),
        },
      ]);
      if (!content) return { rewrittenMessage: fallback, usedFallback: true };
      const parsed = parseJsonObject<{ rewrittenMessage?: string }>(content, {});
      const rewrittenMessage = parsed.rewrittenMessage?.trim();
      const safeMessage = sanitizeCustomerFacingMessage(rewrittenMessage ?? "");
      return { rewrittenMessage: safeMessage && safeMessage.length <= 1000 ? safeMessage : fallback, usedFallback: !safeMessage || safeMessage.length > 1000 };
    } catch (error) {
      console.error({ event: "ai_center_customer_reply_rewrite_failed", message: String(error) });
      return { rewrittenMessage: fallback, usedFallback: true };
    }
  },

  async reviewTechMessageForCustomer(input: {
    caseNumber: string;
    caseTitle: string;
    customerOriginalMessage: string;
    conversationHistory: string[];
    techMessage: string;
    currentCaseStatus: string;
  }): Promise<TechMessageReview> {
    const fallback = failedTechMessageReview("ไม่สามารถตรวจสอบข้อความทีมก่อนส่งผู้ใช้งานได้");
    try {
      const content = await chatWithAiCenter([
        {
          role: "system",
          content: "คุณมีหน้าที่ตรวจสอบและปรับข้อความจากทีม Tech Support ก่อนส่งให้ผู้ใช้งานผ่าน LINE ตอบ JSON เท่านั้น",
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "review_tech_message_for_customer",
            rules: [
              "เลือก messageType จาก CUSTOMER_REPLY, REQUEST_MORE_INFO, INTERNAL_NOTE, STATUS_UPDATE, RESOLUTION, CLOSE_CASE",
              "ถ้ามีขั้นตอนหรือคำแนะนำให้ผู้ใช้งานลองแก้ปัญหา ให้เลือก CUSTOMER_REPLY, RESOLUTION หรือ CLOSE_CASE ไม่ใช่ STATUS_UPDATE",
              "ใช้ STATUS_UPDATE เฉพาะข้อความแจ้งความคืบหน้าที่ไม่มีแนวทางแก้ปัญหาให้ผู้ใช้งานทำ",
              "ถ้าเป็นข้อความภายในทีมหรือคำสั่ง เช่น ช่วยตรวจสอบให้หน่อย ให้ shouldSendToCustomer=false",
              "หากส่งได้ ให้เรียบเรียงใหม่เป็นไทยสุภาพ กระชับ 1-3 ประโยค และใช้ ค่ะ หรือ นะคะ",
              "ห้ามใช้ ครับ ห้ามเปลี่ยนความหมาย ห้ามแต่งผลตรวจสอบ และห้ามรับปากว่าแก้ได้แน่นอน",
              "ห้ามส่งคำสั่งภายในทีมให้ผู้ใช้งาน",
              "หากไม่แน่ใจ ให้ shouldSendToCustomer=false และอธิบาย reason",
            ],
            required_schema: {
              messageType: "CUSTOMER_REPLY | REQUEST_MORE_INFO | INTERNAL_NOTE | STATUS_UPDATE | RESOLUTION | CLOSE_CASE",
              shouldSendToCustomer: "boolean",
              rewrittenMessage: "string",
              reason: "string",
            },
            ...input,
          }),
        },
      ]);
      if (!content) return fallback;
      const parsed = parseJsonObject<TechMessageReview>(content, fallback);
      const allowedTypes = new Set<TechMessageReview["messageType"]>([
        "CUSTOMER_REPLY", "REQUEST_MORE_INFO", "INTERNAL_NOTE", "STATUS_UPDATE", "RESOLUTION", "CLOSE_CASE",
      ]);
      if (!allowedTypes.has(parsed.messageType)) return fallback;
      if (!parsed.shouldSendToCustomer) return { ...parsed, rewrittenMessage: "" };
      const message = parsed.rewrittenMessage?.trim();
      if (!message || message.length > 600 || !/(ค่ะ|นะคะ)[.!?]?$/u.test(message)) return fallback;
      return { ...parsed, rewrittenMessage: message.replace(/ครับ[.!?]?$/u, "ค่ะ") };
    } catch (error) {
      console.error({ event: "ai_center_tech_message_review_failed", message: String(error) });
      return fallback;
    }
  },
};
