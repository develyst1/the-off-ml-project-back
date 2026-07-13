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
  async analyzeCustomerMessage(input: { text: string; customerDisplayName?: string }) {
    const fallback = fallbackCustomerAnalysis(input.text);
    const content = await chatWithAiCenter([
      {
        role: "system",
        content:
          "คุณคือ AI วิเคราะห์เคส Tech Support ของระบบ Off Mai ตอบกลับเป็น JSON เท่านั้น ห้ามมี markdown หรือคำอธิบายเพิ่ม",
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
          text: input.text,
        }),
      },
    ]);

    if (!content) return fallback;
    return parseJsonObject<CustomerMessageAnalysis>(content, fallback);
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
