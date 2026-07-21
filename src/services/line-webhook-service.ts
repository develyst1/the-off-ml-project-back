import type { CaseDetail, Customer, PendingCaseSelection } from "../domain/types";
import { env } from "../config/env";
import {
  PENDING_INFORMATION_FIELDS,
  buildMissingInformationQuestion,
  extractPendingInformationFallback,
  formatPendingInformation,
  getPendingInformationLabel,
  getMissingPendingInformationFields,
  type PendingInformationField,
  type PendingInformationValues,
} from "../lib/pending-information";
import { store } from "../repositories/store";
import { aiCenterClient, type LineMessageIntentClassification, type LineMessageIntentName } from "./ai-center-client";
import { caseService } from "./case-service";
import { lineClient } from "./line-client";
import { teamsClient } from "./teams-client";
import { isAutoAnswerAllowedForSolution } from "./automation-settings";

export const LINE_ACKNOWLEDGEMENT_TEXT =
  "รับเรื่องเรียบร้อยแล้วค่ะ ทีมงานกำลังตรวจสอบปัญหาให้คุณ";

export const LINE_CONTINUATION_ACKNOWLEDGEMENT_TEXT = "ได้รับข้อมูลเพิ่มเติมแล้วค่ะ ทีมงานจะนำข้อมูลนี้ไปตรวจสอบต่อในเคสเดิม";
export const LINE_CASE_CONFIRMATION_TEXT = "ข้อความนี้ดูเหมือนเป็นปัญหาใหม่ ต้องการเปิดเคสใหม่ หรือเพิ่มข้อมูลในเคสเดิมคะ?";
export const LINE_FIRST_CASE_ACKNOWLEDGEMENT_TEXT = "รับเรื่องเรียบร้อยแล้วค่ะ";

export type BuildInitialCaseAcknowledgementInput = {
  caseNumber: string;
  caseTitle: string;
};

export function buildInitialCaseAcknowledgement({
  caseNumber,
  caseTitle,
}: BuildInitialCaseAcknowledgementInput): string {
  return [
    "รับเรื่องเรียบร้อยแล้วค่ะ",
    "",
    `หมายเลขเคส: ${caseNumber}`,
    `ปัญหา: ${caseTitle}`,
    "",
    "ทีม Tech จะตรวจสอบและติดต่อกลับหากต้องการข้อมูลเพิ่มเติมนะคะ",
  ].join("\n");
}

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

const NON_CASE_CREATING_INTENTS = new Set<LineMessageIntentName>([
  "CASE_COUNT_QUERY",
  "CASE_HISTORY_QUERY",
  "CASE_STATUS_QUERY",
  "CASE_DETAIL_QUERY",
  "CLOSE_CASE_REQUEST",
  "REOPEN_CASE_REQUEST",
  "TECH_GENERAL_QUESTION",
  "OUT_OF_SCOPE",
  "SMALL_TALK",
  "GREETING",
  "THANK_YOU",
  "UNKNOWN",
]);

const ACTIVE_CASE_STATUSES = new Set(["analyzing", "awaiting_tech", "assigned", "tech_replied", "analyzing_solution", "awaiting_customer_info", "awaiting_confirmation", "reopened", "in_progress"]);
const CLOSED_CASE_STATUSES = new Set(["closed", "resolved", "sent_to_customer"]);

const INTENT_CONFIDENCE_THRESHOLD = 0.7;
async function hasAutoAnswerReadySolution(caseDetail: CaseDetail) {
  const readiness = await Promise.all(
    caseDetail.solutions.map((solution) => isAutoAnswerAllowedForSolution(caseDetail.confidenceScore, solution)),
  );
  return readiness.some(Boolean);
}

function getIntentGroup(intent: LineMessageIntentName) {
  if (intent === "NEW_SUPPORT_ISSUE" || intent === "TECH_GENERAL_QUESTION") return "SUPPORT";
  if (intent === "FOLLOW_UP_EXISTING_CASE" || intent.startsWith("CASE_") || intent === "CLOSE_CASE_REQUEST" || intent === "REOPEN_CASE_REQUEST") {
    return "CASE_MANAGEMENT";
  }
  return "OUT_OF_SCOPE";
}

