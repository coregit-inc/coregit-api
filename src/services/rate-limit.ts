/**
 * Rate limiting via Durable Objects.
 *
 * Each rate-limit key (API key ID, org ID, IP) maps to a single DO instance
 * worldwide. The DO holds the sliding window in memory — globally consistent.
 *
 * Fail-open: if the DO is unreachable, the request is allowed and logged.
 */

export interface RateLimitResult {
  allowed: boolean;
  minuteUsed: number;
  hourUsed: number;
  retryAfterSec: number;
  limit: number;
  remaining: number;
}

const FALLBACK_ALLOWED: RateLimitResult = {
  allowed: true,
  minuteUsed: 0,
  hourUsed: 0,
  retryAfterSec: 0,
  limit: 600,
  remaining: 600,
};

async function checkDO(
  rateLimiter: DurableObjectNamespace,
  name: string,
  type: "key" | "org" | "ip"
): Promise<RateLimitResult> {
  try {
    const id = rateLimiter.idFromName(name);
    const stub = rateLimiter.get(id);
    const res = await stub.fetch(`https://rate-limiter/?type=${type}`);
    return (await res.json()) as RateLimitResult;
  } catch (err) {
    // Fail-open: allow request if DO is unreachable
    console.error(`Rate limiter DO unreachable for ${type}:${name}:`, err);
    return FALLBACK_ALLOWED;
  }
}

/**
 * Check per-key rate limit (600/min, 15K/hr).
 */
export async function checkRateLimit(
  rateLimiter: DurableObjectNamespace,
  keyId: string
): Promise<RateLimitResult> {
  return checkDO(rateLimiter, `key:${keyId}`, "key");
}

/**
 * Check per-org rate limit (2000/min, 50K/hr).
 */
export async function checkOrgRateLimit(
  rateLimiter: DurableObjectNamespace,
  orgId: string
): Promise<RateLimitResult> {
  return checkDO(rateLimiter, `org:${orgId}`, "org");
}

/**
 * Check per-IP rate limit (1000/min, 25K/hr).
 */
export async function checkIpRateLimit(
  rateLimiter: DurableObjectNamespace,
  ip: string
): Promise<RateLimitResult> {
  return checkDO(rateLimiter, `ip:${ip}`, "ip");
}

/** Rate limit headers for per-key responses */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.ceil(Date.now() / 1000) + 60),
  };
  if (!result.allowed) {
    headers["Retry-After"] = String(Math.max(1, result.retryAfterSec));
  }
  return headers;
}

/** Rate limit headers for per-org responses */
export function orgRateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Org-RateLimit-Limit": String(result.limit),
    "X-Org-RateLimit-Remaining": String(result.remaining),
  };
  if (!result.allowed) {
    headers["Retry-After"] = String(Math.max(1, result.retryAfterSec));
  }
  return headers;
}

/** Rate limit headers for per-IP responses */
export function ipRateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.ceil(Date.now() / 1000) + 60),
  };
  if (!result.allowed) {
    headers["Retry-After"] = String(Math.max(1, result.retryAfterSec));
  }
  return headers;
}
