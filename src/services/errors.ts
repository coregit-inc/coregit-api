/**
 * Structured error response helpers.
 *
 * Every error response includes:
 *   { error: "Human-readable message", code: "MACHINE_CODE" }
 */

import type { Context } from "hono";

export type ErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "QUOTA_EXCEEDED"
  | "PAYLOAD_TOO_LARGE"
  | "UNPROCESSABLE"
  | "INTERNAL_ERROR"
  | "TIMEOUT";

export function errorResponse(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 413 | 500 | 504,
  code: ErrorCode,
  message: string
) {
  return c.json({ error: message, code }, status);
}
