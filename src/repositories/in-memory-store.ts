import type { Analysis, CaseDetail, CaseStatus, Customer, Message, Solution, SupportCase } from "../domain/types";
import { createId, nowIso } from "../lib/ids";

class InMemoryStore {
  private customers = new Map<string, Customer>();
  private customersByLineUserId = new Map<string, string>();
  private cases = new Map<string, SupportCase>();
  private messages = new Map<string, Message>();
  private analyses = new Map<string, Analysis>();
  private solutions = new Map<string, Solution>();

  upsertCustomer(input: { lineUserId: string; displayName?: string }): Customer {
    const existingId = this.customersByLineUserId.get(input.lineUserId);
    const timestamp = nowIso();

    if (existingId) {
      const existing = this.customers.get(existingId);
      if (!existing) {
        throw new Error("Customer index is inconsistent");
      }

      const updated = {
        ...existing,
        displayName: input.displayName ?? existing.displayName,
        updatedAt: timestamp,
      };
      this.customers.set(updated.id, updated);
      return updated;
    }

    const customer: Customer = {
      id: createId("cus"),
      lineUserId: input.lineUserId,
      displayName: input.displayName,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.customers.set(customer.id, customer);
    this.customersByLineUserId.set(customer.lineUserId, customer.id);
    return customer;
  }

  createCase(input: { customerId: string; status?: CaseStatus; category?: string; confidenceScore?: number }): SupportCase {
    const timestamp = nowIso();
    const supportCase: SupportCase = {
      id: createId("case"),
      customerId: input.customerId,
      status: input.status ?? "new",
      category: input.category,
      confidenceScore: input.confidenceScore,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.cases.set(supportCase.id, supportCase);
    return supportCase;
  }

  updateCase(id: string, patch: Partial<Omit<SupportCase, "id" | "customerId" | "createdAt">>): SupportCase {
    const current = this.cases.get(id);

    if (!current) {
      throw new Error("Case not found");
    }

    const updated = {
      ...current,
      ...patch,
      updatedAt: nowIso(),
    };

    this.cases.set(id, updated);
    return updated;
  }

  createMessage(input: Omit<Message, "id" | "createdAt">): Message {
    const message: Message = {
      ...input,
      id: createId("msg"),
      createdAt: nowIso(),
    };

    this.messages.set(message.id, message);
    return message;
  }

  createAnalysis(input: Omit<Analysis, "id" | "createdAt">): Analysis {
    const analysis: Analysis = {
      ...input,
      id: createId("ana"),
      createdAt: nowIso(),
    };

    this.analyses.set(analysis.id, analysis);
    return analysis;
  }

  createSolution(input: Omit<Solution, "id" | "createdAt">): Solution {
    const solution: Solution = {
      ...input,
      id: createId("sol"),
      createdAt: nowIso(),
    };

    this.solutions.set(solution.id, solution);
    return solution;
  }

  listCases(): CaseDetail[] {
    return [...this.cases.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((supportCase) => this.getCaseDetail(supportCase.id))
      .filter((detail): detail is CaseDetail => Boolean(detail));
  }

  getCaseDetail(id: string): CaseDetail | undefined {
    const supportCase = this.cases.get(id);
    if (!supportCase) return undefined;

    const customer = this.customers.get(supportCase.customerId);
    if (!customer) return undefined;

    return {
      ...supportCase,
      customer,
      messages: [...this.messages.values()].filter((message) => message.caseId === id),
      analyses: [...this.analyses.values()].filter((analysis) => analysis.caseId === id),
      solutions: [...this.solutions.values()].filter((solution) => solution.caseId === id),
    };
  }
}

export const store = new InMemoryStore();
