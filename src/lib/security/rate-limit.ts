type Bucket = {
  resetAt: number;
  remaining: number;
};

const buckets = new Map<string, Bucket>();

export function rateLimit({
  key,
  limit,
  windowMs,
}: {
  key: string;
  limit: number;
  windowMs: number;
}) {
  const now = Date.now();
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    const b: Bucket = { resetAt: now + windowMs, remaining: limit - 1 };
    buckets.set(key, b);
    return { ok: true, remaining: b.remaining, resetAt: b.resetAt };
  }

  if (existing.remaining <= 0) {
    return { ok: false, remaining: 0, resetAt: existing.resetAt };
  }

  existing.remaining -= 1;
  return { ok: true, remaining: existing.remaining, resetAt: existing.resetAt };
}

