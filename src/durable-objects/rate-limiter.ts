/**
 * Durable Object rate limiter.
 *
 * Globally consistent sliding-window rate limiting.
 * Each DO instance handles one rate-limit key (API key, org, or IP).
 *
 * Why DO instead of in-memory Map:
 * CF Workers runs many isolates — in-memory Maps are per-isolate,
 * so rate limits were NOT enforced across isolates. DOs guarantee
 * a single instance per name worldwide.
 *
 * Latency: <1ms warm, 20-50ms cold start.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const CLEANUP_ALARM_MS = HOUR_MS; // self-destruct after 1 hour idle

interface RateLimitConfig {
  perMinute: number;
  perHour: number;
}

const CONFIGS: Record<string, RateLimitConfig> = {
  key: { perMinute: 600, perHour: 15_000 },
  org: { perMinute: 2_000, perHour: 50_000 },
  ip: { perMinute: 1_000, perHour: 25_000 },
};

interface CheckResult {
  allowed: boolean;
  minuteUsed: number;
  hourUsed: number;
  retryAfterSec: number;
  limit: number;
  remaining: number;
}

export class RateLimiterDO implements DurableObject {
  private timestamps: number[] = [];
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const type = url.searchParams.get("type") || "key"; // "key" | "org" | "ip"
    const config = CONFIGS[type] || CONFIGS.key;

    const now = Date.now();

    // Prune timestamps older than 1 hour
    const hourCutoff = now - HOUR_MS;
    while (this.timestamps.length > 0 && this.timestamps[0] < hourCutoff) {
      this.timestamps.shift();
    }

    // Count requests in last minute
    const minuteCutoff = now - MINUTE_MS;
    let minuteUsed = 0;
    for (let i = this.timestamps.length - 1; i >= 0; i--) {
      if (this.timestamps[i] >= minuteCutoff) {
        minuteUsed++;
      } else {
        break;
      }
    }

    const hourUsed = this.timestamps.length;

    // Check per-minute limit
    if (minuteUsed >= config.perMinute) {
      const retryAfterSec = Math.ceil(
        (this.timestamps[this.timestamps.length - minuteUsed] + MINUTE_MS - now) / 1000
      );
      const result: CheckResult = {
        allowed: false,
        minuteUsed,
        hourUsed,
        retryAfterSec: Math.max(1, retryAfterSec),
        limit: config.perMinute,
        remaining: 0,
      };
      return Response.json(result);
    }

    // Check per-hour limit
    if (hourUsed >= config.perHour) {
      const retryAfterSec = Math.ceil(
        (this.timestamps[0] + HOUR_MS - now) / 1000
      );
      const result: CheckResult = {
        allowed: false,
        minuteUsed,
        hourUsed,
        retryAfterSec: Math.max(1, retryAfterSec),
        limit: config.perMinute,
        remaining: 0,
      };
      return Response.json(result);
    }

    // Record this request
    this.timestamps.push(now);

    // Schedule alarm for self-cleanup after idle period
    this.state.storage.setAlarm(now + CLEANUP_ALARM_MS);

    const result: CheckResult = {
      allowed: true,
      minuteUsed: minuteUsed + 1,
      hourUsed: hourUsed + 1,
      retryAfterSec: 0,
      limit: config.perMinute,
      remaining: Math.max(0, config.perMinute - minuteUsed - 1),
    };
    return Response.json(result);
  }

  async alarm(): Promise<void> {
    // Clear timestamps — DO will be evicted from memory after inactivity
    this.timestamps = [];
  }
}
