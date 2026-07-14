import { env } from "../config/env";

export const lineClient = {
  async replyToToken(input: { replyToken: string | undefined; text: string }): Promise<{ delivered: boolean }> {
    if (!input.replyToken) {
      return { delivered: false };
    }

    if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
      console.log("[line:mock:reply-token]", { hasReplyToken: true, text: input.text });
      return { delivered: false };
    }

    const response = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        replyToken: input.replyToken,
        messages: [{ type: "text", text: input.text }],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`LINE reply failed: ${response.status} ${errorBody}`);
    }

    return { delivered: true };
  },

  async reply(input: { lineUserId: string; text: string }): Promise<{ delivered: boolean }> {
    if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
      console.log("[line:mock]", input);
      return { delivered: false };
    }

    const response = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        to: input.lineUserId,
        messages: [{ type: "text", text: input.text }],
      }),
    });

    if (!response.ok) {
      throw new Error(`LINE reply failed: ${response.status}`);
    }

    return { delivered: true };
  },
};
