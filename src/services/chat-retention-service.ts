import { store } from "../repositories/store";

const RETENTION_DAYS = 14;
const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 1000;

function cutoffForNow(now: Date) {
  return new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

export const chatRetentionService = {
  async deleteExpiredRawMessages(input: { dryRun?: boolean; batchSize?: number; now?: Date } = {}) {
    const now = input.now ?? new Date();
    const batchSize = Math.min(Math.max(Math.trunc(input.batchSize ?? DEFAULT_BATCH_SIZE), 1), MAX_BATCH_SIZE);
    const dryRun = input.dryRun === true;
    const cutoffAt = cutoffForNow(now);

    console.info({ event: "chat_retention_started", dryRun, batchSize, cutoffAt: cutoffAt.toISOString() });
    try {
      const result = await store.deleteExpiredRawMessages({ cutoffAt, batchSize, dryRun });
      console.info({ event: "chat_retention_completed", ...result });
      return result;
    } catch (error) {
      console.error({ event: "chat_retention_failed", dryRun, batchSize, cutoffAt: cutoffAt.toISOString(), message: String(error) });
      throw error;
    }
  },
};

export const CHAT_RETENTION_DAYS = RETENTION_DAYS;
