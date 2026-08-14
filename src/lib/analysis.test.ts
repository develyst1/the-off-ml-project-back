import { expect, test } from "bun:test";
import { getAnalysisTechnicalTopic, normalizeTechnicalTopic } from "./analysis";

test("keeps a concise Thai technical topic and hides invalid values", () => {
  expect(normalizeTechnicalTopic("  ขนาดไฟล์เกินกำหนด  ")).toBe("ขนาดไฟล์เกินกำหนด");
  expect(normalizeTechnicalTopic("FILE_UPLOAD_LIMIT")).toBeUndefined();
  expect(normalizeTechnicalTopic(123)).toBeUndefined();
});

test("reads the technical topic from analysis raw JSON without requiring schema changes", () => {
  expect(getAnalysisTechnicalTopic({ rawJson: { technicalTopic: "รหัสผ่านหมดอายุ" } })).toBe("รหัสผ่านหมดอายุ");
  expect(getAnalysisTechnicalTopic({ rawJson: {} })).toBeUndefined();
});
