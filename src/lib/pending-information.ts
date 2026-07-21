export const PENDING_INFORMATION_FIELDS = [
  "subjectOrTeam",
  "submittedAtText",
  "deviceModel",
  "operatingSystem",
  "browser",
  "appVersion",
  "errorCode",
  "screenshotOrAttachment",
  "occurredAtText",
  "networkContext",
  "reproductionSteps",
  "additionalDetails",
] as const;

export type PendingInformationField = (typeof PENDING_INFORMATION_FIELDS)[number];
export type PendingInformationValues = Partial<Record<PendingInformationField, string>>;

const fieldLabels: Record<PendingInformationField, string> = {
  subjectOrTeam: "ชื่อวิชาหรือทีมที่ส่งงาน",
  submittedAtText: "เวลาที่ส่งงาน",
  deviceModel: "รุ่นอุปกรณ์หรือรุ่นเครื่อง",
  operatingSystem: "ระบบปฏิบัติการ",
  browser: "เบราว์เซอร์ที่ใช้งาน",
  appVersion: "เวอร์ชันแอปหรือระบบ",
  errorCode: "รหัสหรือข้อความข้อผิดพลาด",
  screenshotOrAttachment: "ภาพหน้าจอหรือไฟล์ที่เกี่ยวข้อง",
  occurredAtText: "ช่วงเวลาที่พบปัญหา",
  networkContext: "เครือข่ายที่ใช้งาน",
  reproductionSteps: "ขั้นตอนที่ทำก่อนพบปัญหา",
  additionalDetails: "รายละเอียดเพิ่มเติม",
};

function uniqueFields(fields: PendingInformationField[]) {
  return [...new Set(fields)];
}

export function inferPendingInformationFields(texts: string[]) {
  const text = texts.join(" ").toLocaleLowerCase();
  const fields: PendingInformationField[] = [];

  if (/(ชื่อวิชา|วิชา|ชื่อทีม|ทีมที่ส่ง|subject|team)/u.test(text)) {
    fields.push("subjectOrTeam");
  }
  if (/(?:เวลาที่ส่งงาน|เวลา.*ส่งงาน|ส่งงาน.*(?:เวลา|ช่วงเวลา|กี่โมง)|submitted.*time|submit.*time)/u.test(text)) {
    fields.push("submittedAtText");
  }
  if (/(?:รุ่น(?:เครื่อง|อุปกรณ์)?|model|device|iphone|ipad|android|โน้ตบุ๊ก|คอมพิวเตอร์)/u.test(text)) fields.push("deviceModel");
  if (/(?:windows|macos|ios|android|ระบบปฏิบัติการ|operating system|os)/u.test(text)) fields.push("operatingSystem");
  if (/(?:chrome|edge|firefox|safari|เบราว์เซอร์|browser)/u.test(text)) fields.push("browser");
  if (/(?:เวอร์ชัน(?:แอป|ระบบ)?|version|build)/u.test(text)) fields.push("appVersion");
  if (/(?:error|รหัส(?:ข้อผิดพลาด)?|ข้อความ(?:แจ้งเตือน|ผิดพลาด)|code)/u.test(text)) fields.push("errorCode");
  if (/(?:ภาพหน้าจอ|แคปหน้าจอ|screenshot|รูป(?:ภาพ)?|ไฟล์แนบ|attachment|log)/u.test(text)) fields.push("screenshotOrAttachment");
  if (/(?:ช่วงเวลาที่พบ|เวลา(?:ที่)?เกิด(?:ปัญหา|อาการ)|เมื่อไร(?:ที่)?พบ|เกิดตอน(?:ไหน|เวลา)|occurred.*time)/u.test(text)) fields.push("occurredAtText");
  if (/(?:เครือข่าย|อินเทอร์เน็ต|wifi|wi-fi|lan|vpn|network)/u.test(text)) fields.push("networkContext");
  if (/(?:ขั้นตอน|ทำอะไรมาก่อน|ก่อนพบปัญหา|วิธีที่ทำให้เกิด|reproduce)/u.test(text)) fields.push("reproductionSteps");

  return uniqueFields(fields.length > 0 ? fields : ["additionalDetails"]);
}

export function getPendingInformationLabel(field: PendingInformationField) {
  return fieldLabels[field];
}

export function getMissingPendingInformationFields(
  requestedFields: PendingInformationField[],
  collectedFields: PendingInformationValues,
) {
  return requestedFields.filter((field) => !collectedFields[field]?.trim());
}

