export const PENDING_INFORMATION_FIELDS = ["subjectOrTeam", "submittedAtText", "additionalDetails"] as const;

export type PendingInformationField = (typeof PENDING_INFORMATION_FIELDS)[number];
export type PendingInformationValues = Partial<Record<PendingInformationField, string>>;

const fieldLabels: Record<PendingInformationField, string> = {
  subjectOrTeam: "ชื่อวิชาหรือทีมที่ส่งงาน",
  submittedAtText: "เวลาที่ส่งงาน",
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
  if (values.additionalDetails) parts.push(values.additionalDetails);
  return parts.join(" ");
}