function detectCaseQueryIntent(text: string): LineMessageIntentName | undefined {
  const normalized = text.trim();
  if (/เปิดไปกี่เคส|มีทั้งหมดกี่เคส|ตอนนี้มีกี่เคส|เปิดอยู่กี่เคส|กำลังดำเนินการอยู่กี่เคส|เคสไหนยังไม่ปิด/iu.test(normalized)) return "CASE_COUNT_QUERY";
  if (/มีเคสอะไรบ้าง|เคสที่เคยแจ้ง|ประวัติเคส|ดูเคสของฉัน|เคสล่าสุด|รายการเคส/iu.test(normalized)) return "CASE_HISTORY_QUERY";
  if (/สถานะเคส|สถานะ.*เคส|เคส.*สถานะ|ตอนนี้.*อยู่ขั้นตอนไหน|ความคืบหน้า.*เคส/iu.test(normalized)) return "CASE_STATUS_QUERY";
  if (/รายละเอียดเคส|ข้อมูลของเคส|ดูรายละเอียด.*เคส/iu.test(normalized)) return "CASE_DETAIL_QUERY";
  if (/ขอปิดเคส|ปิดเคสให้หน่อย|ปิดเรื่องนี้/iu.test(normalized)) return "CLOSE_CASE_REQUEST";
  if (/เปิดเคสเดิม|เปิดเรื่องเดิม|ขอเปิดเคส|เคสที่\s*\d+|เรื่องที่แจ้ง|ยังไม่หาย/iu.test(normalized)) return "REOPEN_CASE_REQUEST";
  if (/^(สวัสดี|หวัดดี|ดีค่ะ|ดีครับ|hello|hi)\b/iu.test(normalized)) return "GREETING";
  if (/^(ขอบคุณ|ขอบคุณค่ะ|ขอบคุณครับ|แต๊งกิ้ว)/iu.test(normalized)) return "THANK_YOU";
  return undefined;
}

function hasActualProblemDescription(text: string) {
  const normalized = text.trim();
  if (normalized.length < 8) return false;
  if (/^(เปิดเคสใหม่|สร้างเคสใหม่|แจ้งเรื่องใหม่|เคสใหม่|เปิดเคส)$/iu.test(normalized)) return false;
  if (/^(โอเค|โอเคค่ะ|ครับ|ค่ะ|ขอบคุณ|ขอบคุณครับ|ขอบคุณค่ะ|ยังไม่ได้|วันนี้อินเทอร์เน็ตเร็วไหม)$/iu.test(normalized)) return false;
  return !detectCaseQueryIntent(normalized);
}

const SHORT_FOLLOW_UP_PATTERNS = [
  /^ช้า$/iu,
  /^ค้าง$/iu,
  /^หลุด$/iu,
  /^ยังไม่ได้$/iu,
  /^ยังเป็นอยู่$/iu,
  /^เปิดไม่ขึ้น$/iu,
  /^เข้าไม่ได้$/iu,
  /^ไฟยังติด(?:ครับ|ค่ะ)?$/iu,
  /^ไฟไม่ติด(?:ครับ|ค่ะ)?$/iu,
  /^ยังช้าอยู่$/iu,
  /^ยังค้างอยู่$/iu,
  /^ยังหลุดอยู่$/iu,
];

function isShortFollowUp(message: string) {
  const normalized = message.trim().replace(/\s+/g, " ");
  return normalized.length <= 20 && SHORT_FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(normalized));
}

function extractLastKnownTopic(text: string | undefined) {
  if (!text) return undefined;
  const normalized = text.trim().replace(/[!?。、]+$/gu, "");
  const match = normalized.match(/(?:สอบถามเกี่ยวกับ|เกี่ยวกับ|เรื่อง|ปัญหา(?:เรื่อง)?|อาการ(?:คือ)?)\s*(.+)$/iu);
  const topic = (match?.[1] ?? (/^(?:เครื่อง|ระบบ|เซิร์ฟเวอร์|อินเทอร์เน็ต|แอป|โน้ตบุ๊ก|คอมพิวเตอร์)/iu.test(normalized) ? normalized : "")).trim();
  if (!topic || /^(?:อะไร|อย่างไร|ยังไง|ทั่วไป)$/iu.test(topic)) return undefined;
  return topic;
}