export function buildMissingInformationQuestion(fields: PendingInformationField[]) {
  const labels = fields.map(getPendingInformationLabel);
  return `รบกวนแจ้ง${labels.join(" และ ")}เพิ่มเติมได้ไหมคะ`;
}

function extractTimeText(text: string) {
  const match = text.match(/(?:ช่วง|ตอน|เวลา)?\s*(?:(?:เช้า|บ่าย)\s*(?:[0-9๐-๙]+|หนึ่ง|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ)?(?:โมง)?|เที่ยง(?:คืน)?|(?:[0-9๐-๙]+|หนึ่ง|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ)\s*(?:โมง|น\.?|นาฬิกา))/u);
  return match?.[0]?.trim();
}

export function extractPendingInformationFallback(input: {
  text: string;
  requestedFields: PendingInformationField[];
}): PendingInformationValues {
  const values: PendingInformationValues = {};
  const text = input.text.trim();
  const timeText = extractTimeText(text);

  if (input.requestedFields.includes("submittedAtText") && timeText) {
    values.submittedAtText = timeText;
  }
  if (input.requestedFields.includes("occurredAtText") && timeText) {
    values.occurredAtText = timeText;
  }

  if (input.requestedFields.includes("subjectOrTeam")) {
    const subjectOrTeam = text
      .replace(timeText ?? "", " ")
      .replace(/^(วิชา|ทีม)\s*/u, "")
      .replace(/\s+/g, " ")
      .trim();
    if (subjectOrTeam) values.subjectOrTeam = subjectOrTeam;
  }

  if (input.requestedFields.includes("additionalDetails") && text) {
    values.additionalDetails = text;
  }

  const browser = text.match(/\b(chrome|edge|firefox|safari)\b/iu)?.[1];
  if (input.requestedFields.includes("browser") && browser) values.browser = browser;

  const operatingSystem = text.match(/\b(windows(?:\s*\d+)?|macos|ios(?:\s*\d+)?|android(?:\s*\d+)?)\b/iu)?.[1];
  if (input.requestedFields.includes("operatingSystem") && operatingSystem) values.operatingSystem = operatingSystem;

  const errorCode = text.match(/(?:error|code|รหัส)\s*[:#-]?\s*([A-Za-z0-9_-]{3,})/iu)?.[1];
  if (input.requestedFields.includes("errorCode") && errorCode) values.errorCode = errorCode;

  if (input.requestedFields.includes("screenshotOrAttachment") && /(?:ภาพหน้าจอ|แคปหน้าจอ|screenshot|รูป(?:ภาพ)?|ไฟล์แนบ|attachment|log)/iu.test(text)) {
    values.screenshotOrAttachment = text;
  }

  return values;
}

export function sanitizePendingInformationValues(
  values: Record<string, unknown> | undefined,
  requestedFields: PendingInformationField[],
): PendingInformationValues {
  const sanitized: PendingInformationValues = {};
  if (!values) return sanitized;

  for (const field of requestedFields) {
    const value = values[field];
    if (typeof value === "string" && value.trim() && value.trim().length <= 240) {
      sanitized[field] = value.trim();
    }
  }
  return sanitized;
}

export function formatPendingInformation(values: PendingInformationValues) {
  const parts: string[] = [];
  if (values.subjectOrTeam) parts.push(`วิชา/ทีม ${values.subjectOrTeam}`);
  if (values.submittedAtText) parts.push(`ส่งงาน${values.submittedAtText}`);
  if (values.deviceModel) parts.push(`รุ่นอุปกรณ์ ${values.deviceModel}`);
  if (values.operatingSystem) parts.push(`ระบบปฏิบัติการ ${values.operatingSystem}`);
  if (values.browser) parts.push(`เบราว์เซอร์ ${values.browser}`);
  if (values.appVersion) parts.push(`เวอร์ชัน ${values.appVersion}`);
  if (values.errorCode) parts.push(`รหัสข้อผิดพลาด ${values.errorCode}`);
  if (values.screenshotOrAttachment) parts.push(`ไฟล์แนบ/ภาพหน้าจอ ${values.screenshotOrAttachment}`);
  if (values.occurredAtText) parts.push(`พบปัญหาช่วง ${values.occurredAtText}`);
  if (values.networkContext) parts.push(`เครือข่าย ${values.networkContext}`);
  if (values.reproductionSteps) parts.push(`ขั้นตอนก่อนพบปัญหา ${values.reproductionSteps}`);
  if (values.additionalDetails) parts.push(values.additionalDetails);
  return parts.join(" ");
}
