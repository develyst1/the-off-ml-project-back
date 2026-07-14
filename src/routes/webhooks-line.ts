import { Hono } from "hono";
import { env } from "../config/env";
import { verifyLineSignature } from "../lib/line-signature";
import { receiveLineTextMessage, type LineTextMessageInput } from "../services/line-webhook-service";

type LineWebhookPayload = {
  destination?: string;
  events?: LineWebhookEvent[];
};

type LineWebhookEvent = {
  type: string;
  replyToken?: string;
  timestamp?: number;
  source?: {
    type: string;
    userId?: string;
    groupId?: string;
    roomId?: string;
  };
  message?: {
    id?: string;
    type: string;
    text?: string;
  };
};

export type LineWebhookDependencies = {
  channelSecret?: string;
  handleTextMessage?: (input: LineTextMessageInput) => Promise<unknown>;
};

export function createLineWebhookRoutes(dependencies: LineWebhookDependencies = {}) {
  const routes = new Hono();

  routes.post("/", async (c) => {
    const channelSecret = dependencies.channelSecret ?? env.LINE_CHANNEL_SECRET;
    if (!channelSecret) {
      console.error({ event: "line_webhook_config_missing", key: "LINE_CHANNEL_SECRET" });
      return c.json({ message: "Server configuration error" }, 500);
    }

    const rawBody = await c.req.text();
    const signature = c.req.header("x-line-signature");
    const isValidSignature = verifyLineSignature({
      rawBody,
      signature,
      channelSecret,
    });

    if (!isValidSignature) {
      console.warn({ event: "line_webhook_invalid_signature", hasSignature: Boolean(signature) });
      return c.json({ message: "Invalid LINE signature" }, 401);
    }

    let payload: LineWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as LineWebhookPayload;
    } catch {
      console.warn({ event: "line_webhook_invalid_json" });
      return c.json({ message: "Invalid JSON payload" }, 400);
    }

    const events = payload.events ?? [];
    if (events.length === 0) {
      console.log({ event: "line_webhook_verification_request" });
      return c.json({ success: true, processed: 0 }, 200);
    }

    let processed = 0;
    let skipped = 0;
    let duplicates = 0;
    const handleTextMessage = dependencies.handleTextMessage ?? receiveLineTextMessage;

    for (const event of events) {
      if (event.type !== "message" || event.message?.type !== "text") {
        skipped += 1;
        console.log({
          event: "line_webhook_unsupported_event",
          eventType: event.type,
          messageType: event.message?.type,
        });
        continue;
      }

      const lineUserId = event.source?.userId;
      const messageId = event.message.id;
      const text = event.message.text;

      if (!lineUserId || !messageId || !text) {
        skipped += 1;
        console.warn({
          event: "line_webhook_missing_required_fields",
          hasLineUserId: Boolean(lineUserId),
          hasMessageId: Boolean(messageId),
          hasText: Boolean(text),
        });
        continue;
      }

      const result = await handleTextMessage({
        lineUserId,
        messageId,
        text,
        replyToken: event.replyToken,
        timestamp: event.timestamp,
      });

      if (typeof result === "object" && result && "duplicate" in result && result.duplicate === true) {
        duplicates += 1;
      } else {
        processed += 1;
      }
    }

    return c.json({ success: true, processed, skipped, duplicates }, 200);
  });

  return routes;
}

export const lineWebhookRoutes = createLineWebhookRoutes();
