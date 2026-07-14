import type { Analysis, CaseDetail, CaseStatus, Customer, Message, Solution, SupportCase } from "../domain/types";

export type CaseStore = {
  upsertCustomer(input: { lineUserId: string; displayName?: string }): Promise<Customer>;
  createCase(input: { customerId: string; status?: CaseStatus; category?: string; confidenceScore?: number }): Promise<SupportCase>;
  updateCase(id: string, patch: Partial<Omit<SupportCase, "id" | "customerId" | "createdAt">>): Promise<SupportCase>;
  createMessage(input: Omit<Message, "id" | "createdAt">): Promise<Message>;
  getMessageByExternalMessageId(externalMessageId: string): Promise<Message | undefined>;
  createAnalysis(input: Omit<Analysis, "id" | "createdAt">): Promise<Analysis>;
  createSolution(input: Omit<Solution, "id" | "createdAt">): Promise<Solution>;
  listCases(): Promise<CaseDetail[]>;
  getCaseDetail(id: string): Promise<CaseDetail | undefined>;
};
