/**
 * In-memory sliding-window rate limiter.
 *
 * Limits per API key (keyHash):
 *   - 600 requests per minute  (burst)
 *   - 15,000 requests per hour  (sustained)
 *
 * Generous limits — CoreGit targets AI agent workloads with high request volume.
 *
 * Module-scoped — state persists across requests within the same Worker isolate.
 * Evicts stale entries every 500 checks to prevent unbounded growth.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Requests used in the current minute window */
  minuteUsed: number;
  /** Requests used in the current hour window */
  hourUsed: number;
  /** Seconds until the minute window resets */
  retryAfterSec: number;
}

interface KeyWindow {
  /** Timestamps of requests within the last hour (ms) */
  timestamps: number[];
}

const PER_MINUTE = 600;
const PER_HOUR = 15_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** Module-scoped store: keyHash → sliding window */
const windows = new Map<string, KeyWindow>();
let checkCount = 0;

/**
 * Check and record a request against the rate limiter.
 *
 * @param keyId - Unique identifier for the key (keyHash or tokenId)
 * @returns Whether the request is allowed + usage info
 */
export function checkRateLimit(keyId: string): RateLimitResult {
  const now = Date.now();

  // Periodic eviction: every 500 checks, purge keys with no recent activity
  checkCount++;
  if (checkCount >= 500) {
    checkCount = 0;
    evictStale(now);
  }

  let win = windows.get(keyId);
  if (!win) {
    win = { timestamps: [] };
    windows.set(keyId, win);
  }

  // Prune timestamps older than 1 hour
  const hourCutoff = now - HOUR_MS;
  while (win.timestamps.length > 0 && win.timestamps[0] < hourCutoff) {
    win.timestamps.shift();
  }

  // Count requests in last minute
  const minuteCutoff = now - MINUTE_MS;
  let minuteUsed = 0;
  for (let i = win.timestamps.length - 1; i >= 0; i--) {
    if (win.timestamps[i] >= minuteCutoff) {
      minuteUsed++;
    } else {
      break;
    }
  }

  const hourUsed = win.timestamps.length;

  // Check limits
  if (minuteUsed >= PER_MINUTE) {
    return {
      allowed: false,
      minuteUsed,
      hourUsed,
      retryAfterSec: Math.ceil((win.timestamps[win.timestamps.length - minuteUsed] + MINUTE_MS - now) / 1000),
    };
  }

  if (hourUsed >= PER_HOUR) {
    return {
      allowed: false,
      minuteUsed,
      hourUsed,
      retryAfterSec: Math.ceil((win.timestamps[0] + HOUR_MS - now) / 1000),
    };
  }

  // Record this request
  win.timestamps.push(now);

  return {
    allowed: true,
    minuteUsed: minuteUsed + 1,
    hourUsed: hourUsed + 1,
    retryAfterSec: 0,
  };
}

/** Remove keys that haven't had requests in over an hour */
function evictStale(now: number): void {
  const hourAgo = now - HOUR_MS;
  for (const [key, win] of windows) {
    if (win.timestamps.length === 0 || win.timestamps[win.timestamps.length - 1] < hourAgo) {
      windows.delete(key);
    }
  }
  // Hard cap: if still too many keys, drop oldest half
  if (windows.size > 10_000) {
    const keys = [...windows.keys()];
    for (let i = 0; i < keys.length / 2; i++) {
      windows.delete(keys[i]);
    }
  }
}

// ── Per-org rate limiting ──

const ORG_PER_MINUTE = 2000;
const ORG_PER_HOUR = 50_000;

const orgWindows = new Map<string, KeyWindow>();
let orgCheckCount = 0;

export function checkOrgRateLimit(orgId: string): RateLimitResult {
  const now = Date.now();

  orgCheckCount++;
  if (orgCheckCount >= 500) {
    orgCheckCount = 0;
    const hourAgo = now - HOUR_MS;
    for (const [key, win] of orgWindows) {
      if (win.timestamps.length === 0 || win.timestamps[win.timestamps.length - 1] < hourAgo) {
        orgWindows.delete(key);
      }
    }
    if (orgWindows.size > 5_000) {
      const keys = [...orgWindows.keys()];
      for (let i = 0; i < keys.length / 2; i++) {
        orgWindows.delete(keys[i]);
      }
    }
  }

  let win = orgWindows.get(orgId);
  if (!win) {
    win = { timestamps: [] };
    orgWindows.set(orgId, win);
  }

  const hourCutoff = now - HOUR_MS;
  while (win.timestamps.length > 0 && win.timestamps[0] < hourCutoff) {
    win.timestamps.shift();
  }

  const minuteCutoff = now - MINUTE_MS;
  let minuteUsed = 0;
  for (let i = win.timestamps.length - 1; i >= 0; i--) {
    if (win.timestamps[i] >= minuteCutoff) minuteUsed++;
    else break;
  }

  const hourUsed = win.timestamps.length;

  if (minuteUsed >= ORG_PER_MINUTE) {
    return {
      allowed: false, minuteUsed, hourUsed,
      retryAfterSec: Math.ceil((win.timestamps[win.timestamps.length - minuteUsed] + MINUTE_MS - now) / 1000),
    };
  }
  if (hourUsed >= ORG_PER_HOUR) {
    return {
      allowed: false, minuteUsed, hourUsed,
      retryAfterSec: Math.ceil((win.timestamps[0] + HOUR_MS - now) / 1000),
    };
  }

  win.timestamps.push(now);
  return { allowed: true, minuteUsed: minuteUsed + 1, hourUsed: hourUsed + 1, retryAfterSec: 0 };
}

export function orgRateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Org-RateLimit-Limit": String(ORG_PER_MINUTE),
    "X-Org-RateLimit-Remaining": String(Math.max(0, ORG_PER_MINUTE - result.minuteUsed)),
  };
  if (!result.allowed) {
    headers["Retry-After"] = String(Math.max(1, result.retryAfterSec));
  }
  return headers;
}

/** Rate limit headers for the response */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(PER_MINUTE),
    "X-RateLimit-Remaining": String(Math.max(0, PER_MINUTE - result.minuteUsed)),
    "X-RateLimit-Reset": String(Math.ceil(Date.now() / 1000) + 60),
  };
  if (!result.allowed) {
    headers["Retry-After"] = String(Math.max(1, result.retryAfterSec));
  }
  return headers;
}