function resolveShortFollowUp(message: string, lastKnownTopic?: string) {
  if (!lastKnownTopic || !isShortFollowUp(message)) return undefined;
  const normalized = message.trim().replace(/\s+/g, " ");
  if (/^ช้า$|^ยังช้าอยู่$/iu.test(normalized)) return `${lastKnownTopic}ช้า`;
  if (/^ค้าง$|^ยังค้างอยู่$/iu.test(normalized)) return `${lastKnownTopic}ค้าง`;
  if (/^หลุด$|^ยังหลุดอยู่$/iu.test(normalized)) return `${lastKnownTopic}หลุด`;
  if (/^ยังไม่ได้$/iu.test(normalized)) return `${lastKnownTopic}ยังใช้งานไม่ได้`;
  if (/^ยังเป็นอยู่$/iu.test(normalized)) return `${lastKnownTopic}ยังมีอาการเดิมอยู่`;
  if (/^เปิดไม่ขึ้น$/iu.test(normalized)) return `${lastKnownTopic}เปิดไม่ขึ้น`;
  if (/^เข้าไม่ได้$/iu.test(normalized)) return `${lastKnownTopic}เข้าใช้งานไม่ได้`;
  if (/^ไฟยังติด/iu.test(normalized)) return `${lastKnownTopic} และไฟแสดงสถานะยังติด`;
  if (/^ไฟไม่ติด/iu.test(normalized)) return `${lastKnownTopic} และไฟแสดงสถานะไม่ติด`;
  return undefined;
}

function getStoredContext(customer: Customer) {
  return customer.pendingCaseSelection?.mode === "context_only" ? customer.pendingCaseSelection : undefined;
}

async function rememberPreCaseContext(customer: Customer, customerText: string, botText: string) {
  const previous = getStoredContext(customer);
  const topic = extractLastKnownTopic(customerText) ?? previous?.contextTopic;
  if (!topic) return;
  const contextMessages = [
    ...(previous?.contextMessages ?? []),
    { sender: "CUSTOMER", message: customerText, createdAt: new Date().toISOString() },
    { sender: "LINE_BOT", message: botText, createdAt: new Date().toISOString() },
  ].slice(-6);
  await store.setPendingCaseSelection(customer.id, {
    mode: "context_only",
    candidateCaseIds: [],
    contextTopic: topic,
    contextMessages,
    createdAt: previous?.createdAt ?? new Date().toISOString(),
  });
}

async function clearPreCaseContext(customer: Customer) {
  if (getStoredContext(customer)) await store.setPendingCaseSelection(customer.id);
}

function formatCustomerCaseDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "ไม่ทราบวันที่";
  return new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(date);
}

function getCustomerCaseStatusLabel(status: string) {
  const labels: Record<string, string> = {
    new: "รอเริ่มดำเนินการ",
    analyzing: "กำลังวิเคราะห์",
    awaiting_tech: "รอทีม Tech ตอบ",
    assigned: "ทีม Tech รับเคสแล้ว",
    tech_replied: "กำลังตรวจสอบ",
    analyzing_solution: "กำลังวิเคราะห์วิธีแก้ไข",
    awaiting_customer_info: "รอลูกค้าให้ข้อมูล",
    awaiting_confirmation: "รอยืนยันจากลูกค้า",
    reopened: "เปิดเคสอีกครั้งแล้ว",
    in_progress: "กำลังดำเนินการ",
    resolved: "แก้ไขแล้ว",
    sent_to_customer: "ส่งคำตอบให้ลูกค้าแล้ว",
    closed: "ปิดเคสแล้ว",
  };
  return labels[status] ?? "กำลังดำเนินการ";
}

