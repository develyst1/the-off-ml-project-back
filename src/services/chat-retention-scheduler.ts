import { chatRetentionService } from "./chat-retention-service";

const BANGKOK_TIME_ZONE = "Asia/Bangkok";
let scheduledTimer: ReturnType<typeof setTimeout> | undefined;

function bangkokParts(now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BANGKOK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

export function millisecondsUntilNextBangkokCleanup(now = new Date()) {
  const { year, month, day } = bangkokParts(now);
  let target = Date.UTC(year, month - 1, day, 2 - 7, 0, 0, 0);
  if (target <= now.getTime()) target += 24 * 60 * 60 * 1000;
  return target - now.getTime();
}

export function startChatRetentionScheduler() {
  if (scheduledTimer) return;

  const scheduleNext = () => {
    const delay = millisecondsUntilNextBangkokCleanup();
    scheduledTimer = setTimeout(async () => {
      scheduledTimer = undefined;
      try {
        await chatRetentionService.deleteExpiredRawMessages({ dryRun: false });
      } finally {
        scheduleNext();
      }
    }, delay);
    console.info({ event: "chat_retention_scheduled", timeZone: BANGKOK_TIME_ZONE, runAt: "02:00", delayMs: delay });
  };

  scheduleNext();
}
