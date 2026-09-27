/** Technical rate limit — separate from commercial credit balance (see AI_RATE_LIMIT_SPEC.md). */

export interface AiRateLimitScope {
  installationId: string;
  licenseId?: string | null;
  functionName: string;
  ipFingerprint?: string | null;
}

export interface AiRateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
}

export interface AiRateLimitWindowConfig {
  maxRequests: number;
  windowSeconds: number;
}

const DEFAULT_WINDOW: AiRateLimitWindowConfig = {
  maxRequests: 30,
  windowSeconds: 60,
};

type WindowKey = string;

function scopeKey(scope: AiRateLimitScope): WindowKey {
  const ip = scope.ipFingerprint ?? 'no-ip';
  const license = scope.licenseId ?? 'no-license';
  return `${scope.functionName}:${scope.installationId}:${license}:${ip}`;
}

/**
 * In-memory sliding window for local Phase 3C tests.
 * Production: `edge_ai_rate_windows` + RPC `acquire_ai_rate_limit` (SQL draft).
 */
export class InMemoryAiRateLimiter {
  private hits = new Map<WindowKey, number[]>();

  constructor(private config: AiRateLimitWindowConfig = DEFAULT_WINDOW) {}

  acquire(scope: AiRateLimitScope, nowMs = Date.now()): AiRateLimitResult {
    const key = scopeKey(scope);
    const windowMs = this.config.windowSeconds * 1000;
    const cutoff = nowMs - windowMs;
    const existing = (this.hits.get(key) ?? []).filter((t) => t > cutoff);

    if (existing.length >= this.config.maxRequests) {
      const oldest = existing[0] ?? nowMs;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((oldest + windowMs - nowMs) / 1000)
      );
      return {
        allowed: false,
        retryAfterSeconds,
        remaining: 0,
      };
    }

    existing.push(nowMs);
    this.hits.set(key, existing);
    return {
      allowed: true,
      retryAfterSeconds: 0,
      remaining: this.config.maxRequests - existing.length,
    };
  }

  reset(): void {
    this.hits.clear();
  }
}

let sharedLimiter: InMemoryAiRateLimiter | null = null;

export function getSharedAiRateLimiter(): InMemoryAiRateLimiter {
  if (!sharedLimiter) sharedLimiter = new InMemoryAiRateLimiter();
  return sharedLimiter;
}

export function resetSharedAiRateLimiter(): void {
  sharedLimiter = null;
}
