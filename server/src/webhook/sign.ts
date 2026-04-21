import { createHmac } from "node:crypto";

export function signPayload(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}
