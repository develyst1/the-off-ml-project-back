import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { verifyLineSignature } from "../lib/line-signature";
import { createLineWebhookRoutes, type LineWebhookDependencies } from "./webhooks-line";

const channelSecret = "line-test-secret";

function sign(rawBody: string) {
  return createHmac("sha256", channelSecret).update(rawBody).digest("base64");
}

function postLineWebhook(input: {
  body: unknown;
  signature?: string;
  handleTextMessage?: LineWebhookDependencies["handleTextMessage"];
}) {
  const rawBody = JSON.stringify(input.body);
  const routes = createLineWebhookRoutes({
    channelSecret,
    handleTextMessage: input.handleTextMessage,
  });

  return routes.request("http://localhost/", {
    method: "POST",
    headers: input.signature ? { "x-line-signature": input.signature } : undefined,
    body: rawBody,
  });
}

describe("verifyLineSignature", () => {
  test("accepts a valid signature", () => {
    const rawBody = JSON.stringify({ events: [] });

    expect(
      verifyLineSignature({
        rawBody,
        signature: sign(rawBody),
        channelSecret,
      }),
    ).toBe(true);
  });

  test("rejects an invalid signature", () => {
    const rawBody = JSON.stringify({ events: [] });

    expect(
      verifyLineSignature({
        rawBody,
        signature: "invalid-signature",
        channelSecret,
      }),
    ).toBe(false);
  });

  test("rejects a missing signature", () => {
    const rawBody = JSON.stringify({ events: [] });

    expect(
      verifyLineSignature({
        rawBody,
        signature: undefined,
        channelSecret,
      }),
    ).toBe(false);
  });
});

describe("POST /webhooks/line", () => {
  test("rejects invalid signatures with HTTP 401", async () => {
    const response = await postLineWebhook({
      body: { events: [] },
      signature: "invalid-signature",
    });

    expect(response.status).toBe(401);
  });

  test("rejects missing signatures with HTTP 401", async () => {
    const response = await postLineWebhook({
      body: { events: [] },
    });

    expect(response.status).toBe(401);
  });

  test("accepts empty events verification requests", async () => {
    const body = { destination: "Udestination", events: [] };
    const response = await postLineWebhook({
      body,
      signature: sign(JSON.stringify(body)),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      processed: 0,
    });
  });

  test("normalizes valid text messages", async () => {
    const received: unknown[] = [];
    const body = {
      events: [
        {
          type: "message",
          replyToken: "reply-token-1",
          timestamp: 1720000000000,
          source: { type: "user", userId: "U123" },
          message: {
            id: "msg-1",
            type: "text",
            text: "เข้าใช้งานระบบไม่ได้",
          },
        },
      ],
    };

    const response = await postLineWebhook({
      body,
      signature: sign(JSON.stringify(body)),
      handleTextMessage: async (input) => {
        received.push(input);
        return { processed: true, duplicate: false, caseDetail: undefined };
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      processed: 1,
      skipped: 0,
      duplicates: 0,
    });
    expect(received).toEqual([
      {
        lineUserId: "U123",
        messageId: "msg-1",
        text: "เข้าใช้งานระบบไม่ได้",
        replyToken: "reply-token-1",
        timestamp: 1720000000000,
      },
    ]);
  });

  test("reports duplicate messages without processing them as new", async () => {
    const body = {
      events: [
        {
          type: "message",
          replyToken: "reply-token-1",
          source: { type: "user", userId: "U123" },
          message: { id: "msg-duplicate", type: "text", text: "same text" },
        },
      ],
    };

    const response = await postLineWebhook({
      body,
      signature: sign(JSON.stringify(body)),
      handleTextMessage: async () => ({ processed: false, duplicate: true }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      processed: 0,
      skipped: 0,
      duplicates: 1,
    });
  });

  test("skips unsupported message types", async () => {
    let called = false;
    const body = {
      events: [
        {
          type: "message",
          replyToken: "reply-token-1",
          source: { type: "user", userId: "U123" },
          message: { id: "msg-image", type: "image" },
        },
      ],
    };

    const response = await postLineWebhook({
      body,
      signature: sign(JSON.stringify(body)),
      handleTextMessage: async () => {
        called = true;
        return { processed: true, duplicate: false, caseDetail: undefined };
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      processed: 0,
      skipped: 1,
      duplicates: 0,
    });
    expect(called).toBe(false);
  });
});
