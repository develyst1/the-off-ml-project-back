# the-off-ml-project-back

Backend ของโปรเจค **Off Mai / ออฟใหม่** ระบบผู้ช่วย Tech Support ที่รับคำถามหรือแจ้งปัญหาจากลูกค้าผ่าน LINE แล้วใช้ API AI CENTER วิเคราะห์ข้อมูล ก่อนส่งต่อให้ทีม Tech Support ผ่าน MS Teams และนำคำตอบของทีมมาวิเคราะห์/ปรับภาษาเพื่อส่งกลับลูกค้า

เป้าหมายระยะยาวคือสะสมข้อมูลเคสจริง วิธีแก้ปัญหา หมวดหมู่ และค่าความมั่นใจ เพื่อพัฒนาไปสู่การแนะนำ solution อัตโนมัติ และอาจต่อยอดเป็น auto-answer ผ่าน LINE ในอนาคต

## Tech Stack

- Bun
- TypeScript
- Hono
- API AI CENTER
- LINE Messaging API
- MS Teams integration

## Flow หลักของระบบ

1. ลูกค้าส่งข้อความหรือแจ้งปัญหาผ่าน LINE
2. Backend รับ event ที่ `POST /webhooks/line`
3. Backend สร้างข้อมูลลูกค้า, case และ message
4. Backend เรียก API AI CENTER เพื่อวิเคราะห์ข้อความลูกค้า
5. Backend เก็บ original message และผลวิเคราะห์ลง database
6. Backend ส่งข้อมูลเคสให้ทีม Tech Support ใน MS Teams
7. ทีม Tech Support ตอบกลับใน MS Teams
8. Backend รับคำตอบที่ `POST /webhooks/teams`
9. Backend เรียก API AI CENTER เพื่อสกัดวิธีแก้ปัญหาและปรับข้อความให้ลูกค้าเข้าใจง่าย
10. Backend ส่งคำตอบกลับลูกค้าผ่าน LINE
11. Backend เก็บ solution และประวัติทั้งหมดไว้เพื่อใช้เรียนรู้ในอนาคต

## สถานะปัจจุบัน

ตอนนี้เป็น backend skeleton สำหรับเริ่มพัฒนา flow ก่อนต่อระบบจริงทั้งหมด

- มี Hono server แล้ว
- มี route สำหรับ LINE webhook และ Teams webhook แล้ว
- มี service layer สำหรับควบคุม flow หลักแล้ว
- มี AI CENTER client ที่อิงจาก Bruno collection จริงแล้ว
- มี LINE และ Teams client แบบ mock/fallback แล้ว
- มี in-memory store ชั่วคราวแทน database
- ยังไม่ได้ต่อ database จริง
- ยังไม่ได้ verify signature ของ LINE/Teams จริง
- ยังไม่ได้ผูก payload จริงจาก LINE OA และ MS Teams แบบ production

## โครงสร้างโปรเจค

```text
src/
  app.ts                         Hono app และ route registration
  index.ts                       Bun server entrypoint
  config/
    env.ts                       อ่านค่า environment variables
  domain/
    types.ts                     type หลักของ case, customer, message, analysis, solution
  lib/
    ids.ts                       helper สร้าง id และ timestamp
    request.ts                   helper อ่าน/validate request body แบบง่าย
  repositories/
    in-memory-store.ts           store ชั่วคราวระหว่างยังไม่มี database จริง
  routes/
    health.ts                    health check
    cases.ts                     case API สำหรับ dashboard
    webhooks-line.ts             รับข้อความจาก LINE
    webhooks-teams.ts            รับคำตอบจาก MS Teams
    integrations.ts              endpoint สำหรับ trigger LINE/Teams integration
  services/
    case-service.ts              business flow หลัก
    ai-center-client.ts          client เรียก API AI CENTER
    line-client.ts               client ส่งข้อความกลับ LINE
    teams-client.ts              client ส่งเคสเข้า MS Teams
```

## การติดตั้ง

ติดตั้ง dependencies:

```powershell
bun install
```

ถ้า terminal ยังไม่เห็นคำสั่ง `bun` ให้ใช้ path เต็ม:

```powershell
C:\Users\User\.bun\bin\bun.exe install
```

สร้างไฟล์ `.env` จากตัวอย่าง:

```powershell
Copy-Item .env.example .env
```

รัน dev server:

```powershell
bun run dev
```

หรือใช้ path เต็ม:

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
- AI CENTER collection นี้เป็น `auth: none` ดังนั้น backend ไม่ต้องตั้งค่า key สำหรับเรียก AI CENTER
- Backend เรียก AI CENTER ผ่าน `POST /chat` โดยส่ง `messages`, `temperature`, `max_tokens` และ optional `provider`/`model`
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

ใช้รับข้อความจากลูกค้า ปัจจุบันยังเป็น payload แบบง่ายสำหรับทดสอบ

ตัวอย่าง request:

```json
{
  "lineUserId": "U123",
  "displayName": "Customer A",
  "text": "เข้าใช้งานระบบไม่ได้หลังเปลี่ยนรหัสผ่าน",
  "eventId": "line_event_001"
}
```

