import { env } from "../config/env";

export const lineClient = {
  async getProfile(lineUserId: string): Promise<{ displayName: string; pictureUrl?: string } | undefined> {
    if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
      return undefined;
    }

    const response = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(lineUserId)}`, {
      headers: {
        authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`LINE profile lookup failed: ${response.status} ${errorBody}`);
    }

    const profile = (await response.json()) as { displayName?: string; pictureUrl?: string };
    return profile.displayName ? { displayName: profile.displayName, pictureUrl: profile.pictureUrl } : undefined;
  },

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
