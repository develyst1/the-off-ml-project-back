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

  // Explicitly starting a new case must never enter the old-case selection flow.
  const explicitNewCaseRequest = /(เปิดเคสใหม่|สร้างเคสใหม่|ปัญหาใหม่|เรื่องใหม่|แยกเคส)/i.test(input.text);
  const thaiExplicitNewCase = /(\u0e40\u0e1b\u0e34\u0e14\u0e04\u0e2a\u0e43\u0e2b\u0e21\u0e48|\u0e2a\u0e23\u0e49\u0e32\u0e07\u0e40\u0e04\u0e2a\u0e43\u0e2b\u0e21\u0e48|\u0e1b\u0e31\u0e0d\u0e2b\u0e32\u0e43\u0e2b\u0e21\u0e48|\u0e40\u0e23\u0e37\u0e48\u0e2d\u0e07\u0e43\u0e2b\u0e21\u0e48|\u0e41\u0e22\u0e01\u0e40\u0e04\u0e2a)/i.test(input.text);
  const isNewCaseRequest = thaiExplicitNewCase || input.text.includes("\u0e40\u0e1b\u0e34\u0e14\u0e40\u0e04\u0e2a\u0e43\u0e2b\u0e21\u0e48");
  if (isNewCaseRequest && customer.pendingCaseSelection) {
    await store.setPendingCaseSelection(customer.id);
  }

  const pendingSelection = customer.pendingCaseSelection;
  if (pendingSelection?.mode === "confirm" && pendingSelection.selectedCaseId) {
    if (/^(ใช่|ใช่ค่ะ|ใช่ครับ|ตกลง|ยืนยัน)$/i.test(input.text.trim())) {
      const reopened = await caseService.reopenCase(customer.id, pendingSelection.selectedCaseId);
      return { processed: true, duplicate: false, caseDetail: reopened };
    }
    if (/^(ไม่ใช่|ไม่ใช่ค่ะ|ไม่ใช่ครับ|ยกเลิก)$/i.test(input.text.trim())) {
      await store.setPendingCaseSelection(customer.id);
      const candidates = await caseService.getCustomerCases(customer.id);
      const latest = candidates.slice(0, 3);
      if (latest.length > 0) {
        await caseService.setPendingCaseSelection(customer.id, latest.map((item) => item.id));
        await lineClient.replyToToken({ replyToken: input.replyToken, text: caseService.selectionPrompt(latest) });
        return { processed: true, duplicate: false, caseDetail: undefined };
      }
    }
  }

  if (pendingSelection?.mode === "choose" && /^[1-3]$/.test(input.text.trim())) {
    const selectedCaseId = pendingSelection.candidateCaseIds[Number(input.text.trim()) - 1];
    const selectedCase = selectedCaseId ? await caseService.getCase(selectedCaseId) : undefined;
    if (selectedCase && selectedCase.customerId === customer.id) {
      await caseService.setPendingCaseSelection(customer.id, pendingSelection.candidateCaseIds, selectedCase.id);
      await lineClient.replyToToken({ replyToken: input.replyToken, text: caseService.confirmationPrompt(selectedCase) });
      return { processed: true, duplicate: false, caseDetail: undefined };
    }
  }

  const reopenIntent = !explicitNewCaseRequest && /(เปิดเคส|เปิดเรื่อง|ปัญหาเดิม|เรื่องที่แจ้ง|ยังไม่หาย|เคสที่\s*\d+)/i.test(input.text);
  if (reopenIntent && !isNewCaseRequest) {
    const ordinalMatch = input.text.match(/เคสที่\s*(\d+)/i);
    if (ordinalMatch) {
      const ordinalCases = (await caseService.getCustomerCases(customer.id))
        .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
      const selected = ordinalCases[Number(ordinalMatch[1]) - 1];
      if (selected) {
        await caseService.setPendingCaseSelection(customer.id, [selected.id], selected.id);
        await lineClient.replyToToken({ replyToken: input.replyToken, text: caseService.confirmationPrompt(selected) });
        return { processed: true, duplicate: false, caseDetail: undefined };
      }
    }

    const candidates = await caseService.findReopenCandidates(customer.id, input.text);
    if (candidates.length > 0) {
      await caseService.setPendingCaseSelection(customer.id, candidates.map((item) => item.id));
      await lineClient.replyToToken({ replyToken: input.replyToken, text: caseService.selectionPrompt(candidates) });
      return { processed: true, duplicate: false, caseDetail: undefined };
    }
  }

  const caseNumberMatch = input.text.match(/\bOFF-\d{4}-\d+\b/i);
  if (caseNumberMatch) {
    const referencedCase = await caseService.getCaseByNumber(caseNumberMatch[0]);
    if (referencedCase && referencedCase.customerId === customer.id) {
      await store.updateCase(referencedCase.id, { status: "reopened" });
      const relatedResult = await caseService.appendLineMessageToCase({
        caseId: referencedCase.id,
        text: input.text,
        externalMessageId: input.messageId,
      });
      await lineClient.replyToToken({
        replyToken: input.replyToken,
        text: `เข้าใจแล้วค่ะ เดี๋ยวเปิดเคส ${referencedCase.caseNumber} กลับมาตรวจสอบต่อให้นะคะ`,
      });
      return { processed: true, duplicate: false, caseDetail: relatedResult.detail };
    }
  }

  const activeCase = await caseService.getActiveLineCase(customer);
  if (activeCase && customer.activeCaseId !== activeCase.id) {
    await store.setActiveCase(customer.id, activeCase.id);
  }
  const confirmsNewCase = isNewCaseRequest; /*
    && /(ปัญหาใหม่|เรื่องใหม่|เคสใหม่|เปิดเคสใหม่|แยกเคส|new issue|new case)/i.test(input.text);
  */
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
    const relatedResult = await caseService.appendLineMessageToCase({
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
      text: relatedResult.continuationReply,
    });

    await store.createMessage({
      caseId: relatedCase.id,
      direction: "outbound_customer",
      channel: "line",
      originalText: relatedResult.continuationReply,
      senderType: "BOT",
      deliveryStatus: "sent",
    });

    return {
      processed: true,
      duplicate: false,
      caseDetail: relatedResult.detail,
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
    senderType: "CUSTOMER",
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
    title: analysis.summary.slice(0, 50),
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

  const acknowledgement = `รับเรื่องเรียบร้อยแล้วค่ะ\n\nหมายเลขเคส: ${supportCase.caseNumber}\nเรื่อง: ${analysis.summary.slice(0, 50)}\n\nทีมงานกำลังตรวจสอบให้นะคะ`;
  const acknowledgementDelivery = await lineClient.replyToToken({
    replyToken: input.replyToken,
    text: acknowledgement,
  });

  await store.createMessage({
    caseId: supportCase.id,
    direction: "outbound_customer",
    channel: "line",
    originalText: acknowledgement,
    senderType: "BOT",
    deliveryStatus: acknowledgementDelivery.delivered ? "delivered" : "pending",
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
