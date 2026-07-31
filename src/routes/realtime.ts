import { Hono } from "hono";
import { realtimeEventHub, type RealtimeEvent } from "../services/realtime-event-hub";

const encoder = new TextEncoder();

function toSseMessage(event: string, data: unknown, id?: string) {
  return `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export const realtimeRoutes = new Hono();

realtimeRoutes.get("/events", (c) => {
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (event: string, data: unknown, id?: string) => {
        try {
          controller.enqueue(encoder.encode(toSseMessage(event, data, id)));
        } catch {
          // The request abort handler below releases this subscriber.
        }
      };

      const listener = (event: RealtimeEvent) => write(event.name, event.data, event.data.eventId);
      unsubscribe = realtimeEventHub.subscribe(listener);
      heartbeat = setInterval(() => write("ping", { at: new Date().toISOString() }), 25_000);
      write("connected", { connectedAt: new Date().toISOString() });
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
    },
  });

  c.req.raw.signal.addEventListener("abort", () => {
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe?.();
  }, { once: true });

  return c.body(stream, 200, {
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream",
    "X-Accel-Buffering": "no",
  });
});
