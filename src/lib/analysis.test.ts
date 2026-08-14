import { expect, test } from "bun:test";
import { getAnalysisSourceMessageIds, getAnalysisTechnicalTopic, normalizeTechnicalTopic } from "./analysis";

test("keeps a concise Thai technical topic and hides invalid values", () => {
  expect(normalizeTechnicalTopic("  ขนาดไฟล์เกินกำหนด  ")).toBe("ขนาดไฟล์เกินกำหนด");
  expect(normalizeTechnicalTopic("FILE_UPLOAD_LIMIT")).toBeUndefined();
  expect(normalizeTechnicalTopic(123)).toBeUndefined();
});

test("reads the technical topic from analysis raw JSON without requiring schema changes", () => {
  expect(getAnalysisTechnicalTopic({ rawJson: { technicalTopic: "รหัสผ่านหมดอายุ" } })).toBe("รหัสผ่านหมดอายุ");
  expect(getAnalysisTechnicalTopic({ rawJson: {} })).toBeUndefined();
});

test("resolves canonical source message ids from current and legacy analysis JSON", () => {
  expect(getAnalysisSourceMessageIds({
    rawJson: {
      sourceMessageIds: ["inbox-current", "inbox-current"],
      caseAnalysisContext: {
        referenceMessages: [{ messageId: "inbox-legacy" }, { messageId: 123 }],
      },
    },
  })).toEqual(["inbox-current"]);
  expect(getAnalysisSourceMessageIds({
    rawJson: {
      caseAnalysisContext: { referenceMessages: [{ messageId: "inbox-legacy" }] },
    },
  })).toEqual(["inbox-legacy"]);
  expect(getAnalysisSourceMessageIds({ rawJson: {} })).toEqual([]);
});
