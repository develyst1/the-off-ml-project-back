import { env } from "../config/env";
import { normalizeCategory } from "../lib/category";

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
  confidence: number;
  status?: "AI_SUCCESS" | "AI_LOW_CONFIDENCE" | "AI_FAILED";
};

export type TechSolutionAnalysis = {
  rootCause?: string;
  solutionSteps: string[];
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
};

export type CaseRelationAnalysis = {
  related: boolean;
  confidence: number;
  reason: string;
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
    solutionSteps: [text],
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
      ? "ลูกค้ากำลังตอบกลับจากคำขอข้อมูลเพิ่มเติมของเคสเดิม"
      : "ยังไม่มีผลวิเคราะห์ความเกี่ยวข้องจาก AI CENTER",
  };
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
  async generateLineContinuationReply(input: { originalCustomerText: string; recentConversation: string[]; newCustomerText: string }) {
    const fallback = "ได้ข้อมูลแล้วค่ะ เดี๋ยวส่งให้ทีมงานตรวจสอบต่อนะคะ";

    try {
      const content = await chatWithAiCenter([
        {
          role: "system",
          content: "คุณเป็นเจ้าหน้าที่ Tech Support ตอบลูกค้าทาง LINE เป็นภาษาไทยแบบสุภาพและเป็นกันเอง ตอบสั้นเพียง 1 ประโยค",
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "write_continuation_acknowledgement",
            rules: [
              "ลงท้ายด้วย ค่ะ หรือ นะคะ",
              "อ้างอิงบริบทจากข้อความก่อนหน้า",
              "สรุปข้อมูลสำคัญที่ลูกค้าเพิ่งให้มาแบบสั้น ๆ โดยห้ามแต่งข้อมูล",
              "ไม่ต้องใช้คำว่า เคสเดิม หรือ ได้รับข้อมูลเพิ่มเติมแล้ว ซ้ำ ๆ",
              "ห้ามแต่งผลการตรวจสอบ ห้ามรับปากว่าจะแก้ไขได้แน่นอน",
              "ถ้าลูกค้าทำตามคำแนะนำแล้วแต่ยังไม่ได้ ให้ตอบรับและบอกว่าจะตรวจสอบต่อ",
              "ตอบเป็นข้อความธรรมดาเท่านั้น ไม่ต้องใส่เครื่องหมายคำพูดและไม่ต้องใส่ JSON",
            ],
            originalCustomerText: input.originalCustomerText,
            recentConversation: input.recentConversation,
            newCustomerText: input.newCustomerText,
          }),
        },
      ]);

      const reply = content?.trim();
      if (!reply || reply.length > 180 || reply.includes("http://") || reply.includes("https://")) return fallback;
      const cleanedReply = reply.replace(/^['"]|['"]$/g, "").trim();
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

  async analyzeCustomerMessage(input: { text: string; customerDisplayName?: string; conversationContext?: string[] }) {
    const fallback = fallbackCustomerAnalysis(input.text);
    try {
      const content = await chatWithAiCenter([
      {
        role: "system",
        content:
          "คุณคือ AI วิเคราะห์เคส Tech Support ของระบบ Off ML Project ตอบกลับเป็น JSON เท่านั้น ห้ามมี markdown หรือคำอธิบายเพิ่ม",
      },
      {
        role: "user",
        content: JSON.stringify({
          task: "analyze_customer_message",
          required_schema: {
            summary: "string",
            caseTitle: "หัวข้อภาษาไทยสั้น 30-50 ตัวอักษร อิงข้อความลูกค้าเท่านั้น",
            category: "ชื่อหมวดหมู่ภาษาไทยที่เข้าใจง่าย เช่น เข้าสู่ระบบไม่ได้ หรือ ปัญหาการเชื่อมต่อเครือข่าย",
            urgency: "low | medium | high | critical",
            sentiment: "string",
            missingInformation: ["string"],
            suggestedTeamNote: "string",
            confidence: "number 0-100",
          },
          customerDisplayName: input.customerDisplayName,
          conversationContext: input.conversationContext,
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

  async analyzeTechSolution(input: { techReplyText: string; originalCustomerText?: string }) {
    const fallback = fallbackTechSolution(input.techReplyText);
    try {
      const content = await chatWithAiCenter([
      {
        role: "system",
        content:
          "คุณคือ AI สกัดวิธีแก้ปัญหาจากคำตอบทีม Tech Support และปรับข้อความให้ลูกค้าเข้าใจง่าย ตอบกลับเป็น JSON เท่านั้น",
      },
      {
        role: "user",
        content: JSON.stringify({
          task: "analyze_tech_solution_and_rewrite_customer_reply",
          required_schema: {
            rootCause: "string | undefined",
            solutionSteps: ["string"],
            rewrittenCustomerText: "string",
            category: "ชื่อหมวดหมู่ภาษาไทยที่เข้าใจง่าย | undefined",
            confidence: "number 0-100",
          },
          originalCustomerText: input.originalCustomerText,
          techReplyText: input.techReplyText,
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
          content: "คุณเป็นเจ้าหน้าที่ Tech Support ที่ขอข้อมูลเพิ่มจากลูกค้าทาง LINE ตอบเป็นข้อความภาษาไทยเพียง 1 ประโยค",
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "write_targeted_information_request",
            rules: [
              "ถามข้อมูลสำคัญที่เกี่ยวข้องไม่เกิน 1-2 รายการ",
              "ห้ามถามข้อมูลที่ลูกค้าให้มาแล้ว",
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
      return reply;
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
    try {
      const content = await chatWithAiCenter([
        {
          role: "system",
          content:
            "คุณมีหน้าที่เรียบเรียงข้อความจากทีม Tech Support เพื่อขอข้อมูลเพิ่มเติมจากลูกค้าผ่าน LINE ตอบกลับเป็น JSON เท่านั้น",
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
              "ห้ามถามข้อมูลที่ลูกค้าให้มาแล้วหรือที่เคยขอไปแล้ว เว้นแต่ข้อมูลนั้นยังไม่ครบ",
              "ห้ามเพิ่มข้อมูลหรือคำขอที่ทีมไม่ได้ระบุ ห้ามรับปากว่าจะแก้ปัญหาได้แน่นอน",
              "ห้ามอธิบายการทำงานของ AI และส่งกลับเฉพาะข้อความพร้อมแสดงให้ลูกค้า",
            ],
            required_schema: { rewrittenMessage: "string" },
            ...input,
          }),
        },
      ]);

      if (!content) throw new Error("AI_CENTER_EMPTY_RESPONSE");
      const parsed = parseJsonObject<InfoRequestRewrite>(content, { rewrittenMessage: "" });
      const rewrittenMessage = parsed.rewrittenMessage?.trim();
      if (!rewrittenMessage || rewrittenMessage.length > 600 || !/(ค่ะ|นะคะ)[.!?]?$/u.test(rewrittenMessage)) {
        throw new Error("AI_CENTER_INVALID_REWRITE");
      }

      return { rewrittenMessage };
    } catch (error) {
      console.error({ event: "ai_center_info_request_rewrite_failed", message: String(error) });
      throw new Error("AI ไม่สามารถเรียบเรียงข้อความได้ในขณะนี้ คุณยังสามารถแก้ไขและส่งข้อความเดิมได้");
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
    const fallback = failedTechMessageReview("ไม่สามารถตรวจสอบข้อความทีมก่อนส่งลูกค้าได้");
    try {
      const content = await chatWithAiCenter([
        {
          role: "system",
          content: "คุณมีหน้าที่ตรวจสอบและปรับข้อความจากทีม Tech Support ก่อนส่งให้ลูกค้าผ่าน LINE ตอบ JSON เท่านั้น",
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "review_tech_message_for_customer",
            rules: [
              "เลือก messageType จาก CUSTOMER_REPLY, REQUEST_MORE_INFO, INTERNAL_NOTE, STATUS_UPDATE, RESOLUTION, CLOSE_CASE",
              "ถ้ามีขั้นตอนหรือคำแนะนำให้ลูกค้าลองแก้ปัญหา ให้เลือก CUSTOMER_REPLY, RESOLUTION หรือ CLOSE_CASE ไม่ใช่ STATUS_UPDATE",
              "ใช้ STATUS_UPDATE เฉพาะข้อความแจ้งความคืบหน้าที่ไม่มีแนวทางแก้ปัญหาให้ลูกค้าทำ",
              "ถ้าเป็นข้อความภายในทีมหรือคำสั่ง เช่น ช่วยตรวจสอบให้หน่อย ให้ shouldSendToCustomer=false",
              "หากส่งได้ ให้เรียบเรียงใหม่เป็นไทยสุภาพ กระชับ 1-3 ประโยค และใช้ ค่ะ หรือ นะคะ",
              "ห้ามใช้ ครับ ห้ามเปลี่ยนความหมาย ห้ามแต่งผลตรวจสอบ และห้ามรับปากว่าแก้ได้แน่นอน",
              "ห้ามส่งคำสั่งภายในทีมให้ลูกค้า",
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
