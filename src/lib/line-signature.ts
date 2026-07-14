import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyLineSignature(input: {
  rawBody: string;
  signature: string | undefined;
  channelSecret: string;
}): boolean {
  if (!input.signature) {
    return false;
  }

  const expectedSignature = createHmac("sha256", input.channelSecret)
    .update(input.rawBody)
    .digest("base64");

  const receivedBuffer = Buffer.from(input.signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(receivedBuffer, expectedBuffer);
}
