const CLOSURE_ONLY_PATTERN = /(?:ปิดเคส|ขอปิดเคส|ดำเนินการ(?:เรียบร้อย|เสร็จสิ้น)|ตรวจสอบ(?:เรียบร้อย|เสร็จสิ้น)|ขอบคุณ(?:ที่แจ้ง|สำหรับข้อมูล)|หากยังพบปัญหา.*(?:ติดต่อ|ตอบกลับ)|ทีมงาน.*(?:ตรวจสอบ|ดำเนินการ).*เรียบร้อย)/iu;
const TROUBLESHOOTING_ACTION_PATTERN = /(?:ลอง|ตรวจสอบ|รีสตาร์ต|restart|reset|รีเซ็ต|รหัสผ่าน|password|ปิด|เปิด|ล้าง|clear|เปลี่ยน|ติดตั้ง|อัปเดต|update|ออกจากระบบ|เข้าสู่ระบบ|กด|ถอด|เสียบ|ตั้งค่า|เชื่อมต่อ|แนบ|ส่งภาพ|แจ้ง(?:รหัส|ข้อความผิดพลาด)|ติดต่อศูนย์)/iu;

export function actionableSolutionSteps(steps: string[] | undefined) {
  return (steps ?? [])
    .map((step) => step.trim())
    .filter((step) => step.length > 0)
    .filter((step) => !CLOSURE_ONLY_PATTERN.test(step))
    .filter((step) => TROUBLESHOOTING_ACTION_PATTERN.test(step));
}

export function hasActionableSolutionSteps(steps: string[] | undefined) {
  return actionableSolutionSteps(steps).length > 0;
}
