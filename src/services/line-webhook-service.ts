import type { CaseDetail, Customer, PendingCaseSelection } from "../domain/types";
import {
  PENDING_INFORMATION_FIELDS,
  buildMissingInformationQuestion,
  extractPendingInformationFallback,
  formatPendingInformation,
  getMissingPendingInformationFields,
  type PendingInformationField,
  type PendingInformationValues,
} from "../lib/pending-information";
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
  webhookEventId?: string;
  systemReceivedAt?: string;
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

function getPendingInformationFields(selection: PendingCaseSelection): PendingInformationField[] {
  const requested = selection.pendingRequestedFields?.filter((field): field is PendingInformationField =>
    PENDING_INFORMATION_FIELDS.includes(field as PendingInformationField),
  ) ?? [];
  return requested.length > 0 ? requested : ["additionalDetails"];
}

function getStoredPendingInformation(selection: PendingCaseSelection): PendingInformationValues {
  const stored = selection.pendingCollectedFields ?? {};
  return Object.fromEntries(
    Object.entries(stored).filter(([field, value]) =>
      PENDING_INFORMATION_FIELDS.includes(field as PendingInformationField) && typeof value === "string" && value.trim(),
    ),
  ) as PendingInformationValues;
}

async function handlePendingInformationResponse(
  input: LineTextMessageInput,
  customer: Customer,
  selection: PendingCaseSelection,
): Promise<LineTextMessageResult | undefined> {
  const caseId = selection.pendingCaseId ?? selection.selectedCaseId ?? selection.candidateCaseIds[0];
  if (!caseId) {
    await store.setPendingCaseSelection(customer.id);
    return undefined;
  }

  const caseDetail = await caseService.getCase(caseId);
  if (!caseDetail || caseDetail.customerId !== customer.id) {
    await store.setPendingCaseSelection(customer.id);
    return undefined;
  }

  const requestedFields = getPendingInformationFields(selection);
  const existingValues = getStoredPendingInformation(selection);
  const [aiExtraction, fallbackValues] = await Promise.all([
    aiCenterClient.extractPendingInformation({
      text: input.text,
      requestedFields,
      existingValues,
      caseTitle: caseService.formatCaseTitle(caseDetail),
    }),
    Promise.resolve(extractPendingInformationFallback({ text: input.text, requestedFields })),
  ]);
  const collectedValues = { ...existingValues, ...aiExtraction.values, ...fallbackValues };
  const missingFields = getMissingPendingInformationFields(requestedFields, collectedValues);
  const relatedResult = await caseService.appendLineMessageToCase({
    caseId,
    text: input.text,
    externalMessageId: input.messageId,
    webhookEventId: input.webhookEventId,
    receivedAt: input.timestamp ? new Date(input.timestamp).toISOString() : input.systemReceivedAt,
  });
  const collectedText = formatPendingInformation(collectedValues);

  if (collectedText) {
    await store.createMessage({
      caseId,
      direction: "INTERNAL",
      channel: "system",
      originalText: `ข้อมูลเพิ่มเติมที่สกัดได้: ${collectedText}`,
      senderType: "SYSTEM",
      messageType: "SYSTEM_EVENT",
      isVisibleToCustomer: false,
      deliveryStatus: "PROCESSED",
    });
  }

  if (missingFields.length > 0) {
    const question = buildMissingInformationQuestion(missingFields);
    const reply = `ขอข้อมูลเพิ่มเติมสำหรับเคส ${caseDetail.caseNumber}\n\n${question}`;
    const delivery = await lineClient.replyToToken({ replyToken: input.replyToken, text: reply });
    await store.createMessage({
      caseId,
      direction: "outbound_customer",
      channel: "line",
      originalText: reply,
      senderType: "BOT",
      messageType: "REQUEST_MORE_INFO",
      isVisibleToCustomer: true,
      deliveryStatus: delivery.delivered ? "delivered" : "pending",
    });
    await store.updateCase(caseId, { status: "awaiting_customer_info" });
    await store.setPendingCaseSelection(customer.id, {
      ...selection,
      mode: "request_more_info",
      pendingAction: "REQUEST_MORE_INFO",
      pendingCaseId: caseId,
      pendingRequestedFields: requestedFields,
      pendingCollectedFields: collectedValues,
      pendingCreatedAt: selection.pendingCreatedAt ?? new Date().toISOString(),
      createdAt: selection.createdAt ?? new Date().toISOString(),
    });
    await store.setActiveCase(customer.id, caseId);
    return { processed: true, duplicate: false, caseDetail: await caseService.getCase(caseId) };
  }

  const details = collectedText ? `${collectedText} ` : "";
  const acknowledgement = `รับทราบค่ะ ${details}เพิ่มข้อมูลในเคส ${caseDetail.caseNumber} ให้แล้วนะคะ`;
  const delivery = await lineClient.replyToToken({ replyToken: input.replyToken, text: acknowledgement });
  await store.createMessage({
    caseId,
    direction: "outbound_customer",
    channel: "line",
    originalText: acknowledgement,
    senderType: "BOT",
    messageType: "CASE_ACKNOWLEDGEMENT",
    isVisibleToCustomer: true,
    deliveryStatus: delivery.delivered ? "delivered" : "pending",
  });
  await store.setPendingCaseSelection(customer.id);
  await store.setConversationState(customer.id, "ACTIVE_CASE_CONVERSATION");
  await store.setActiveCase(customer.id, caseId);

  return { processed: true, duplicate: false, caseDetail: relatedResult.detail };
}

