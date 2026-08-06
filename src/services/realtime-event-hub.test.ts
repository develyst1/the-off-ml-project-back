import { expect, test } from "bun:test";
import { realtimeEventHub } from "./realtime-event-hub";

test("realtime event hub publishes each event id once", () => {
  const received: string[] = [];
  const unsubscribe = realtimeEventHub.subscribe((event) => {
    if (event.name === "conversation.message.created") received.push(event.data.messageId);
  });
  const event = {
    name: "conversation.message.created" as const,
    data: {
      eventId: "test-realtime-message-1",
      messageId: "message-1",
      conversationId: "customer-1",
      userId: "customer-1",
      createdAt: "2026-07-31T00:00:00.000Z",
      direction: "INBOUND" as const,
    },
  };

  realtimeEventHub.publish(event);
  realtimeEventHub.publish(event);
  unsubscribe();

  expect(received).toEqual(["message-1"]);
});
