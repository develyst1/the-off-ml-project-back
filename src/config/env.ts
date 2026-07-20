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
  CASE_MATCH_CONFIDENCE_THRESHOLD: number;
  CASE_MATCH_CANDIDATE_LIMIT: number;
  CASE_MATCH_PENDING_TTL_MINUTES: number;
  DATABASE_URL?: string;
  DATABASE_SSL: boolean;
  LINE_CHANNEL_SECRET?: string;
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  TEAMS_WEBHOOK_URL?: string;
  TEAMS_ACTIONS_SECRET?: string;
  FORWARD_OUT_OF_SCOPE_TO_TEAMS: boolean;
  FRONTEND_BASE_URL: string;
};

const port = Number(Bun.env.PORT ?? 4000);
const aiCenterTemperature = Number(Bun.env.AI_CENTER_TEMPERATURE ?? 0.2);
const aiCenterMaxTokens = Number(Bun.env.AI_CENTER_MAX_TOKENS ?? 900);
const aiCenterTimeoutMs = Number(Bun.env.AI_CENTER_TIMEOUT_MS ?? 15000);
const caseMatchConfidenceThreshold = Number(Bun.env.CASE_MATCH_CONFIDENCE_THRESHOLD ?? 0.75);
const caseMatchCandidateLimit = Number(Bun.env.CASE_MATCH_CANDIDATE_LIMIT ?? 15);
const caseMatchPendingTtlMinutes = Number(Bun.env.CASE_MATCH_PENDING_TTL_MINUTES ?? 20);
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

if (!Number.isFinite(caseMatchConfidenceThreshold) || caseMatchConfidenceThreshold < 0 || caseMatchConfidenceThreshold > 1) {
  throw new Error("CASE_MATCH_CONFIDENCE_THRESHOLD must be a number between 0 and 1");
}

if (!Number.isInteger(caseMatchCandidateLimit) || caseMatchCandidateLimit < 1 || caseMatchCandidateLimit > 20) {
  throw new Error("CASE_MATCH_CANDIDATE_LIMIT must be an integer between 1 and 20");
}

if (!Number.isInteger(caseMatchPendingTtlMinutes) || caseMatchPendingTtlMinutes < 1 || caseMatchPendingTtlMinutes > 60) {
  throw new Error("CASE_MATCH_PENDING_TTL_MINUTES must be an integer between 1 and 60");
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
  CASE_MATCH_CONFIDENCE_THRESHOLD: caseMatchConfidenceThreshold,
  CASE_MATCH_CANDIDATE_LIMIT: caseMatchCandidateLimit,
  CASE_MATCH_PENDING_TTL_MINUTES: caseMatchPendingTtlMinutes,
  DATABASE_URL: Bun.env.DATABASE_URL,
  DATABASE_SSL: databaseSsl,
  LINE_CHANNEL_SECRET: Bun.env.LINE_CHANNEL_SECRET,
  LINE_CHANNEL_ACCESS_TOKEN: Bun.env.LINE_CHANNEL_ACCESS_TOKEN,
  TEAMS_WEBHOOK_URL: Bun.env.TEAMS_WEBHOOK_URL,
  TEAMS_ACTIONS_SECRET: Bun.env.TEAMS_ACTIONS_SECRET,
  FORWARD_OUT_OF_SCOPE_TO_TEAMS: Bun.env.FORWARD_OUT_OF_SCOPE_TO_TEAMS === "true",
  FRONTEND_BASE_URL: Bun.env.FRONTEND_BASE_URL ?? "https://offml.develyst.online",
};