ผลลัพธ์:

- สร้าง customer
- สร้าง case
- เก็บ inbound customer message
- วิเคราะห์ข้อความด้วย AI CENTER หรือ mock fallback
- ส่งเคสเข้า MS Teams หรือ log mock
- เปลี่ยนสถานะ case เป็น `awaiting_tech`

### MS Teams Webhook

```text
POST /webhooks/teams
```

ใช้รับคำตอบจากทีม Tech Support ปัจจุบันยังเป็น payload แบบง่ายสำหรับทดสอบ

ตัวอย่าง request:

```json
{
  "caseId": "case_xxx",
  "text": "ปลดล็อก account ให้แล้ว ให้ลูกค้าลอง login ใหม่",
  "eventId": "teams_event_001"
}
```

ผลลัพธ์:

- เก็บ inbound tech message
- วิเคราะห์คำตอบทีมด้วย AI CENTER หรือ mock fallback
- สร้าง solution
- สร้างข้อความตอบลูกค้า
- ส่งข้อความกลับ LINE หรือ log mock
- เปลี่ยนสถานะ case เป็น `sent_to_customer`

### Case API

```text
GET /cases
GET /cases/:id
PATCH /cases/:id/status
```

ใช้สำหรับ frontend dashboard ในอนาคต เช่น case queue และ case detail

ตัวอย่าง update status:

```json
{
  "status": "closed"
}
```

สถานะที่รองรับตอนนี้:

```text
new
analyzing
awaiting_tech
tech_replied
analyzing_solution
resolved
sent_to_customer
closed
awaiting_confirmation
```

### Integration API

```text
POST /integrations/teams/notify
POST /integrations/line/reply
```

ใช้สำหรับ trigger integration เองระหว่างทดสอบหรือทำ admin action ใน dashboard

## ตรวจ TypeScript

```powershell
bun run typecheck
```

ถ้า PowerShell block คำสั่ง `tsc` โดยตรง ให้ใช้:

```powershell
tsc.cmd --version
```

หรือใช้ผ่าน Bun:

```powershell
bun x tsc --version
```

## ตัวอย่างการทดสอบ Flow

รัน server ก่อน:

```powershell
bun run dev
```

สร้าง case จาก LINE:

```powershell
curl.exe -X POST http://localhost:4000/webhooks/line `
  -H "content-type: application/json" `
  -d "{\"lineUserId\":\"U123\",\"displayName\":\"Customer A\",\"text\":\"เข้าใช้งานระบบไม่ได้หลังเปลี่ยนรหัสผ่าน\"}"
```

ดูรายการ case:

```powershell
curl.exe http://localhost:4000/cases
```

ส่งคำตอบจาก Teams โดยใช้ `caseId` ที่ได้จาก step ก่อนหน้า:

```powershell
curl.exe -X POST http://localhost:4000/webhooks/teams `
  -H "content-type: application/json" `
  -d "{\"caseId\":\"case_xxx\",\"text\":\"ปลดล็อก account ให้แล้ว ให้ลูกค้าลอง login ใหม่\"}"
```

## งานที่ควรทำต่อ

1. เลือกและต่อ database จริง เช่น PostgreSQL
2. ออกแบบ schema จริงสำหรับ `customers`, `cases`, `messages`, `analyses`, `solutions`, `confidence_matches`, `audit_logs`
3. ปรับ `POST /webhooks/line` ให้รับ payload จริงจาก LINE OA
4. เพิ่ม LINE signature verification
5. เลือกวิธีเชื่อม MS Teams จริง เช่น webhook, bot, adaptive card หรือ Graph API
6. ปรับ prompt/schema ของ AI CENTER ให้ตอบ JSON คงที่มากขึ้นสำหรับงาน analyze/rewrite
7. เพิ่ม idempotency สำหรับ webhook event ที่ส่งซ้ำ
8. เพิ่ม automated tests สำหรับ LINE intake และ Teams reply flow
9. เพิ่ม repository layer สำหรับเปลี่ยนจาก in-memory store เป็น database จริง
10. เพิ่ม logging, audit log และ retry policy สำหรับ integration ที่ล้มเหลว

## แนวทาง Phase ถัดไป

Phase 1: ทำ flow ให้ครบแบบ human-in-the-loop

- LINE -> Backend -> AI CENTER -> DB -> MS Teams
- MS Teams -> Backend -> AI CENTER -> DB -> LINE

Phase 2: ทำ dashboard

- Case queue
- Case detail
- AI analysis review
- Solution history

Phase 3: ทำ knowledge และ confidence

- จัดหมวดหมู่เคส
- จับคู่เคสใหม่กับเคสเก่า
- ถามทีมเมื่อ confidence 90-100%
- เพิ่ม confidence เมื่อทีมยืนยันว่า solution ถูกต้อง

Phase 4: เตรียม automation

- แสดง solution ที่ confidence 100%
- ให้ทีมพิจารณาว่าจะต่อ API, automate หรือ auto-answer LINE หรือไม่
