type Env = {
  NODE_ENV: string;
  PORT: number;
  AI_CENTER_BASE_URL?: string;
  AI_CENTER_BRUNO_COLLECTION_PATH?: string;
  AI_CENTER_PROVIDER?: string;
  AI_CENTER_MODEL?: string;
  AI_CENTER_TEMPERATURE: number;
  AI_CENTER_MAX_TOKENS: number;
  AI_CENTER_TIMEOUT_MS: number;
  DATABASE_URL?: string;
  DATABASE_SSL: boolean;
  LINE_CHANNEL_SECRET?: string;
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  TEAMS_WEBHOOK_URL?: string;
  FRONTEND_BASE_URL: string;
};

const port = Number(Bun.env.PORT ?? 4000);
const aiCenterTemperature = Number(Bun.env.AI_CENTER_TEMPERATURE ?? 0.2);
const aiCenterMaxTokens = Number(Bun.env.AI_CENTER_MAX_TOKENS ?? 900);
const aiCenterTimeoutMs = Number(Bun.env.AI_CENTER_TIMEOUT_MS ?? 15000);
const databaseSsl = Bun.env.DATABASE_SSL === "true";

if (!Number.isInteger(port) || port <= 0) {
  throw new Error("PORT must be a positive integer");
}

if (!Number.isFinite(aiCenterTemperature) || aiCenterTemperature < 0 || aiCenterTemperature > 2) {
  throw new Error("AI_CENTER_TEMPERATURE must be a number between 0 and 2");
}

if (!Number.isInteger(aiCenterMaxTokens) || aiCenterMaxTokens <= 0) {
  throw new Error("AI_CENTER_MAX_TOKENS must be a positive integer");
}

if (!Number.isInteger(aiCenterTimeoutMs) || aiCenterTimeoutMs < 1000) {
  throw new Error("AI_CENTER_TIMEOUT_MS must be an integer of at least 1000");
}

export const env: Env = {
  NODE_ENV: Bun.env.NODE_ENV ?? "development",
  PORT: port,
  AI_CENTER_BASE_URL: Bun.env.AI_CENTER_BASE_URL,
  AI_CENTER_BRUNO_COLLECTION_PATH: Bun.env.AI_CENTER_BRUNO_COLLECTION_PATH,
  AI_CENTER_PROVIDER: Bun.env.AI_CENTER_PROVIDER,
  AI_CENTER_MODEL: Bun.env.AI_CENTER_MODEL,
  AI_CENTER_TEMPERATURE: aiCenterTemperature,
  AI_CENTER_MAX_TOKENS: aiCenterMaxTokens,
  AI_CENTER_TIMEOUT_MS: aiCenterTimeoutMs,
  DATABASE_URL: Bun.env.DATABASE_URL,
  DATABASE_SSL: databaseSsl,
  LINE_CHANNEL_SECRET: Bun.env.LINE_CHANNEL_SECRET,
  LINE_CHANNEL_ACCESS_TOKEN: Bun.env.LINE_CHANNEL_ACCESS_TOKEN,
  TEAMS_WEBHOOK_URL: Bun.env.TEAMS_WEBHOOK_URL,
  FRONTEND_BASE_URL: Bun.env.FRONTEND_BASE_URL ?? "https://offml.develyst.online",
};
