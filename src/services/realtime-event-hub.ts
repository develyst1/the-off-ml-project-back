export type ConversationMessageCreatedEvent = {
  eventId: string;
  messageId: string;
  conversationId: string;
  userId: string;
  caseId?: string;
  senderType?: "CUSTOMER" | "TECH" | "BOT" | "SYSTEM";
  createdAt: string;
  direction: "INBOUND" | "OUTBOUND";
};

export type RealtimeEvent = {
  name: "conversation.message.created";
  data: ConversationMessageCreatedEvent;
};

export interface RealtimeEventPublisher {
  publish(event: RealtimeEvent): void;
  subscribe(listener: (event: RealtimeEvent) => void): () => void;
}

/**
 * The in-memory implementation is appropriate for one backend instance.
 * The interface lets us switch this module to Redis Pub/Sub when instances scale out.
 */
class InMemoryRealtimeEventHub implements RealtimeEventPublisher {
  private readonly listeners = new Set<(event: RealtimeEvent) => void>();
  private readonly publishedEventIds = new Set<string>();

  publish(event: RealtimeEvent) {
    if (this.publishedEventIds.has(event.data.eventId)) return;

    this.publishedEventIds.add(event.data.eventId);
    // Keep the bounded dedupe cache from growing for a long-running single instance.
    if (this.publishedEventIds.size > 2_000) {
      const firstEventId = this.publishedEventIds.values().next().value;
      if (firstEventId) this.publishedEventIds.delete(firstEventId);
    }

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.warn({ event: "realtime_listener_failed", error: String(error) });
      }
    }
  }

  subscribe(listener: (event: RealtimeEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const realtimeEventHub: RealtimeEventPublisher = new InMemoryRealtimeEventHub();
