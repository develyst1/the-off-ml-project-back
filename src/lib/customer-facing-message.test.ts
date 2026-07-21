import { describe, expect, test } from "bun:test";
import {
  CUSTOMER_REPLY_FALLBACK,
  MORE_INFO_REQUEST_FALLBACK,
  sanitizeCustomerFacingMessage,
} from "./customer-facing-message";

describe("sanitizeCustomerFacingMessage", () => {
  test("removes formal recipient openings and direct customer labels", () => {
    const result = sanitizeCustomerFacingMessage("เรียนคุณลูกค้า: รบกวนลูกค้าลองใหม่ค่ะ");

    expect(result).toBe("รบกวนลองใหม่ค่ะ");
    expect(result).not.toContain("ลูกค้า");
  });

  test("removes markdown without changing the useful message", () => {
    expect(sanitizeCustomerFacingMessage("**ลองปิดเครื่อง** แล้วเปิดใหม่ค่ะ")).toBe("ลองปิดเครื่อง แล้วเปิดใหม่ค่ะ");
  });

  test("provides mode-specific fallbacks", () => {
    expect(CUSTOMER_REPLY_FALLBACK).toContain("ตรวจสอบข้อมูลเรียบร้อยแล้วค่ะ");
    expect(MORE_INFO_REQUEST_FALLBACK).toContain("ขอข้อมูลเพิ่มนิดหนึ่งค่ะ");
  });
});
