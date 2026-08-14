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

const categoryKeys: Record<string, string> = {
  UNCATEGORIZED: "OTHER",
  "-": "OTHER",
  LOGIN_ISSUE: "LOGIN_ACCESS",
  LOGIN_FAILURE: "LOGIN_ACCESS",
  PASSWORD_RESET: "LOGIN_ACCESS",
  PASSWORD_RESET_FAILURE: "LOGIN_ACCESS",
  "เข้าสู่ระบบไม่ได้": "LOGIN_ACCESS",
  "ปัญหาการเข้าสู่ระบบ": "LOGIN_ACCESS",
  NETWORK_ISSUE: "NETWORK_CONNECTION",
  NETWORK_CONNECTIVITY: "NETWORK_CONNECTION",
  CONNECTIVITY_ISSUE: "NETWORK_CONNECTION",
  "ปัญหาการเชื่อมต่อเครือข่าย": "NETWORK_CONNECTION",
  "ปัญหาการเชื่อมต่อเครือข่ายอินเทอร์เน็ต": "NETWORK_CONNECTION",
  STATUS_UPDATE: "STATUS_UPDATE",
  "ปัญหาการอัปเดตสถานะ": "STATUS_UPDATE",
  "ปัญหาฮาร์ดแวร์": "HARDWARE_DEVICE",
  BLUE_SCREEN: "HARDWARE_DEVICE",
  "ภาพแสดงสีฟ้า (BLUE SCREEN)": "HARDWARE_DEVICE",
  "ปัญหาซอฟต์แวร์": "SOFTWARE_APPLICATION",
  "ปัญหาการแสดงข้อมูล": "DATA_DISPLAY",
  PAYMENT_ISSUE: "OTHER",
  RESOLVED: "OTHER",
};

const categoryKeyLabels: Record<string, string> = {
  NETWORK_CONNECTION: "ปัญหาการเชื่อมต่อเครือข่าย",
  LOGIN_ACCESS: "ปัญหาการเข้าสู่ระบบ",
  STATUS_UPDATE: "ปัญหาการอัปเดตสถานะ",
  HARDWARE_DEVICE: "ปัญหาฮาร์ดแวร์",
  SOFTWARE_APPLICATION: "ปัญหาซอฟต์แวร์",
  DATA_DISPLAY: "ปัญหาการแสดงข้อมูล",
  OTHER: "อื่นๆ",
};

export function categoryKeyOf(category?: string | null) {
  const value = category?.trim();
  if (!value || ["undefined", "null", "-", "uncategorized", "ยังไม่ระบุหมวดหมู่"].includes(value.toLowerCase())) return "OTHER";
  if (value.startsWith("AI_")) return value;
  const upper = value.toUpperCase();
  return categoryKeys[upper] ?? categoryKeys[value] ?? (categoryKeyLabels[upper] ? upper : `AI_${encodeURIComponent(value)}`);
}

export function categoryLabelOf(category?: string | null) {
  const key = categoryKeyOf(category);
  if (key.startsWith("AI_")) return "อื่นๆ";
  return categoryKeyLabels[key] ?? "อื่นๆ";
}

export function normalizeCategory(category?: string) {
  return categoryKeyOf(category);
}
