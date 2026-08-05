import { Hono } from "hono";
import { store } from "../repositories/store";
import { caseService } from "../services/case-service";
import { lineClient } from "../services/line-client";
import { realtimeEventHub } from "../services/realtime-event-hub";

type InboxReplyBody = { text?: string };
type OpenCaseBody = {
  title?: string;
  description?: string;
  from?: string;
  to?: string;
  selectedMessageIds?: string[];
};
type InboxAiComposeBody = { mode?: "DRAFT" | "REWRITE"; rawSupportMessage?: string };
type InboxCaseComposeBody = {
  mode?: "DRAFT" | "REWRITE";
  selectedMessageIds?: string[];
  title?: string;
  description?: string;
};

export const inboxRoutes = new Hono();

inboxRoutes.get("/", async (c) => c.json({ data: await store.listInboxUsers() }));

inboxRoutes.get("/:customerId", async (c) => {
  const user = await store.getInboxUser(c.req.param("customerId"));
  if (!user) return c.json({ error: "inbox_user_not_found" }, 404);
  return c.json({ data: user });
});

inboxRoutes.post("/messages/:messageId/assign-case", async (c) => {
  const body: { caseId?: string; assignedBy?: string } = await c.req.json<{ caseId?: string; assignedBy?: string }>().catch(() => ({}));
  if (!body.caseId?.trim()) return c.json({ error: "case_id_required" }, 400);
  return c.json({ data: await caseService.assignInboxMessageToCase({
    messageId: c.req.param("messageId"),
    caseId: body.caseId,
    assignedBy: body.assignedBy?.trim() || "Tech Support Console",
  }) });
});

inboxRoutes.post("/:customerId/read", async (c) => {
  const customerId = c.req.param("customerId");
  const user = await store.getInboxUser(customerId);
  if (!user) return c.json({ error: "inbox_user_not_found" }, 404);
  await store.markInboxRead(customerId);
  return c.json({ data: await store.getInboxUser(customerId) });
});

inboxRoutes.post("/:customerId/reply", async (c) => {
  const customerId = c.req.param("customerId");
  const user = await store.getInboxUser(customerId);
  if (!user) return c.json({ error: "inbox_user_not_found" }, 404);

  const body = await c.req.json<InboxReplyBody>();
  const text = body.text?.trim();
  if (!text) return c.json({ error: "text_required" }, 400);

  let delivery: { delivered: boolean };
  try {
    delivery = await lineClient.reply({ lineUserId: user.customer.lineUserId, text });
    if (!delivery.delivered) throw new Error("LINE did not confirm delivery");
  } catch (error) {
    const failedMessage = await store.createInboxMessage({
      customerId,
      direction: "OUTBOUND",
      senderType: "TECH",
      text,
      deliveryStatus: "FAILED",
      deliveryError: error instanceof Error ? error.message : String(error),
    });
    await caseService.linkInboxMessageToActiveCase(customerId, failedMessage);
    return c.json({ error: "line_reply_failed" }, 502);
  }

  const sentAt = new Date().toISOString();
  const inboxMessage = await store.createInboxMessage({
    customerId,
    direction: "OUTBOUND",
    senderType: "TECH",
    text,
    deliveryStatus: "SENT",
    sentAt,
    deliveredAt: sentAt,
    createdAt: sentAt,
  });
  const linkedCase = await caseService.linkInboxMessageToActiveCase(customerId, inboxMessage);
  if (linkedCase) await caseService.refreshExtractedSolution(linkedCase.id);
  realtimeEventHub.publish({
    name: "conversation.message.created",
    data: {
      eventId: `inbox:${inboxMessage.id}`,
      messageId: inboxMessage.id,
      conversationId: customerId,
      userId: customerId,
      createdAt: inboxMessage.createdAt,
      direction: inboxMessage.direction,
    },
  });
  await store.setConversationState(customerId, "HANDOFF_TO_TECH");
  return c.json({ data: await store.getInboxUser(customerId) });
});

inboxRoutes.post("/:customerId/open-case", async (c) => {
  const body: OpenCaseBody = await c.req.json<OpenCaseBody>().catch(() => ({}));
  const detail = await caseService.openCaseFromInbox(c.req.param("customerId"), body);
  return c.json({ data: detail }, 201);
});

inboxRoutes.post("/:customerId/ai-compose", async (c) => {
  const body: InboxAiComposeBody = await c.req.json<InboxAiComposeBody>().catch(() => ({} as InboxAiComposeBody));
  const mode = body.mode === "REWRITE" ? "REWRITE" : "DRAFT";
  if (mode === "REWRITE" && !body.rawSupportMessage?.trim()) {
    return c.json({ error: "raw_support_message_required" }, 400);
  }

  try {
    return c.json({
      data: await caseService.composeInboxReply({
        customerId: c.req.param("customerId"),
        mode,
        rawSupportMessage: body.rawSupportMessage,
      }),
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "ai_compose_failed" }, 502);
  }
});

inboxRoutes.post("/:customerId/ai-compose-case", async (c) => {
  const body: InboxCaseComposeBody = await c.req.json<InboxCaseComposeBody>().catch(() => ({}));
  if (!body.selectedMessageIds?.length && !body.title?.trim() && !body.description?.trim()) {
    return c.json({ error: "case_content_or_selected_messages_required" }, 400);
  }

  try {
    return c.json({
      data: await caseService.composeInboxCaseDraft({
        customerId: c.req.param("customerId"),
        mode: body.mode === "REWRITE" ? "REWRITE" : "DRAFT",
        selectedMessageIds: body.selectedMessageIds ?? [],
        title: body.title,
        description: body.description,
      }),
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "ai_case_compose_failed" }, 502);
  }
});
