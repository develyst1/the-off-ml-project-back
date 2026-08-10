import { describe, expect, test } from "bun:test";
import { CUSTOMER_ANALYSIS_INSTRUCTIONS } from "./ai-center-client";

describe("customer analysis latest clarification prompt", () => {
  test("prioritizes a latest correction without hardcoding a domain value", () => {
    const conversation = [
      { sender: "USER", content: "Chrome has the issue." },
      { sender: "TECH", content: "The Chrome behavior is being checked." },
      { sender: "USER", content: "Correction: Chrome works normally; the issue is only on Safari." },
    ];
    const latestUserMessage = [...conversation].reverse().find((message) => message.sender === "USER");
    const instructions = CUSTOMER_ANALYSIS_INSTRUCTIONS.join(" ");

    expect(latestUserMessage?.content).toContain("Safari");
    expect(latestUserMessage?.content).not.toContain("Chrome has the issue");
    expect(instructions).toContain("latestUserClarification");
    expect(instructions).toContain("Current conversation facts always take precedence");
    expect(instructions).not.toContain("50 MB");
    expect(instructions).not.toContain("100 MB");
  });
});
