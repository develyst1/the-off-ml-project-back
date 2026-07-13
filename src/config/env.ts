type Env = {
  NODE_ENV: string;
  PORT: number;
  AI_CENTER_BASE_URL?: string;
  AI_CENTER_API_KEY?: string;
  LINE_CHANNEL_SECRET?: string;
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  TEAMS_WEBHOOK_URL?: string;
};

const port = Number(Bun.env.PORT ?? 4000);

if (!Number.isInteger(port) || port <= 0) {
  throw new Error("PORT must be a positive integer");
}

export const env: Env = {
  NODE_ENV: Bun.env.NODE_ENV ?? "development",
  PORT: port,
  AI_CENTER_BASE_URL: Bun.env.AI_CENTER_BASE_URL,
  AI_CENTER_API_KEY: Bun.env.AI_CENTER_API_KEY,
  LINE_CHANNEL_SECRET: Bun.env.LINE_CHANNEL_SECRET,
  LINE_CHANNEL_ACCESS_TOKEN: Bun.env.LINE_CHANNEL_ACCESS_TOKEN,
  TEAMS_WEBHOOK_URL: Bun.env.TEAMS_WEBHOOK_URL,
};
