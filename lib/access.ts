import { timingSafeEqual } from "node:crypto";
import { config } from "./config";

/**
 * Constant-time check of the optional shared access code. When no code is
 * configured the app stays open.
 */
export function isValidAccessCode(
  provided: string | null | undefined,
): boolean {
  if (!config.accessCode) return true;
  if (!provided) return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(config.accessCode);
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(providedBuffer, expectedBuffer);
}
