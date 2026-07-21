import { describe, expect, test } from "bun:test";
import { extractPendingInformationFallback, inferPendingInformationFields } from "./pending-information";

describe("pending information fields", () => {
  test("maps common technical requests to canonical fields", () => {
    expect(inferPendingInformationFields(["ขอรุ่นเครื่อง ระบบปฏิบัติการ เบราว์เซอร์ และรหัส error"])).toEqual([
      "deviceModel",
      "operatingSystem",
      "browser",
      "errorCode",
    ]);
    expect(inferPendingInformationFields(["รบกวนส่งภาพหน้าจอ พร้อมแจ้งช่วงเวลาที่พบปัญหาและเครือข่ายที่ใช้"])).toEqual([
      "screenshotOrAttachment",
      "occurredAtText",
      "networkContext",
    ]);
  });

  test("extracts explicit browser, operating system, error code, and attachment details", () => {
    expect(extractPendingInformationFallback({
      text: "Windows 11 ใช้ Chrome ขึ้น error 0x80070005 และส่งภาพหน้าจอแล้ว",
      requestedFields: ["operatingSystem", "browser", "errorCode", "screenshotOrAttachment"],
    })).toMatchObject({
      operatingSystem: "Windows 11",
      browser: "Chrome",
      errorCode: "0x80070005",
      screenshotOrAttachment: "Windows 11 ใช้ Chrome ขึ้น error 0x80070005 และส่งภาพหน้าจอแล้ว",
    });
  });
});
