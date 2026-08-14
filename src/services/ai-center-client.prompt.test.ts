import { describe, expect, test } from "bun:test";
import { CUSTOMER_ANALYSIS_INSTRUCTIONS, CUSTOMER_ANALYSIS_SYSTEM_INSTRUCTIONS, feedbackGuidance } from "./ai-center-client";

describe("customer analysis latest clarification prompt", () => {
  test("prioritizes a latest correction without hardcoding a domain value", () => {
    const conversation = [
      { sender: "USER", content: "Chrome has the issue." },
      { sender: "TECH", content: "The Chrome behavior is being checked." },
      { sender: "USER", content: "Correction: Chrome works normally; the issue is only on Safari." },
    ];
    const latestUserMessage = [...conversation].reverse().find((message) => message.sender === "USER");
    const instructions = CUSTOMER_ANALYSIS_INSTRUCTIONS.join(" ");
    const systemInstructions = CUSTOMER_ANALYSIS_SYSTEM_INSTRUCTIONS.join(" ");

    expect(latestUserMessage?.content).toContain("Safari");
    expect(latestUserMessage?.content).not.toContain("Chrome has the issue");
    expect(instructions).toContain("latestUserClarification");
    expect(instructions).toContain("Current conversation facts always take precedence");
    expect(instructions).toContain("fixed Tech Support main-category list only");
    expect(instructions).toContain("technicalTopic");
    expect(systemInstructions).toContain("latestUserClarification has the highest factual priority");
    expect(instructions).not.toContain("50 MB");
    expect(instructions).not.toContain("100 MB");
  });

  test("does not send raw historical feedback facts as AI guidance", () => {
    const guidance = feedbackGuidance({
      feedbackType: "ISSUE_UNDERSTANDING",
      value: "INCORRECT",
      aiOutput: "Chrome was the issue in the old case.",
      reason: "Avoid copying historical facts.",
      context: "Chrome has an old case-specific problem.",
    });

    expect(guidance).toEqual({
      feedbackType: "ISSUE_UNDERSTANDING",
      value: "INCORRECT",
      guidance: "Avoid copying historical facts.",
    });
    expect(guidance).not.toHaveProperty("context");
    expect(guidance).not.toHaveProperty("aiOutput");
  });
});