export async function receiveLineTextMessage(input: LineTextMessageInput): Promise<LineTextMessageResult> {
  const existingMessage = await store.getMessageByExternalMessageId(input.messageId);
  const existingWebhook = input.webhookEventId ? await store.getMessageByWebhookEventId(input.webhookEventId) : undefined;
  if (existingMessage || existingWebhook) {
    console.log({
      event: "line_webhook_duplicate_message",
      lineUserId: input.lineUserId,
      lineMessageId: input.messageId,
      webhookEventId: input.webhookEventId,
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

  const normalizedText = input.text.trim().replace(/\s+/g, " ")
    .replace(/แคส/g, "เคส")
    .replace(/เคด/g, "เคส");
  const newCaseCommand = /^(เปิดเคสใหม่|สร้างเคสใหม่|แจ้งเรื่องใหม่|เคสใหม่|เปิดเคส|เปิดใหม่|ใหม่|เอาใหม่|ขอเคส)$/i.test(normalizedText);
  const ambiguousNewCaseCommand = /^(เคสไหม|เปิดเคสไหม|เคสใหม|แคสใหม่)$/i.test(input.text.trim());
  const hasNewCaseIntent = /(เปิดเคสใหม่|สร้างเคสใหม่|แจ้งเรื่องใหม่|เคสใหม่|ปัญหาใหม่|เรื่องใหม่)/i.test(normalizedText);
  let forceNewCaseDetail = false;
  let pendingNewCaseText: string | undefined;
  let intakeMessageId = input.messageId;
  let intakeWebhookEventId = input.webhookEventId;
  let intakeReceivedAt = input.timestamp ? new Date(input.timestamp).toISOString() : input.systemReceivedAt;
  let intakeNormalizedText = normalizedText;

  const pendingHistoryMatch = customer.pendingCaseSelection?.mode === "case_history_match"
    ? customer.pendingCaseSelection
    : undefined;
  if (pendingHistoryMatch) {
    const isExpired = !pendingHistoryMatch.expiresAt || new Date(pendingHistoryMatch.expiresAt).getTime() <= Date.now();
    const matchedCaseId = pendingHistoryMatch.matchedCaseId ?? pendingHistoryMatch.selectedCaseId;

    if (isExpired) {
      await caseService.resolvePendingCaseHistoryMatch({
        customerId: customer.id,
        selection: pendingHistoryMatch,
        decision: "expired",
      });
      const refreshedMatch = await caseService.matchLineMessageAgainstHistory({
        customerId: customer.id,
        text: pendingHistoryMatch.pendingText ?? input.text,
        externalMessageId: pendingHistoryMatch.externalMessageId,
        webhookEventId: pendingHistoryMatch.webhookEventId,
        receivedAt: pendingHistoryMatch.receivedAt,
      });
      if (refreshedMatch.action === "ask_customer") {
        await lineClient.replyToToken({
          replyToken: input.replyToken,
          text: refreshedMatch.prompt!,
          quickReplies: [
            { label: "คุยต่อเคสเดิม", text: "เคสเดิม" },
            { label: "เปิดเคสใหม่", text: "เคสใหม่" },
          ],
        });
        return { processed: true, duplicate: false, caseDetail: undefined };
      }
      forceNewCaseDetail = true;
      pendingNewCaseText = pendingHistoryMatch.pendingText ?? input.text;
      intakeMessageId = pendingHistoryMatch.externalMessageId ?? input.messageId;
      intakeWebhookEventId = pendingHistoryMatch.webhookEventId ?? input.webhookEventId;
      intakeReceivedAt = pendingHistoryMatch.receivedAt ?? intakeReceivedAt;
      intakeNormalizedText = pendingNewCaseText.trim().replace(/\s+/g, " ");
    } else {
      const choosesNewCase = newCaseCommand || /^(เปิดเป็นเคสใหม่|สร้างเรื่องใหม่)$/i.test(input.text.trim());
      const choosesExistingCase = /(เคสเดิม|เรื่องเดิม|คุยต่อ|เพิ่มข้อมูล|ต่อเรื่องเดิม|continue_existing_case)/i.test(input.text);

      if (choosesNewCase && pendingHistoryMatch.pendingText) {
        await caseService.resolvePendingCaseHistoryMatch({
          customerId: customer.id,
          selection: pendingHistoryMatch,
          decision: "create_new_case",
        });
        forceNewCaseDetail = true;
        pendingNewCaseText = pendingHistoryMatch.pendingText;
        intakeMessageId = pendingHistoryMatch.externalMessageId ?? input.messageId;
        intakeWebhookEventId = pendingHistoryMatch.webhookEventId ?? input.webhookEventId;
        intakeReceivedAt = pendingHistoryMatch.receivedAt ?? intakeReceivedAt;
        intakeNormalizedText = pendingNewCaseText.trim().replace(/\s+/g, " ");
      } else if (choosesExistingCase && matchedCaseId && pendingHistoryMatch.pendingText) {
        const matchedCase = await caseService.getCase(matchedCaseId);
        if (!matchedCase || matchedCase.customerId !== customer.id) {
          await caseService.resolvePendingCaseHistoryMatch({
            customerId: customer.id,
            selection: pendingHistoryMatch,
            decision: "expired",
          });
          await lineClient.replyToToken({ replyToken: input.replyToken, text: "ไม่พบเคสที่เลือกแล้วค่ะ กรุณาส่งรายละเอียดปัญหาอีกครั้งนะคะ" });
          return { processed: true, duplicate: false, caseDetail: undefined };
        }

        await caseService.resolvePendingCaseHistoryMatch({
          customerId: customer.id,
          selection: pendingHistoryMatch,
          decision: "continue_existing_case",
        });
        if (["closed", "resolved", "sent_to_customer"].includes(matchedCase.status)) {
          await store.updateCase(matchedCase.id, { status: "reopened" });
        }
        await store.setActiveCase(customer.id, matchedCase.id);
        const relatedResult = await caseService.appendLineMessageToCase({
          caseId: matchedCase.id,
          text: pendingHistoryMatch.pendingText,
          externalMessageId: pendingHistoryMatch.externalMessageId,
          webhookEventId: pendingHistoryMatch.webhookEventId,
          receivedAt: pendingHistoryMatch.receivedAt,
        });
        const reply = `ได้เลยค่ะ จะคุยต่อในเคส ${matchedCase.caseNumber} นะคะ ทีมงานได้รับข้อมูลเพิ่มเติมแล้วค่ะ`;
        await lineClient.replyToToken({ replyToken: input.replyToken, text: reply });
        await store.createMessage({
          caseId: matchedCase.id,
          direction: "outbound_customer",
          channel: "line",
          originalText: reply,
          senderType: "BOT",
          messageType: "CASE_ACKNOWLEDGEMENT",
          deliveryStatus: "sent",
        });
        return { processed: true, duplicate: false, caseDetail: relatedResult.detail };
      } else {
        const matchedCase = matchedCaseId ? await caseService.getCase(matchedCaseId) : undefined;
        const caseLabel = matchedCase ? `\nหมายเลขเคส: ${matchedCase.caseNumber}\nเรื่อง: ${caseService.formatCaseTitle(matchedCase)}\n` : "";
        await lineClient.replyToToken({
          replyToken: input.replyToken,
          text: `ต้องการคุยต่อในเคสเดิม หรือเปิดเป็นเคสใหม่คะ?${caseLabel}\nตอบ “เคสเดิม” หรือ “เคสใหม่” ได้เลยค่ะ`,
          quickReplies: [
            { label: "คุยต่อเคสเดิม", text: "เคสเดิม" },
            { label: "เปิดเคสใหม่", text: "เคสใหม่" },
          ],
        });
        return { processed: true, duplicate: false, caseDetail: undefined };
      }
    }
  }

  const pendingInformation = customer.pendingCaseSelection?.mode === "request_more_info"
    && customer.pendingCaseSelection.pendingAction === "REQUEST_MORE_INFO"
    ? customer.pendingCaseSelection
    : undefined;
  if (pendingInformation) {
    const pendingResult = await handlePendingInformationResponse(input, customer, pendingInformation);
    if (pendingResult) return pendingResult;
  }

  const pendingSplit = customer.pendingCaseSelection?.mode === "case_split_confirmation"
    ? customer.pendingCaseSelection
    : undefined;
  if (
    (pendingSplit?.externalMessageId && pendingSplit.externalMessageId === input.messageId)
    || (pendingSplit?.webhookEventId && input.webhookEventId && pendingSplit.webhookEventId === input.webhookEventId)
  ) {
    return { processed: false, duplicate: true };
  }

  if (pendingSplit) {
    const confirmsNewCaseSplit = newCaseCommand || /^(ใช่|ใช่ค่ะ|ตกลง|ยืนยัน)$/i.test(input.text.trim());
    const confirmsExistingCaseSplit = /(เคสเดิม|เรื่องเดิม|เพิ่มข้อมูล|ต่อเรื่องเดิม|same case|same issue)/i.test(input.text);
    const sourceCaseId = pendingSplit.selectedCaseId ?? pendingSplit.candidateCaseIds[0];

    if (confirmsNewCaseSplit && sourceCaseId && pendingSplit.pendingText) {
      forceNewCaseDetail = true;
      pendingNewCaseText = pendingSplit.pendingText;
      intakeMessageId = pendingSplit.externalMessageId ?? input.messageId;
      intakeWebhookEventId = pendingSplit.webhookEventId ?? input.webhookEventId;
      intakeReceivedAt = pendingSplit.receivedAt ?? intakeReceivedAt;
      intakeNormalizedText = pendingSplit.pendingText.trim().replace(/\s+/g, " ");
      await store.setPendingCaseSelection(customer.id);
      await store.setConversationState(customer.id, "IDLE");
      await store.updateCase(sourceCaseId, { status: pendingSplit.previousCaseStatus ?? "awaiting_tech" });
    } else if (confirmsExistingCaseSplit && sourceCaseId && pendingSplit.pendingText) {
      await store.setPendingCaseSelection(customer.id);
      await store.setConversationState(customer.id, "ACTIVE_CASE_CONVERSATION");
      await store.updateCase(sourceCaseId, { status: pendingSplit.previousCaseStatus ?? "awaiting_tech" });
      await store.setActiveCase(customer.id, sourceCaseId);
      const relatedResult = await caseService.appendLineMessageToCase({
        caseId: sourceCaseId,
        text: pendingSplit.pendingText,
        externalMessageId: pendingSplit.externalMessageId,
        webhookEventId: pendingSplit.webhookEventId,
        receivedAt: pendingSplit.receivedAt,
      });
      await lineClient.replyToToken({ replyToken: input.replyToken, text: relatedResult.continuationReply });
      await store.createMessage({
        caseId: sourceCaseId,
        direction: "outbound_customer",
        channel: "line",
        originalText: relatedResult.continuationReply,
        senderType: "BOT",
        messageType: "CASE_ACKNOWLEDGEMENT",
        deliveryStatus: "sent",
      });
      return { processed: true, duplicate: false, caseDetail: relatedResult.detail };
    } else if (!confirmsNewCaseSplit) {
      await lineClient.replyToToken({
        replyToken: input.replyToken,
        text: "ข้อความก่อนหน้านี้ต้องการเปิดเคสใหม่หรือเพิ่มข้อมูลในเคสเดิมคะ? ตอบ “เคสใหม่” หรือ “เคสเดิม” ได้เลยค่ะ",
      });
      return { processed: true, duplicate: false, caseDetail: undefined };
    }
  }

  if (!forceNewCaseDetail && customer.conversationState === "WAITING_NEW_CASE_CONFIRMATION") {
    if (/^(ใช่|ใช่ค่ะ|ตกลง|ยืนยัน)$/i.test(input.text.trim())) {
      await store.setConversationState(customer.id, "WAITING_NEW_CASE_DETAIL");
      await lineClient.replyToToken({ replyToken: input.replyToken, text: "ได้ค่ะ รบกวนบอกอาการหรือปัญหาที่พบได้เลยนะคะ" });
      return { processed: true, duplicate: false, caseDetail: undefined };
    }
    if (/^(ไม่ใช่|ไม่ใช่ค่ะ|ยกเลิก)$/i.test(input.text.trim())) {
      await store.setConversationState(customer.id, "IDLE");
      await lineClient.replyToToken({ replyToken: input.replyToken, text: "ได้ค่ะ สามารถพิมพ์หมายเลขเคสหรือหัวข้อที่ต้องการสอบถามได้เลยนะคะ" });
      return { processed: true, duplicate: false, caseDetail: undefined };
    }
    await lineClient.replyToToken({ replyToken: input.replyToken, text: "ต้องการแจ้งปัญหาใหม่ใช่ไหมคะ? ตอบ “ใช่” หรือ “ไม่ใช่” ได้เลยค่ะ" });
    return { processed: true, duplicate: false, caseDetail: undefined };
  }

  if (!forceNewCaseDetail && customer.conversationState === "WAITING_NEW_CASE_DETAIL") {
    if (newCaseCommand || ambiguousNewCaseCommand || normalizedText.length < 8) {
      await lineClient.replyToToken({ replyToken: input.replyToken, text: "ได้ค่ะ รบกวนบอกอาการหรือปัญหาที่พบได้เลยนะคะ" });
      return { processed: true, duplicate: false, caseDetail: undefined };
    }
    forceNewCaseDetail = true;
    await store.setConversationState(customer.id, "IDLE");
  } else if (/ไหม$/i.test(input.text.trim()) && ambiguousNewCaseCommand) {
    await store.setConversationState(customer.id, "WAITING_NEW_CASE_CONFIRMATION");
    await lineClient.replyToToken({ replyToken: input.replyToken, text: "ต้องการแจ้งปัญหาใหม่ หรือสอบถามเรื่องเดิมคะ? ตอบ “ใช่” หากต้องการแจ้งปัญหาใหม่ค่ะ" });
    return { processed: true, duplicate: false, caseDetail: undefined };
  } else if (!forceNewCaseDetail && (ambiguousNewCaseCommand || newCaseCommand || (hasNewCaseIntent && normalizedText.length < 18))) {
    await store.setConversationState(customer.id, "WAITING_NEW_CASE_DETAIL");
    await lineClient.replyToToken({ replyToken: input.replyToken, text: "ได้ค่ะ รบกวนบอกอาการหรือปัญหาที่พบได้เลยนะคะ" });
    return { processed: true, duplicate: false, caseDetail: undefined };
  } else if (hasNewCaseIntent) {
    forceNewCaseDetail = true;
  }

  let isNewCaseRequest = forceNewCaseDetail;
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

  const reopenIntent = !isNewCaseRequest && /(เปิดเคส|เปิดเรื่อง|ปัญหาเดิม|เรื่องที่แจ้ง|ยังไม่หาย|เคสที่\s*\d+)/i.test(input.text);
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
        webhookEventId: input.webhookEventId,
        receivedAt: input.timestamp ? new Date(input.timestamp).toISOString() : input.systemReceivedAt,
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
  if (!isNewCaseRequest) {
    const historyMatch = await caseService.matchLineMessageAgainstHistory({
      customerId: customer.id,
      text: input.text,
      externalMessageId: input.messageId,
      webhookEventId: input.webhookEventId,
      receivedAt: input.timestamp ? new Date(input.timestamp).toISOString() : input.systemReceivedAt,
    });
    if (historyMatch.action === "ask_customer") {
      await lineClient.replyToToken({
        replyToken: input.replyToken,
        text: historyMatch.prompt!,
        quickReplies: [
          { label: "คุยต่อเคสเดิม", text: "เคสเดิม" },
          { label: "เปิดเคสใหม่", text: "เคสใหม่" },
        ],
      });
      return { processed: true, duplicate: false, caseDetail: undefined };
    }
    isNewCaseRequest = true;
  }
  const confirmsNewCase = isNewCaseRequest; /*
    && /(ปัญหาใหม่|เรื่องใหม่|เคสใหม่|เปิดเคสใหม่|แยกเคส|new issue|new case)/i.test(input.text);
  */
  const intakeText = pendingNewCaseText ?? input.text;
  const confirmsExistingCase = activeCase?.status === "awaiting_confirmation"
    && /(เคสเดิม|เรื่องเดิม|ข้อมูลเพิ่มเติม|ต่อเรื่องเดิม|same case|same issue)/i.test(input.text);

  if (confirmsNewCase && activeCase) {
    // The detail message belongs to the new case, not the previous one.
    // Keeping the old case open also preserves its own conversation history.
    await store.setActiveCase(customer.id);
  }

  const relatedCase = confirmsNewCase
    ? undefined
    : confirmsExistingCase
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
      webhookEventId: input.webhookEventId,
      receivedAt: input.timestamp ? new Date(input.timestamp).toISOString() : input.systemReceivedAt,
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
      messageType: "CASE_ACKNOWLEDGEMENT",
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
      webhookEventId: input.webhookEventId,
      receivedAt: input.timestamp ? new Date(input.timestamp).toISOString() : input.systemReceivedAt,
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
    externalMessageId: intakeMessageId,
    senderType: "CUSTOMER",
    messageType: "CUSTOMER_MESSAGE",
    normalizedText: intakeNormalizedText,
    webhookEventId: intakeWebhookEventId,
    receivedAt: intakeReceivedAt,
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
  const targetedInfoQuestion = analysis.missingInformation.length > 0
    ? await aiCenterClient.generateTargetedInfoRequest({
        caseTitle: analysis.caseTitle,
        category: analysis.category,
        originalCustomerText: intakeText,
        recentConversation: [],
        requestedText: analysis.missingInformation.slice(0, 2).join(", "),
      })
    : undefined;

  await store.updateCase(supportCase.id, {
    status: targetedInfoQuestion ? "awaiting_customer_info" : "awaiting_tech",
    title: analysis.caseTitle,
    aiStatus: analysis.status === "AI_FAILED" ? "AI_FAILED" : analysis.status === "AI_LOW_CONFIDENCE" ? "AI_LOW_CONFIDENCE" : "AI_SUCCESS",
    dataStatus: analysis.missingInformation.length > 0 ? "DATA_INCOMPLETE" : "COMPLETE",
    aiAnalyzedAt: new Date().toISOString(),
    customerSentAt: intakeReceivedAt,
    systemReceivedAt: input.systemReceivedAt,
    category: analysis.category,
    priority: analysis.urgency,
    confidenceScore: analysis.confidence,
    initialCustomerMessageId: message.id,
    latestCustomerMessageId: message.id,
    problemSummary: analysis.status === "AI_FAILED" ? undefined : analysis.summary,
    problemSummaryGeneratedAt: analysis.status === "AI_FAILED" ? undefined : new Date().toISOString(),
    problemSummarySourceMessageId: analysis.status === "AI_FAILED" ? undefined : message.id,
    problemSummaryVersion: 1,
    problemSummaryStatus: analysis.status === "AI_FAILED" ? "FAILED" : "SUCCESS",
  });
  await store.setActiveCase(customer.id, supportCase.id);
  if (targetedInfoQuestion) {
    await caseService.setPendingInformationRequest({
      customerId: customer.id,
      caseId: supportCase.id,
      questionType: "AI_MISSING_INFORMATION",
      requestedFields: analysis.missingInformation,
    });
  }

  if (pendingNewCaseText) {
    await store.createMessage({
      caseId: supportCase.id,
      direction: "INTERNAL",
      channel: "system",
      originalText: `ลูกค้ายืนยันเปิดเคสใหม่จากข้อความก่อนหน้า: ${input.text}`,
      externalMessageId: input.messageId,
      webhookEventId: input.webhookEventId,
      senderType: "SYSTEM",
      messageType: "SYSTEM_EVENT",
      deliveryStatus: "PROCESSED",
    });
  }

  console.log({
    event: "line_webhook_case_created",
    lineUserId: input.lineUserId,
    lineMessageId: input.messageId,
    caseId: supportCase.id,
    timestamp: input.timestamp,
  });

  const acknowledgement = targetedInfoQuestion
    ? `รับเรื่องเรียบร้อยแล้วค่ะ\n\nหมายเลขเคส: ${supportCase.caseNumber}\nเรื่อง: ${analysis.caseTitle}\n\n${targetedInfoQuestion}`
    : `รับเรื่องเรียบร้อยแล้วค่ะ\n\nหมายเลขเคส: ${supportCase.caseNumber}\nเรื่อง: ${analysis.caseTitle}\n\nทีมงานกำลังตรวจสอบให้นะคะ`;
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
    messageType: targetedInfoQuestion ? "REQUEST_MORE_INFO" : "CASE_ACKNOWLEDGEMENT",
    deliveryStatus: acknowledgementDelivery.delivered ? "delivered" : "pending",
  });
  await store.updateCase(supportCase.id, {
    lineSentAt: new Date().toISOString(),
    lineDeliveredAt: acknowledgementDelivery.delivered ? new Date().toISOString() : undefined,
  });

  const caseDetail = await store.getCaseDetail(supportCase.id);
  if (caseDetail) {
    try {
      await teamsClient.notifyCase(caseDetail);
      await store.createMessage({
        caseId: supportCase.id,
        direction: "outbound_tech",
        channel: "ms_teams",
        originalText: `ส่งรายละเอียดเคส ${supportCase.caseNumber} ให้ทีม Tech Support ผ่าน Microsoft Teams แล้ว`,
        senderType: "SYSTEM",
        messageType: "CASE_FORWARDED",
        deliveryStatus: "sent",
      });
      await store.updateCase(supportCase.id, {
        teamsDeliveryStatus: "accepted",
        teamsDeliveryAt: new Date().toISOString(),
        teamsSentAt: new Date().toISOString(),
        teamsDeliveryError: undefined,
      });
    } catch (error) {
      await store.updateCase(supportCase.id, {
        teamsDeliveryStatus: "failed",
        teamsDeliveryAt: new Date().toISOString(),
        teamsDeliveryError: error instanceof Error ? error.message : String(error),
        dataStatus: error instanceof Error && error.message.startsWith("DATA_INCOMPLETE") ? "DATA_INCOMPLETE" : undefined,
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
