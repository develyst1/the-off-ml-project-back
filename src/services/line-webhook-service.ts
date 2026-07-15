import type { CaseDetail } from "../domain/types";
import { store } from "../repositories/store";
import { aiCenterClient } from "./ai-center-client";
import { caseService } from "./case-service";
import { lineClient } from "./line-client";
import { teamsClient } from "./teams-client";

export const LINE_ACKNOWLEDGEMENT_TEXT =
  "รับเรื่องเรียบร้อยแล้วค่ะ ทีมงานกำลังตรวจสอบปัญหาให้คุณ";

export const LINE_CONTINUATION_ACKNOWLEDGEMENT_TEXT = "ได้รับข้อมูลเพิ่มเติมแล้วค่ะ ทีมงานจะนำข้อมูลนี้ไปตรวจสอบต่อในเคสเดิม";
export const LINE_CASE_CONFIRMATION_TEXT = "ข้อความนี้ดูเหมือนเป็นปัญหาใหม่ ต้องการเปิดเคสใหม่ หรือเพิ่มข้อมูลในเคสเดิมคะ?";
export const LINE_FIRST_CASE_ACKNOWLEDGEMENT_TEXT = "รับเรื่องเรียบร้อยแล้วค่ะ ทีมงานกำลังตรวจสอบปัญหาให้คุณ";

export type LineTextMessageInput = {
  lineUserId: string;
  messageId: string;
  text: string;
  displayName?: string;
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

  let displayName = input.displayName;
  if (!displayName) {
    try {
      displayName = (await lineClient.getProfile(input.lineUserId))?.displayName;
    } catch (error) {
      console.warn({ event: "line_profile_lookup_failed", lineUserId: input.lineUserId, error: String(error) });
    }
  }

  const customer = await store.upsertCustomer({
    lineUserId: input.lineUserId,
    displayName,
  });

  const activeCase = await caseService.getActiveLineCase(customer);
  if (activeCase && customer.activeCaseId !== activeCase.id) {
    await store.setActiveCase(customer.id, activeCase.id);
  }
  const confirmsNewCase = activeCase?.status === "awaiting_confirmation"
    && /(ปัญหาใหม่|เรื่องใหม่|เคสใหม่|เปิดเคสใหม่|แยกเคส|new issue|new case)/i.test(input.text);
  const intakeText = confirmsNewCase
    ? activeCase?.messages.filter((message) => message.direction === "inbound_customer").at(-1)?.originalText ?? input.text
    : input.text;
  const confirmsExistingCase = activeCase?.status === "awaiting_confirmation"
    && /(เคสเดิม|เรื่องเดิม|ข้อมูลเพิ่มเติม|ต่อเรื่องเดิม|same case|same issue)/i.test(input.text);

  if (confirmsNewCase && activeCase) {
    await store.createMessage({
      caseId: activeCase.id,
      direction: "inbound_customer",
      channel: "line",
      originalText: input.text,
      externalMessageId: input.messageId,
    });
    await store.updateCase(activeCase.id, { status: "closed" });
    await store.setActiveCase(customer.id);
  }

  const relatedCase = confirmsExistingCase
    ? activeCase
    : await caseService.findRelatedLineCase({
        customerId: customer.id,
        newText: intakeText,
        receivedAt: input.timestamp ? new Date(input.timestamp).toISOString() : undefined,
      });

  if (relatedCase) {
    const caseDetail = await caseService.appendLineMessageToCase({
      caseId: relatedCase.id,
      text: intakeText,
      externalMessageId: input.messageId,
    });

    console.log({
      event: "line_webhook_message_attached_to_existing_case",
      lineUserId: input.lineUserId,
      lineMessageId: input.messageId,
      caseId: relatedCase.id,
      timestamp: input.timestamp,
    });

    await lineClient.replyToToken({
      replyToken: input.replyToken,
      text: LINE_CONTINUATION_ACKNOWLEDGEMENT_TEXT,
    });

    return {
      processed: true,
      duplicate: false,
      caseDetail,
    };
  }

  if (activeCase && !confirmsNewCase) {
    const caseDetail = await caseService.requestCaseSplitConfirmation({
      caseId: activeCase.id,
      text: input.text,
      externalMessageId: input.messageId,
      relation: { confidence: 0, reason: "AI ตรวจพบว่าอาจเป็นหัวข้อใหม่ จึงรอให้ลูกค้ายืนยัน" },
    });
    await lineClient.replyToToken({ replyToken: input.replyToken, text: LINE_CASE_CONFIRMATION_TEXT });
    return { processed: true, duplicate: false, caseDetail };
  }

  const supportCase = await store.createCase({
    customerId: customer.id,
    status: "new",
  });

  await store.updateCase(supportCase.id, {
    status: "analyzing",
  });

  const message = await store.createMessage({
    caseId: supportCase.id,
    direction: "inbound_customer",
    channel: "line",
    originalText: intakeText,
    externalMessageId: input.messageId,
  });

  const analysis = await aiCenterClient.analyzeCustomerMessage({
    text: intakeText,
    customerDisplayName: customer.displayName,
  });

  await store.createAnalysis({
    caseId: supportCase.id,
    messageId: message.id,
    analysisType: "customer_message",
    summary: analysis.summary,
    category: analysis.category,
    confidence: analysis.confidence,
    rawJson: analysis,
  });

  await store.updateCase(supportCase.id, {
    status: "awaiting_tech",
    category: analysis.category,
    priority: analysis.urgency,
    confidenceScore: analysis.confidence,
  });
  await store.setActiveCase(customer.id, supportCase.id);

  console.log({
    event: "line_webhook_case_created",
    lineUserId: input.lineUserId,
    lineMessageId: input.messageId,
    caseId: supportCase.id,
    timestamp: input.timestamp,
  });

  await lineClient.replyToToken({
    replyToken: input.replyToken,
    text: LINE_FIRST_CASE_ACKNOWLEDGEMENT_TEXT,
  });

  const caseDetail = await store.getCaseDetail(supportCase.id);
  if (caseDetail) {
    try {
      await teamsClient.notifyCase(caseDetail);
      await store.updateCase(supportCase.id, {
        teamsDeliveryStatus: "accepted",
        teamsDeliveryAt: new Date().toISOString(),
        teamsDeliveryError: undefined,
      });
    } catch (error) {
      await store.updateCase(supportCase.id, {
        teamsDeliveryStatus: "failed",
        teamsDeliveryAt: new Date().toISOString(),
        teamsDeliveryError: error instanceof Error ? error.message : String(error),
      });
      console.error({ event: "teams_case_delivery_failed", caseId: supportCase.id, error: String(error) });
    }
  }

  return {
    processed: true,
    duplicate: false,
    caseDetail,
  };
}
