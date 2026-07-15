import { env } from "../config/env";

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
  category: string;
  urgency: "low" | "medium" | "high" | "critical";
  sentiment: string;
  missingInformation: string[];
  suggestedTeamNote: string;
  confidence: number;
};

export type TechSolutionAnalysis = {
  rootCause?: string;
  solutionSteps: string[];
  rewrittenCustomerText: string;
  category?: string;
  confidence: number;
};

export type CaseRelationAnalysis = {
  related: boolean;
  confidence: number;
  reason: string;
};

function fallbackCustomerAnalysis(text: string): CustomerMessageAnalysis {
  return {
    summary: text.length > 120 ? `${text.slice(0, 117)}...` : text,
    category: "uncategorized",
    urgency: "medium",
    sentiment: "unknown",
    missingInformation: [],
    suggestedTeamNote: "ตรวจสอบรายละเอียดเคสและตอบกลับวิธีแก้ไขใน MS Teams",
    confidence: 50,
  };
}

function fallbackTechSolution(text: string): TechSolutionAnalysis {
  return {
    rootCause: undefined,
    solutionSteps: [text],
    rewrittenCustomerText: text,
    category: "uncategorized",
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

  const response = await fetch(new URL("/chat", env.AI_CENTER_BASE_URL), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildChatPayload(messages)),
  });

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
    const fallback = "โอเคค่ะ เดี๋ยวช่วยตรวจสอบต่อให้นะคะ";

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
            category: "string",
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
      return parseJsonObject<CustomerMessageAnalysis>(content, fallback);
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
            category: "string | undefined",
            confidence: "number 0-100",
          },
          originalCustomerText: input.originalCustomerText,
          techReplyText: input.techReplyText,
        }),
      },
    ]);

    if (!content) return fallback;
    return parseJsonObject<TechSolutionAnalysis>(content, fallback);
  },
};
