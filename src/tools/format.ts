import { RESPONSE_CHARACTER_LIMIT } from "../constants.js";
import type { ToolResponse } from "../types.js";

export function makeToolResponse<T extends Record<string, unknown>>(
  data: T,
  text?: string,
  isError = false
): ToolResponse<T> {
  const raw = text ?? JSON.stringify(data, null, 2);
  const responseText =
    raw.length > RESPONSE_CHARACTER_LIMIT
      ? `${raw.slice(0, RESPONSE_CHARACTER_LIMIT)}\n\nResponse truncated at ${RESPONSE_CHARACTER_LIMIT} characters. Use filters or a narrower date range.`
      : raw;

  return {
    content: [{ type: "text", text: responseText }],
    structuredContent: data,
    ...(isError ? { isError: true } : {})
  };
}

export function errorResponse(message: string): ToolResponse<{ error: string }> {
  return makeToolResponse({ error: message }, message, true);
}

/**
 * Actual stores all amounts as integers in minor units (cents): $123.45 is
 * 12345. Tools accept and report major units and convert at the boundary.
 */
export function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}

export function toMajorUnits(amount: number): number {
  return amount / 100;
}
