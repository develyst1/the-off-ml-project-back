const categoryLabels: Record<string, string> = {
  UNCATEGORIZED: "ยังไม่ระบุหมวดหมู่",
  "-": "ยังไม่ระบุหมวดหมู่",
  LOGIN_ISSUE: "เข้าสู่ระบบไม่ได้",
  LOGIN_FAILURE: "เข้าสู่ระบบไม่ได้",
  NETWORK_ISSUE: "ปัญหาการเชื่อมต่อเครือข่าย",
  NETWORK_CONNECTIVITY: "ปัญหาการเชื่อมต่อเครือข่าย",
  CONNECTIVITY_ISSUE: "ปัญหาการเชื่อมต่อเครือข่าย",
  PASSWORD_RESET: "รีเซ็ตรหัสผ่าน",
  PASSWORD_RESET_FAILURE: "รีเซ็ตรหัสผ่านไม่สำเร็จ",
  PAYMENT_ISSUE: "ปัญหาการชำระเงิน",
  BLUE_SCREEN: "หน้าจอสีฟ้า (Blue Screen)",
  "ภาพแสดงสีฟ้า (BLUE SCREEN)": "หน้าจอสีฟ้า (Blue Screen)",
  RESOLVED: "ดำเนินการเรียบร้อย",
};

export function normalizeCategory(category?: string) {
  const value = category?.trim();
  if (!value) return "ยังไม่ระบุหมวดหมู่";
  return categoryLabels[value.toUpperCase()] ?? value;
}
