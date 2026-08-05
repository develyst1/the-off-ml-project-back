const recipientPatterns = [
  /^เรียน\s*(?:คุณ)?ลูกค้า\s*[:：,]?\s*/iu,
  /^คุณลูกค้า\s*[:：,]?\s*/iu,
  /^เรียนท่าน\s*[:：,]?\s*/iu,
];

/** Keeps LINE-facing text natural and avoids exposing internal recipient labels. */
export function sanitizeCustomerFacingMessage(input: string) {
  let message = input.trim();

  for (const pattern of recipientPatterns) {
    message = message.replace(pattern, "");
  }

  return message
    .replace(/\*\*|`/g, "")
    .replace(/(^|\n)\s*[-*•]\s+/gu, "$1")
    .replace(/(^|[\n\s])(?:รบกวน|ขอให้)\s*ลูกค้า(?=\s|$)/gu, "$1รบกวน")
    .replace(/(^|[\n\s])(?:ทาง)?\s*ลูกค้า\s*(?:สามารถ)?(?=\s|$)/gu, "$1")
    .replace(/(^|[\n\s])คุณ\s*ลูกค้า(?=\s|$)/gu, "$1")
    .replace(/ลูกค้า/gu, "")
    .replace(/(^|[\n\s])(?:รบกวน|ขอให้)\s*ผู้ใช้งาน(?=\s|$)/gu, "$1รบกวน")
    .replace(/(^|[\n\s])(?:ทาง)?\s*ผู้ใช้งาน\s*(?:สามารถ)?(?=\s|$)/gu, "$1")
    .replace(/ผู้ใช้งาน/gu, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const CUSTOMER_REPLY_FALLBACK =
  "ตรวจสอบข้อมูลเรียบร้อยแล้วค่ะ หากยังพบอาการเดิม แจ้งรายละเอียดเพิ่มเติมกลับมาได้เลยนะคะ";

export const MORE_INFO_REQUEST_FALLBACK =
  "ขอข้อมูลเพิ่มนิดหนึ่งค่ะ รบกวนแจ้งรายละเอียดเพิ่มเติมเกี่ยวกับอาการที่พบด้วยนะคะ";
