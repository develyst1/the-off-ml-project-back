import type { Message } from "../domain/types";

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
  if (value === "failed") return "FAILED";
  if (value === "pending") return "PENDING";
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
