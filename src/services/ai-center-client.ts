import { env } from "../config/env";

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

async function postAiCenter<T>(path: string, payload: unknown, fallback: () => T): Promise<T> {
  if (!env.AI_CENTER_BASE_URL) {
    return fallback();
  }

  const response = await fetch(new URL(path, env.AI_CENTER_BASE_URL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(env.AI_CENTER_API_KEY ? { authorization: `Bearer ${env.AI_CENTER_API_KEY}` } : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`AI CENTER request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export const aiCenterClient = {
  analyzeCustomerMessage(input: { text: string; customerDisplayName?: string }) {
    return postAiCenter<CustomerMessageAnalysis>("/ai/analyze-message", input, () => ({
      summary: input.text.length > 120 ? `${input.text.slice(0, 117)}...` : input.text,
      category: "uncategorized",
      urgency: "medium",
      sentiment: "unknown",
      missingInformation: [],
      suggestedTeamNote: "ตรวจสอบรายละเอียดเคสและตอบกลับวิธีแก้ไขใน MS Teams",
      confidence: 50,
    }));
  },

  analyzeTechSolution(input: { techReplyText: string; originalCustomerText?: string }) {
    return postAiCenter<TechSolutionAnalysis>("/ai/analyze-solution", input, () => ({
      rootCause: undefined,
      solutionSteps: [input.techReplyText],
      rewrittenCustomerText: input.techReplyText,
      category: "uncategorized",
      confidence: 50,
    }));
  },
};
