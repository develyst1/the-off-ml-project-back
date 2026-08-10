import type { Message } from "../domain/types";

const stableMessageIdentityKeys = [
  "sourceInboxMessageId",
  "inboxMessageId",
  "lineMessageId",
  "externalMessageId",
  "webhookEventId",
] as const;

/**
 * Returns the identity used by Analysis.sourceMessageIds. Case timeline rows
 * may be copies of Inbox rows, so prefer the canonical Inbox identity when it
 * is available and fall back to the case message id for legacy rows.
 */
export function analysisMessageIdentity(message: Pick<Message, "id" | "metadata">) {
  for (const key of ["sourceInboxMessageId", "inboxMessageId"] as const) {
    const value = message.metadata?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return message.id;
}

function stableMessageIdentity(message: Pick<Message, "metadata" | "externalMessageId" | "webhookEventId">) {
  for (const key of stableMessageIdentityKeys) {
    const value = key === "externalMessageId"
      ? message.externalMessageId
      : key === "webhookEventId"
        ? message.webhookEventId
        : message.metadata?.[key];
    if (typeof value === "string" && value.trim()) return `${key}:${value}`;
  }
  return undefined;
}

function isFailedMessage(message: Pick<Message, "deliveryStatus">) {
  return message.deliveryStatus?.toUpperCase() === "FAILED";
}

function canonicalMessagePriority(message: Pick<Message, "channel" | "senderType" | "direction" | "deliveryStatus">) {
  const isLineParticipant = message.channel === "line" && (message.senderType === "CUSTOMER" || message.senderType === "TECH");
  return (isLineParticipant ? 4 : message.channel === "line" ? 3 : 1) + (isFailedMessage(message) ? 0 : 1);
}

/**
 * Case messages can contain a legacy copied row and the canonical Inbox row.
 * Collapse only rows with a stable source identity; identical text is not an
 * identity because two separate LINE messages may legitimately have the same text.
 */
export function dedupeCaseMessages(messages: Message[]) {
  const result: Message[] = [];
  const indexByIdentity = new Map<string, number>();

  for (const message of messages) {
    const identity = stableMessageIdentity(message);
    if (!identity) {
      result.push(message);
      continue;
    }

    const existingIndex = indexByIdentity.get(identity);
    if (existingIndex === undefined) {
      indexByIdentity.set(identity, result.length);
      result.push(message);
      continue;
    }

    // If an optimistic/failed copy and a delivered copy share the same source,
    // keep the delivered record in the timeline.
    if (canonicalMessagePriority(message) > canonicalMessagePriority(result[existingIndex])) {
      result[existingIndex] = message;
    }
  }

  // A console reply historically created an internal raw row and a delivered
  // LINE row. The LINE row is canonical for the conversation; keep the raw row
  // for analysis linkage but do not render it as a second conversation bubble.
  const referencedSourceIds = new Set(
    result
      .map((message) => message.sourceMessageId)
      .filter((sourceMessageId): sourceMessageId is string => Boolean(sourceMessageId)),
  );
  return result.filter((message) => !(
    message.direction === "INTERNAL"
    && message.messageType === "TECH_RAW_REPLY"
    && referencedSourceIds.has(message.id)
  ));
}

const legacyDirection: Record<string, "INBOUND" | "OUTBOUND" | "INTERNAL"> = {
  inbound_customer: "INBOUND",
  inbound_tech: "INBOUND",
  outbound_customer: "OUTBOUND",
  outbound_tech: "OUTBOUND",
};

function inferredMessageType(input: Omit<Message, "id" | "createdAt">): NonNullable<Message["messageType"]> {
  if (input.messageType) return input.messageType;
  if (input.senderType === "CUSTOMER") return "CUSTOMER_MESSAGE";
  if (input.senderType === "TECH") return "TECH_RAW_REPLY";
  if (input.senderType === "BOT") return "CASE_ACKNOWLEDGEMENT";
  return "SYSTEM_EVENT";
}

function normalizeDeliveryStatus(direction: "INBOUND" | "OUTBOUND" | "INTERNAL", value?: Message["deliveryStatus"]): NonNullable<Message["deliveryStatus"]> {
  if (direction === "INBOUND") return "RECEIVED";
  if (direction === "INTERNAL") return "PROCESSED";
  if (value === "FAILED" || value === "failed") return "FAILED";
  if (value === "DELIVERED" || value === "delivered") return "DELIVERED";
  if (value === "SENT" || value === "sent") return "SENT";
  if (value === "PENDING" || value === "pending") return "PENDING";
  return "API_ACCEPTED";
}

export function normalizeCaseMessage(input: Omit<Message, "id" | "createdAt">) {
  const direction = legacyDirection[input.direction] ?? input.direction as "INBOUND" | "OUTBOUND" | "INTERNAL";
  const messageType = inferredMessageType(input);
  const isVisibleToCustomer = input.isVisibleToCustomer ?? ![
    "TECH_RAW_REPLY",
    "AI_REWRITTEN_REPLY",
    "INTERNAL_NOTE",
    "SYSTEM_EVENT",
    "CUSTOMER_REWRITE",
  ].includes(messageType);
  const now = new Date().toISOString();
  const deliveryStatus = normalizeDeliveryStatus(direction, input.deliveryStatus);

  return {
    ...input,
    direction,
    contentType: input.contentType ?? "TEXT",
    messageType,
    displayText: input.displayText ?? input.originalText,
    isVisibleToCustomer,
    deliveryStatus,
    receivedAt: input.receivedAt ?? (direction === "INBOUND" ? now : undefined),
    processedAt: input.processedAt ?? (direction === "INBOUND" || direction === "INTERNAL" ? now : undefined),
    sentAt: input.sentAt ?? (direction === "OUTBOUND" && deliveryStatus === "API_ACCEPTED" ? now : undefined),
    failedAt: input.failedAt ?? (deliveryStatus === "FAILED" ? now : undefined),
    retryCount: input.retryCount ?? 0,
  };
}
