import { Hono } from "hono";
import { store } from "../repositories/store";
import { caseService } from "../services/case-service";
import { lineClient } from "../services/line-client";

type InboxReplyBody = { text?: string };
type OpenCaseBody = { title?: string };

export const inboxRoutes = new Hono();

inboxRoutes.get("/", async (c) => c.json({ data: await store.listInboxUsers() }));

inboxRoutes.get("/:customerId", async (c) => {
  const user = await store.getInboxUser(c.req.param("customerId"));
  if (!user) return c.json({ error: "inbox_user_not_found" }, 404);
  return c.json({ data: user });
});

inboxRoutes.post("/:customerId/reply", async (c) => {
  const customerId = c.req.param("customerId");
  const user = await store.getInboxUser(customerId);
  if (!user) return c.json({ error: "inbox_user_not_found" }, 404);

  const body = await c.req.json<InboxReplyBody>();
  const text = body.text?.trim();
  if (!text) return c.json({ error: "text_required" }, 400);

  await lineClient.reply({ lineUserId: user.customer.lineUserId, text });
  await store.createInboxMessage({
    customerId,
    direction: "OUTBOUND",
    senderType: "TECH",
    text,
  });
  return c.json({ data: await store.getInboxUser(customerId) });
});

inboxRoutes.post("/:customerId/open-case", async (c) => {
  const body: OpenCaseBody = await c.req.json<OpenCaseBody>().catch(() => ({ title: undefined }));
  const detail = await caseService.openCaseFromInbox(c.req.param("customerId"), body.title);
  return c.json({ data: detail }, 201);
});
