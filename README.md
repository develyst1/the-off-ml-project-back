# the-off-ml-project-back

Backend ของโปรเจกต์ **Off ML Project** ระบบผู้ช่วย Tech Support ที่รับคำถามหรือแจ้งปัญหาจากลูกค้าผ่าน LINE แล้วใช้ API AI CENTER วิเคราะห์ข้อมูล ก่อนส่งต่อให้ทีม Tech Support ผ่าน MS Teams และนำคำตอบของทีมมาวิเคราะห์/ปรับภาษาเพื่อส่งกลับลูกค้า

เป้าหมายระยะยาวคือสะสมข้อมูลเคสจริง วิธีแก้ปัญหา หมวดหมู่ และค่าความมั่นใจ เพื่อนำไปใช้แนะนำ solution และต่อยอดเป็น guarded auto-answer ผ่าน LINE

## Tech Stack

- Bun
- TypeScript
- Hono
- PostgreSQL
- API AI CENTER
- LINE Messaging API
- MS Teams integration

## Flow หลัก

1. ลูกค้าส่งข้อความหรือแจ้งปัญหาผ่าน LINE
2. Backend รับ event ที่ `POST /webhooks/line`
3. Backend สร้าง customer, case และ message
4. Backend เรียก API AI CENTER เพื่อวิเคราะห์ข้อความลูกค้า
5. Backend เก็บ original message และผลวิเคราะห์ลง database
6. Backend ส่งข้อมูลเคสให้ทีม Tech Support ใน MS Teams
7. ทีม Tech Support ตอบกลับใน MS Teams
8. Backend รับคำตอบที่ `POST /webhooks/teams`
9. Backend เรียก API AI CENTER เพื่อสกัดวิธีแก้ปัญหาและปรับข้อความให้ลูกค้าเข้าใจง่าย
10. Backend ส่งคำตอบกลับลูกค้าผ่าน LINE
11. Backend เก็บ solution และประวัติทั้งหมดไว้เพื่อใช้เรียนรู้ในอนาคต

## สถานะปัจจุบัน

- มี Hono server แล้ว
- มี route สำหรับ LINE webhook และ Teams webhook แล้ว
- มี service layer สำหรับควบคุม flow หลักแล้ว
- มี AI CENTER client ที่อิงจาก Bruno collection แล้ว
- มี LINE และ Teams client แบบ mock/fallback แล้ว
- ต่อ PostgreSQL จริงผ่าน `DATABASE_URL` แล้ว
- มี in-memory store เป็น fallback เมื่อไม่ตั้งค่า `DATABASE_URL`
- ยังไม่ได้ verify signature ของ LINE/Teams จริง
- ยังไม่ได้ผูก payload จริงจาก LINE OA และ MS Teams แบบ production

## การติดตั้ง

```powershell
bun install
Copy-Item .env.example .env
bun run db:ensure
bun run dev
```

ถ้า terminal ยังไม่เห็นคำสั่ง `bun` ให้ใช้ path เต็ม:

```powershell
C:\Users\User\.bun\bin\bun.exe run dev
```

ค่าเริ่มต้นของ server:

```text
http://localhost:4000
```

## Environment Variables

```text
NODE_ENV=development
PORT=4000

DATABASE_URL=postgresql://postgres:password@localhost:5432/the_off_ml_project
DATABASE_SSL=false

AI_CENTER_BASE_URL=http://localhost:3009
AI_CENTER_BRUNO_COLLECTION_PATH=C:\Users\User\Downloads\bruno\bruno
AI_CENTER_PROVIDER=
AI_CENTER_MODEL=
AI_CENTER_TEMPERATURE=0.2
AI_CENTER_MAX_TOKENS=900

LINE_CHANNEL_SECRET=
LINE_CHANNEL_ACCESS_TOKEN=

TEAMS_WEBHOOK_URL=
```

หมายเหตุ:

- AI CENTER อ้างอิงจาก Bruno collection ที่ `C:\Users\User\Downloads\bruno\bruno`
- Bruno local environment ใช้ `baseUrl: http://localhost:3009`
- Bruno production environment ใช้ `baseUrl: https://ai.develyst.online`
- ถ้า `AI_CENTER_BASE_URL` ว่าง ระบบจะใช้ผลวิเคราะห์ mock
- ถ้า `TEAMS_WEBHOOK_URL` ว่าง ระบบจะ log ข้อความ Teams ใน console
- ถ้า `LINE_CHANNEL_ACCESS_TOKEN` ว่าง ระบบจะ log ข้อความ LINE ใน console

## API Endpoints

### Health

```text
GET /health
```

ใช้ตรวจว่า server ทำงานอยู่

### LINE Webhook

```text
POST /webhooks/line
```

ตัวอย่าง request:

```json
{
  "lineUserId": "U123",
  "displayName": "Customer A",
  "text": "เข้าระบบไม่ได้หลังเปลี่ยนรหัสผ่าน",
  "eventId": "line_event_001"
}
```

ผลลัพธ์คือสร้าง customer/case/message, วิเคราะห์ข้อความ, ส่งเคสเข้า MS Teams และเปลี่ยนสถานะเป็น `awaiting_tech`

### MS Teams Webhook

```text
POST /webhooks/teams
```

ตัวอย่าง request:

```json
{
  "caseId": "case_xxx",
  "caseNumber": 10,
  "text": "ปลดล็อก account ให้แล้ว ให้ลูกค้าลอง login ใหม่",
  "eventId": "teams_event_001"
}
```

Power Automate ต้องเรียก endpoint นี้หลังทีมตอบกลับในเธรด โดยส่ง `caseId` หรือ `caseNumber` พร้อมข้อความตอบกลับและ `eventId` ที่ไม่ซ้ำกัน ผลลัพธ์คือเก็บคำตอบทีม, วิเคราะห์ solution, สร้างข้อความตอบลูกค้า, ส่งกลับ LINE และเปลี่ยนสถานะเป็น `sent_to_customer`

### Case API

```text
GET /cases
GET /cases/:id
PATCH /cases/:id/status
```

ใช้สำหรับ frontend dashboard เช่น case queue และ case detail

ตัวอย่าง update status:

```json
{
  "status": "closed"
}
```

## Scripts

```text
bun run dev        รัน dev server
bun run start      รัน server
bun run typecheck  ตรวจ TypeScript
bun run db:ensure  สร้าง database ตาม DATABASE_URL ถ้ายังไม่มี
```
