import type { CaseDetail } from "../domain/types";
import { store } from "../repositories/store";
import { lineClient } from "./line-client";

export const LINE_ACKNOWLEDGEMENT_TEXT =
  "รับเรื่องเรียบร้อยแล้วค่ะ ทีมงานกำลังตรวจสอบปัญหาให้คุณ";

export type LineTextMessageInput = {
  lineUserId: string;
  messageId: string;
  text: string;
  replyToken?: string;
  timestamp?: number;
};

export type LineTextMessageResult =
  | {
      processed: true;
      duplicate: false;
      caseDetail: CaseDetail | undefined;
    }
  | {
      processed: false;
      duplicate: true;
    };

export async function receiveLineTextMessage(input: LineTextMessageInput): Promise<LineTextMessageResult> {
  const existingMessage = await store.getMessageByExternalMessageId(input.messageId);
  if (existingMessage) {
    console.log({
      event: "line_webhook_duplicate_message",
      lineUserId: input.lineUserId,
      lineMessageId: input.messageId,
    });

    return { processed: false, duplicate: true };
  }

  const customer = await store.upsertCustomer({
    lineUserId: input.lineUserId,
  });

  const supportCase = await store.createCase({
    customerId: customer.id,
    status: "new",
  });

  await store.createMessage({
    caseId: supportCase.id,
    direction: "inbound_customer",
    channel: "line",
    originalText: input.text,
    externalMessageId: input.messageId,
  });

  console.log({
    event: "line_webhook_case_created",
    lineUserId: input.lineUserId,
    lineMessageId: input.messageId,
    caseId: supportCase.id,
    timestamp: input.timestamp,
  });

  await lineClient.replyToToken({
    replyToken: input.replyToken,
    text: LINE_ACKNOWLEDGEMENT_TEXT,
  });

  return {
    processed: true,
    duplicate: false,
    caseDetail: await store.getCaseDetail(supportCase.id),
  };
}
