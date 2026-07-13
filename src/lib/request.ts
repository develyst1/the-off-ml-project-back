import type { Context } from "hono";

export async function readJsonObject(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null);

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Request body must be a JSON object");
  }

  return body as Record<string, unknown>;
}

export function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }

  return value.trim();
}

export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];

  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }

  return value.trim();
}
