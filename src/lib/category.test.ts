import { expect, test } from "bun:test";
import { categoryKeyOf, categoryLabelOf } from "./category";

test("renders canonical and legacy category keys as Thai labels", () => {
  expect(categoryLabelOf("SOFTWARE_APPLICATION")).toBe("ปัญหาซอฟต์แวร์");
  expect(categoryLabelOf("NETWORK_ISSUE")).toBe("ปัญหาการเชื่อมต่อเครือข่าย");
  expect(categoryLabelOf("PASSWORD_RESET_FAILURE")).toBe("ปัญหาการเข้าสู่ระบบ");
  expect(categoryLabelOf("BLUE_SCREEN")).toBe("ปัญหาฮาร์ดแวร์");
});

test("keeps unknown internal identity but never exposes it as a display label", () => {
  expect(categoryKeyOf("UNMAPPED_FUTURE_CATEGORY")).toBe("AI_UNMAPPED_FUTURE_CATEGORY");
  expect(categoryLabelOf("UNMAPPED_FUTURE_CATEGORY")).toBe("อื่นๆ");
  expect(categoryLabelOf("AI_UNMAPPED_FUTURE_CATEGORY")).toBe("อื่นๆ");
  expect(categoryLabelOf(undefined)).toBe("อื่นๆ");
});