async function handleNonCaseIntent(input: {
  customer: Customer;
  intent: LineMessageIntentClassification;
  text: string;
  replyToken?: string;
}): Promise<boolean> {
  const cases = await caseService.getCustomerCases(input.customer.id);
  const activeCases = cases.filter((item) => ACTIVE_CASE_STATUSES.has(item.status));
  const recentCases = cases.slice(0, 5);
  const caseNumberMatch = input.text.match(/\bOFF-\d{4}-\d+\b/i)?.[0];
  const requestedOpenOnly = /เปิดอยู่|กำลังดำเนินการ|ยังไม่ปิด/iu.test(input.text);

  if (input.intent.intent === "CASE_COUNT_QUERY") {
    const count = requestedOpenOnly ? activeCases.length : cases.length;
    if (count === 0) {
      const reply = requestedOpenOnly
        ? "ตอนนี้ไม่มีเคสที่กำลังดำเนินการอยู่ค่ะ\n\nเคสก่อนหน้าของคุณปิดเรียบร้อยแล้วทั้งหมดนะคะ"
        : "ตอนนี้ยังไม่มีเคสในประวัติของคุณค่ะ หากพบปัญหา สามารถแจ้งรายละเอียดเข้ามาได้เลยนะคะ";
      await lineClient.replyToToken({ replyToken: input.replyToken, text: reply });
      return true;
    }
    const shown = (requestedOpenOnly ? activeCases : cases).slice(0, 5);
    const remaining = count - shown.length;
    const rows = shown.map((item) => `• ${item.caseNumber} — ${caseService.formatCaseTitle(item)} — ${getCustomerCaseStatusLabel(item.status)}`);
    const reply = requestedOpenOnly
      ? `ตอนนี้คุณมีเคสที่กำลังดำเนินการอยู่ ${count} เคสค่ะ\n\n${rows.join("\n")}\n${remaining > 0 ? `\nยังมีอีก ${remaining} เคสค่ะ\n` : "\n"}ต้องการดูรายละเอียดของเคสไหน แจ้งเลขเคสได้เลยค่ะ`
      : `คุณเคยเปิดเคสทั้งหมด ${count} เคสค่ะ\n\n• กำลังดำเนินการ ${activeCases.length} เคส\n• ปิดแล้ว ${cases.filter((item) => CLOSED_CASE_STATUSES.has(item.status)).length} เคส\n\n${remaining > 0 ? `แสดงรายการล่าสุด 5 เคส และยังมีอีก ${remaining} เคสค่ะ\n\n` : ""}ต้องการดูรายละเอียดของเคสไหน แจ้งเลขเคสได้เลยค่ะ`;
    await lineClient.replyToToken({ replyToken: input.replyToken, text: reply });
    return true;
  }

  if (input.intent.intent === "CASE_HISTORY_QUERY") {
    const rows = recentCases.map((item) => `• ${item.caseNumber} — ${caseService.formatCaseTitle(item)} — ${getCustomerCaseStatusLabel(item.status)}`);
    const reply = rows.length > 0
      ? `เคสล่าสุดของคุณมีดังนี้ค่ะ\n\n${rows.join("\n")}\n\nต้องการดูรายละเอียดของเคสไหน แจ้งเลขเคสได้เลยค่ะ`
      : "ยังไม่พบประวัติเคสของคุณค่ะ หากพบปัญหาใหม่สามารถแจ้งรายละเอียดเข้ามาได้เลยนะคะ";
    await lineClient.replyToToken({ replyToken: input.replyToken, text: reply });
    return true;
  }

  if (input.intent.intent === "CASE_STATUS_QUERY" || input.intent.intent === "CASE_DETAIL_QUERY") {
    let targetCase = caseNumberMatch ? cases.find((item) => item.caseNumber.toLowerCase() === caseNumberMatch.toLowerCase()) : undefined;
    if (caseNumberMatch && !targetCase) {
      await lineClient.replyToToken({ replyToken: input.replyToken, text: "ไม่พบเคสหมายเลขนี้ในประวัติของคุณค่ะ กรุณาตรวจสอบหมายเลขเคสอีกครั้งนะคะ" });
      return true;
    }
    if (!targetCase && activeCases.length === 1) targetCase = activeCases[0];
    if (!targetCase && activeCases.length > 1) {
      const rows = activeCases.slice(0, 5).map((item) => `• ${item.caseNumber} — ${caseService.formatCaseTitle(item)}`);
      await lineClient.replyToToken({ replyToken: input.replyToken, text: `ตอนนี้มีหลายเคสที่กำลังดำเนินการอยู่ค่ะ\n\n${rows.join("\n")}\n\nรบกวนแจ้งเลขเคสที่ต้องการดูสถานะนะคะ` });
      return true;
    }
    if (!targetCase) {
      await lineClient.replyToToken({ replyToken: input.replyToken, text: "ยังไม่พบเคสที่กำลังดำเนินการอยู่ค่ะ หากต้องการดูเคสที่ปิดแล้ว แจ้งหมายเลขเคสได้เลยนะคะ" });
      return true;
    }
    const reply = `เคส ${targetCase.caseNumber} ตอนนี้อยู่ในสถานะ “${getCustomerCaseStatusLabel(targetCase.status)}” ค่ะ\n\nอัปเดตล่าสุดเมื่อ ${formatCustomerCaseDate(targetCase.updatedAt)}${input.intent.intent === "CASE_DETAIL_QUERY" ? `\nเรื่อง: ${caseService.formatCaseTitle(targetCase)}` : ""}`;
    await lineClient.replyToToken({ replyToken: input.replyToken, text: reply });
    return true;
  }

  if (input.intent.intent === "OUT_OF_SCOPE") {
    const reply = await aiCenterClient.generateLineContinuationReply({
      replyType: "OUT_OF_SCOPE_REPLY",
      originalCustomerText: input.text,
      latestCustomerMessage: input.text,
      recentConversation: [],
      newCustomerText: input.text,
      currentCaseStatus: "IDLE",
    });
    await lineClient.replyToToken({ replyToken: input.replyToken, text: reply });
    if (env.FORWARD_OUT_OF_SCOPE_TO_TEAMS) {
      try {
        await teamsClient.notifyOutOfScope({
          customerName: input.customer.displayName ?? input.customer.lineUserId,
          lineUserId: input.customer.lineUserId,
          text: input.text,
          reason: input.intent.reason,
          eventType: input.intent.teamsEventType ?? "OUT_OF_SCOPE_MESSAGE",
        });
      } catch (error) {
        console.error({ event: "line_out_of_scope_teams_forward_failed", error: String(error) });
      }
    }
    await clearPreCaseContext(input.customer);
    return true;
  }

  if (input.intent.intent === "GREETING" || input.intent.intent === "THANK_YOU" || input.intent.intent === "TECH_GENERAL_QUESTION" || input.intent.intent === "SMALL_TALK" || input.intent.intent === "UNKNOWN") {
    const reply = input.intent.intent === "GREETING"
      ? "สวัสดีค่ะ มีปัญหาด้านระบบ อุปกรณ์ หรือการใช้งานไอทีส่วนไหนให้ช่วยตรวจสอบคะ"
      : input.intent.intent === "THANK_YOU"
      ? "ยินดีค่ะ หากพบปัญหาการใช้งานเพิ่มเติม แจ้งมาได้เลยนะคะ"
      : input.intent.intent === "TECH_GENERAL_QUESTION"
      ? "ตอบเรื่องความรู้ด้านเทคนิคทั่วไปได้ค่ะ หากตอนนี้พบอาการใช้งานผิดปกติ เช่น ช้า หลุด หรือเข้าใช้งานไม่ได้ แจ้งรายละเอียดมาได้เลยนะคะ"
      : input.intent.intent === "SMALL_TALK"
      ? "ฉันดูแลเรื่องปัญหาการใช้งานระบบ อุปกรณ์ และบริการไอทีเป็นหลักค่ะ หากพบปัญหา แจ้งอาการมาได้เลยนะคะ"
      : "ขอสอบถามเพิ่มเติมค่ะ ตอนนี้ต้องการแจ้งปัญหาใหม่ หรือต้องการติดตามเคสเดิมคะ";
    await lineClient.replyToToken({ replyToken: input.replyToken, text: reply });
    if (input.intent.intent === "TECH_GENERAL_QUESTION") {
      await rememberPreCaseContext(input.customer, input.text, reply);
    } else if (input.intent.intent === "SMALL_TALK" || input.intent.intent === "GREETING" || input.intent.intent === "THANK_YOU") {
      await clearPreCaseContext(input.customer);
    }
    return true;
  }

  if (input.intent.intent === "CLOSE_CASE_REQUEST") {
    await lineClient.replyToToken({ replyToken: input.replyToken, text: "รับทราบค่ะ เดี๋ยวทีมงานตรวจสอบสถานะเคสให้ก่อนนะคะ หากต้องการปิดเคส รบกวนแจ้งหมายเลขเคสด้วยค่ะ" });
    return true;
  }

  return false;
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
  const updatedPendingDetail = relatedResult.detail ?? await caseService.getCase(caseId);
  const pendingConversation = updatedPendingDetail?.messages ?? caseDetail.messages;
  const lastBotQuestion = [...pendingConversation]
    .reverse()
    .find((message) => message.senderType === "BOT" && message.messageType === "REQUEST_MORE_INFO")?.originalText;

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

  if (missingFields.length > 0 && await hasAutoAnswerReadySolution(caseDetail)) {
    const question = buildMissingInformationQuestion(missingFields);
    const reply = await aiCenterClient.generateLineContinuationReply({
      replyType: "FOLLOW_UP_QUESTION",
      caseNumber: caseDetail.caseNumber,
      caseTitle: caseService.formatCaseTitle(caseDetail),
      originalCustomerText: caseDetail.messages.find((message) => message.senderType === "CUSTOMER")?.originalText ?? input.text,
      latestCustomerMessage: input.text,
      recentConversation: pendingConversation.slice(-10).map((message) => `${message.direction}: ${message.originalText}`),
      newCustomerText: input.text,
      lastBotQuestion,
      currentSummary: caseDetail.problemSummary ?? caseDetail.title ?? "",
      knownFacts: collectedText ? [collectedText] : [],
      missingFacts: missingFields.map(getPendingInformationLabel),
      currentCaseStatus: caseDetail.status,
      requestedNextQuestion: question,
    });
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

  const acknowledgement = await aiCenterClient.generateLineContinuationReply({
    replyType: "FOLLOW_UP_ACK",
    caseNumber: caseDetail.caseNumber,
    caseTitle: caseService.formatCaseTitle(caseDetail),
    originalCustomerText: caseDetail.messages.find((message) => message.senderType === "CUSTOMER")?.originalText ?? input.text,
    latestCustomerMessage: input.text,
    recentConversation: pendingConversation.slice(-10).map((message) => `${message.direction}: ${message.originalText}`),
    newCustomerText: input.text,
    lastBotQuestion,
    currentSummary: caseDetail.problemSummary ?? caseDetail.title ?? "",
    knownFacts: collectedText ? [collectedText] : [],
    missingFacts: [],
    currentCaseStatus: caseDetail.status,
  });
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
  const activeCase = await caseService.getActiveLineCase(customer);
  if (activeCase && customer.activeCaseId !== activeCase.id) {
    await store.setActiveCase(customer.id, activeCase.id);
  }
  const customerCases = await caseService.getCustomerCases(customer.id);
  const storedContext = getStoredContext(customer);
  const activeCaseTopic = activeCase
    ? extractLastKnownTopic(activeCase.problemSummary ?? activeCase.title ?? activeCase.messages.find((message) => message.senderType === "CUSTOMER")?.originalText)
    : undefined;
  const lastKnownTopic = activeCaseTopic ?? storedContext?.contextTopic;
  const resolvedMessage = resolveShortFollowUp(input.text, lastKnownTopic);
  const activeCaseSnapshots = customerCases
    .filter((item) => ACTIVE_CASE_STATUSES.has(item.status))
    .slice(0, 10)
    .map((item) => ({
      id: item.id,
      caseNumber: item.caseNumber,
      title: caseService.formatCaseTitle(item),
      summary: item.problemSummary,
      status: item.status,
      updatedAt: item.updatedAt,
    }));
  const recentCaseSnapshots = customerCases.slice(0, 10).map((item) => ({
    id: item.id,
    caseNumber: item.caseNumber,
    title: caseService.formatCaseTitle(item),
    summary: item.problemSummary,
    status: item.status,
    updatedAt: item.updatedAt,
  }));
  const recentConversation = (activeCase?.messages.map((message) => ({
    sender: message.senderType ?? message.direction,
    message: message.originalText,
    createdAt: message.createdAt,
  })) ?? storedContext?.contextMessages ?? []).slice(-20);
  const lastBotMessage = activeCase
    ? [...activeCase.messages].reverse().find((message) => message.senderType === "BOT")?.originalText
    : [...(storedContext?.contextMessages ?? [])].reverse().find((message) => message.sender === "LINE_BOT")?.message;
  const lastBotQuestion = activeCase
    ? [...activeCase.messages]
      .reverse()
      .find((message) => message.senderType === "BOT" && message.messageType === "REQUEST_MORE_INFO")?.originalText
    : [...(storedContext?.contextMessages ?? [])]
      .reverse()
      .find((message) => message.sender === "LINE_BOT" && message.message.includes("ไหม"))?.message;
  const detectedQueryIntent = detectCaseQueryIntent(input.text);
  let aiClassifiedIntent: LineMessageIntentClassification;
  try {
    aiClassifiedIntent = await aiCenterClient.classifyLineMessageIntent({
      latestMessage: input.text,
      lastKnownTopic,
      resolvedMessage,
      recentConversation,
      lastBotMessage,
      lastBotQuestion,
      activeCases: activeCaseSnapshots,
      recentCases: recentCaseSnapshots,
      activeCaseNumber: activeCase?.caseNumber,
      conversationState: customer.conversationState,
    });
  } catch (error) {
    console.error({ event: "line_message_intent_classification_guard_failed", lineUserId: input.lineUserId, error: String(error) });
    aiClassifiedIntent = {
      intent: "UNKNOWN",
      shouldCreateCase: false,
      targetCaseNumber: null,
      matchedActiveCaseId: null,
      confidence: 0,
      reason: "INTENT_CLASSIFIER_ERROR",
    };
  }
  let classifiedIntent: LineMessageIntentClassification = detectedQueryIntent
    ? {
        ...aiClassifiedIntent,
        intent: detectedQueryIntent,
        shouldCreateCase: false,
        targetCaseNumber: input.text.match(/\bOFF-\d{4}-\d+\b/i)?.[0] ?? null,
        matchedActiveCaseId: activeCase?.id ?? null,
        confidence: 1,
        reason: "ข้อความตรงกับ deterministic intent guard หลังผ่าน AI classification",
      }
    : aiClassifiedIntent;

  if (!detectedQueryIntent && resolvedMessage && hasActualProblemDescription(resolvedMessage)) {
    const hasSingleActiveCase = activeCaseSnapshots.length === 1;
    classifiedIntent = {
      ...classifiedIntent,
      intent: hasSingleActiveCase ? "FOLLOW_UP_EXISTING_CASE" : "NEW_SUPPORT_ISSUE",
      shouldCreateCase: !hasSingleActiveCase,
      matchedActiveCaseId: hasSingleActiveCase ? activeCaseSnapshots[0]?.id ?? null : null,
      resolvedMessage,
      confidence: Math.max(classifiedIntent.confidence, 0.85),
      reason: `ข้อความสั้นถูกตีความต่อจากหัวข้อ ${lastKnownTopic}`,
    };
  }

  const intentIsConfident = classifiedIntent.confidence >= INTENT_CONFIDENCE_THRESHOLD;
  console.log({
    event: "line_message_intent_classified",
    lineUserId: input.lineUserId,
    intent: classifiedIntent.intent,
    intentGroup: getIntentGroup(classifiedIntent.intent),
    shouldCreateCase: classifiedIntent.shouldCreateCase,
    confidence: classifiedIntent.confidence,
    matchedCaseId: classifiedIntent.matchedActiveCaseId,
    action: classifiedIntent.intent === "NEW_SUPPORT_ISSUE" ? "EVALUATE_CASE_CREATION" : "ROUTE_EXISTING_HANDLER",
    reason: classifiedIntent.reason,
  });
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
    const classificationText = classifiedIntent.resolvedMessage ?? resolvedMessage ?? input.text;
    if (classifiedIntent.intent !== "NEW_SUPPORT_ISSUE" || !classifiedIntent.shouldCreateCase || !intentIsConfident || !hasActualProblemDescription(classificationText)) {
      await lineClient.replyToToken({ replyToken: input.replyToken, text: "ขอรายละเอียดอาการหรือปัญหาที่ต้องการเปิดเคสอีกนิดนะคะ" });
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
  } else if (hasNewCaseIntent && classifiedIntent.intent === "NEW_SUPPORT_ISSUE" && classifiedIntent.shouldCreateCase && intentIsConfident) {
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

  if (!isNewCaseRequest && NON_CASE_CREATING_INTENTS.has(classifiedIntent.intent)) {
    const handled = await handleNonCaseIntent({ customer, intent: classifiedIntent, text: input.text, replyToken: input.replyToken });
    if (handled) return { processed: true, duplicate: false, caseDetail: undefined };
  }

  if (!isNewCaseRequest && classifiedIntent.intent === "FOLLOW_UP_EXISTING_CASE" && !activeCase) {
    await lineClient.replyToToken({ replyToken: input.replyToken, text: "ยังไม่พบเคสที่กำลังดำเนินการอยู่ค่ะ หากต้องการเปิดเคสใหม่ รบกวนพิมพ์รายละเอียดปัญหาเข้ามาได้เลยนะคะ" });
    return { processed: true, duplicate: false, caseDetail: undefined };
  }

  const classificationText = classifiedIntent.resolvedMessage ?? resolvedMessage ?? input.text;
  const canCreateNewCase = classifiedIntent.intent === "NEW_SUPPORT_ISSUE"
    && classifiedIntent.shouldCreateCase
    && intentIsConfident
    && hasActualProblemDescription(classificationText);
  if (!isNewCaseRequest && !canCreateNewCase && (classifiedIntent.intent === "UNKNOWN" || classifiedIntent.intent === "NEW_SUPPORT_ISSUE")) {
    const reply = isShortFollowUp(input.text) && !lastKnownTopic
      ? "ขอทราบเพิ่มเติมค่ะ ตอนนี้อะไรทำงานช้า เช่น อินเทอร์เน็ต เครื่องคอมพิวเตอร์ หรือระบบที่กำลังใช้งานอยู่คะ"
      : activeCase
      ? "ยังไม่แน่ใจว่าต้องการเพิ่มข้อมูลในเรื่องเดิมหรือแจ้งปัญหาใหม่ค่ะ รบกวนพิมพ์ว่า “เรื่องเดิม” หรือ “เปิดเคสใหม่” ให้ชัดเจนอีกครั้งนะคะ"
      : "ยังไม่แน่ใจว่าต้องการสอบถามเรื่องใดค่ะ หากพบปัญหา รบกวนแจ้งอาการหรือหมายเลขเคสเพิ่มเติมได้เลยนะคะ";
    await lineClient.replyToToken({ replyToken: input.replyToken, text: reply });
    return { processed: true, duplicate: false, caseDetail: undefined };
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

  let matchedExistingCase: CaseDetail | undefined;
  if (!isNewCaseRequest && classifiedIntent.intent === "FOLLOW_UP_EXISTING_CASE" && activeCase) {
    const activeCandidates = customerCases.filter((item) => ACTIVE_CASE_STATUSES.has(item.status));
    const matchedId = classifiedIntent.matchedActiveCaseId;
    if (matchedId) {
      matchedExistingCase = activeCandidates.find((item) => item.id === matchedId);
    }
    if (!matchedExistingCase && activeCandidates.length === 1) {
      matchedExistingCase = activeCase;
    }
    if (!matchedExistingCase && activeCandidates.length > 1) {
      await store.setPendingCaseSelection(customer.id, {
        mode: "choose",
        candidateCaseIds: activeCandidates.slice(0, 5).map((item) => item.id),
        createdAt: new Date().toISOString(),
      });
      const rows = activeCandidates.slice(0, 5).map((item, index) => `${index + 1}. ${item.caseNumber} — ${caseService.formatCaseTitle(item)}`);
      await lineClient.replyToToken({
        replyToken: input.replyToken,
        text: `ต้องการอัปเดตเคสไหนคะ\n\n${rows.join("\n")}\n\nพิมพ์หมายเลข 1-${Math.min(activeCandidates.length, 5)} ได้เลยค่ะ`,
      });
      return { processed: true, duplicate: false, caseDetail: undefined };
    }
  }

  if (!isNewCaseRequest && !matchedExistingCase && classifiedIntent.intent !== "FOLLOW_UP_EXISTING_CASE") {
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
    // With an active case, a new-looking message still needs confirmation.
    // Only a customer without an active case may continue directly to creation.
    isNewCaseRequest = !activeCase;
  }
  const confirmsNewCase = isNewCaseRequest;
  const intakeText = pendingNewCaseText ?? input.text;
  const analysisIntakeText = classifiedIntent.resolvedMessage ?? resolvedMessage ?? intakeText;
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
    : matchedExistingCase ?? await caseService.findRelatedLineCase({
        customerId: customer.id,
        newText: intakeText,
        receivedAt: input.timestamp ? new Date(input.timestamp).toISOString() : undefined,
      });

  if (relatedCase) {
    const relatedResult = await caseService.appendLineMessageToCase({
      caseId: relatedCase.id,
      text: intakeText,
      resolvedText: classifiedIntent.resolvedMessage ?? resolvedMessage,
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
    text: analysisIntakeText,
    customerDisplayName: customer.displayName,
  });
  const caseTitle = await aiCenterClient.generateCaseTitle(analysisIntakeText);

  await store.createAnalysis({
    caseId: supportCase.id,
    messageId: message.id,
    analysisType: "customer_message",
    summary: analysis.summary,
    category: analysis.category,
    confidence: analysis.confidence,
    rawJson: { ...analysis, caseTitle },
  });
  await store.updateCase(supportCase.id, {
    status: "awaiting_tech",
    title: caseTitle,
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

  let caseDetail = await store.getCaseDetail(supportCase.id);
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

  const acknowledgement = buildInitialCaseAcknowledgement({
    caseNumber: supportCase.caseNumber,
    caseTitle,
  });
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
    messageType: "CASE_ACKNOWLEDGEMENT",
    deliveryStatus: acknowledgementDelivery.delivered ? "delivered" : "pending",
  });
  await store.updateCase(supportCase.id, {
    lineSentAt: new Date().toISOString(),
    lineDeliveredAt: acknowledgementDelivery.delivered ? new Date().toISOString() : undefined,
  });

  caseDetail = await store.getCaseDetail(supportCase.id);

  return {
    processed: true,
    duplicate: false,
    caseDetail,
  };
}
