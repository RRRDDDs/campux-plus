import type { FastifyRequest } from "fastify";

/**
 * 极简进程内限流（单实例部署足够用）。
 * 用于「申请开墙」注册接口：同一来源在一段时间内只允许尝试若干次，
 * 配合人机验证一起挡住脚本批量注册。
 */
type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

export function checkRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: Math.max(0, limit - 1), retryAfterSeconds: 0 };
  }
  if (existing.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }
  existing.count += 1;
  return { allowed: true, remaining: Math.max(0, limit - existing.count), retryAfterSeconds: 0 };
}

/** 清理过期桶，避免长时间运行后内存堆积。 */
export function pruneRateLimitBuckets() {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

/**
 * 取请求来源 IP。
 * 站点在 Cloudflare 后面，真实客户端 IP 由 CF 写在 cf-connecting-ip 里
 * （现在只有 CF 能回源，所以这个头可信）；没有时退回 X-Forwarded-For / request.ip。
 */
export function clientIpFromRequest(request: FastifyRequest) {
  const cfConnectingIp = request.headers["cf-connecting-ip"];
  const rawCf = Array.isArray(cfConnectingIp) ? cfConnectingIp[0] : cfConnectingIp;
  if (rawCf?.trim()) {
    return rawCf.trim();
  }
  const forwarded = request.headers["x-forwarded-for"];
  const rawForwarded = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const firstForwarded = rawForwarded?.split(",")[0]?.trim();
  if (firstForwarded) {
    return firstForwarded;
  }
  return request.ip ?? "unknown";
}
