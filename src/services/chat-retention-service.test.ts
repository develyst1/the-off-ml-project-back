import { expect, test } from "bun:test";
import type { InboxMessage, Message, SupportCase } from "../domain/types";
import { InMemoryStore } from "../repositories/in-memory-store";

const now = new Date("2026-07-27T00:00:00.000Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

function setMessageCreatedAt(store: InMemoryStore, message: Message, createdAt: string) {
  const messages = (store as unknown as { messages: Map<string, Message> }).messages;
  messages.set(message.id, { ...message, createdAt });
}

function setInboxCreatedAt(store: InMemoryStore, message: InboxMessage, createdAt: string) {
  const messages = (store as unknown as { inboxMessages: Map<string, InboxMessage> }).inboxMessages;
  messages.set(message.id, { ...message, createdAt });
}

function setCaseCreatedAt(store: InMemoryStore, supportCase: SupportCase, createdAt: string) {
  const cases = (store as unknown as { cases: Map<string, SupportCase> }).cases;
  const current = cases.get(supportCase.id) ?? supportCase;
  cases.set(supportCase.id, { ...current, createdAt });
}

test("chat retention keeps 13-day messages and deletes 15-day raw messages in batches", async () => {
  const store = new InMemoryStore();
  const customer = await store.upsertCustomer({ lineUserId: "U-retention-1" });
  const supportCase = await store.createCase({ customerId: customer.id, title: "ทดสอบ retention" });
  const retained = await store.createMessage({ caseId: supportCase.id, direction: "INBOUND", channel: "line", originalText: "13 วัน", senderType: "CUSTOMER" });
  const expiredOne = await store.createMessage({ caseId: supportCase.id, direction: "INBOUND", channel: "line", originalText: "15 วัน 1", senderType: "CUSTOMER" });
  const expiredTwo = await store.createMessage({ caseId: supportCase.id, direction: "OUTBOUND", channel: "line", originalText: "15 วัน 2", senderType: "TECH" });
  setMessageCreatedAt(store, retained, daysAgo(13));
  setMessageCreatedAt(store, expiredOne, daysAgo(15));
  setMessageCreatedAt(store, expiredTwo, daysAgo(15));

  const result = await store.deleteExpiredRawMessages({ cutoffAt: new Date(daysAgo(14)), batchSize: 1, dryRun: false });
  const detail = await store.getCaseDetail(supportCase.id);

  expect(result.deletedCaseMessages).toBe(2);
  expect(result.totalDeleted).toBe(2);
  expect(detail?.messages.map((message) => message.originalText)).toEqual(["13 วัน"]);
});

test("chat retention dry run preserves data and keeps closed case summary after deletion", async () => {
  const store = new InMemoryStore();
  const customer = await store.upsertCustomer({ lineUserId: "U-retention-2" });
  const supportCase = await store.createCase({ customerId: customer.id, status: "closed", title: "เคสปิดแล้ว" });
  await store.updateCase(supportCase.id, {
    closedAt: now.toISOString(),
    closeSummary: { cause: "สาเหตุ", resolution: "วิธีแก้", prevention: "วิธีป้องกัน" },
  });
  setCaseCreatedAt(store, supportCase, daysAgo(15));
  const expiredInbox = await store.createInboxMessage({ customerId: customer.id, direction: "INBOUND", senderType: "CUSTOMER", text: "ข้อความ Inbox เก่า" });
  const expiredCaseMessage = await store.createMessage({ caseId: supportCase.id, direction: "INBOUND", channel: "line", originalText: "ข้อความเคสเก่า", senderType: "CUSTOMER" });
  setInboxCreatedAt(store, expiredInbox, daysAgo(15));
  setMessageCreatedAt(store, expiredCaseMessage, daysAgo(15));

  const dryRun = await store.deleteExpiredRawMessages({ cutoffAt: new Date(daysAgo(14)), batchSize: 500, dryRun: true });
  expect(dryRun.totalDeleted).toBe(2);
  expect((store as unknown as { inboxMessages: Map<string, InboxMessage> }).inboxMessages.size).toBe(1);
  expect((await store.getInboxUser(customer.id))?.messages).toHaveLength(0);

  await store.deleteExpiredRawMessages({ cutoffAt: new Date(daysAgo(14)), batchSize: 500, dryRun: false });
  const detail = await store.getCaseDetail(supportCase.id);
  expect(detail).toBeDefined();
  expect(detail?.messages).toHaveLength(0);
  expect(detail?.closeSummary).toEqual({ cause: "สาเหตุ", resolution: "วิธีแก้", prevention: "วิธีป้องกัน" });
});
