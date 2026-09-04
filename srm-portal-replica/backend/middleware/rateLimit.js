/**
 * Minimal fixed-window rate limiter — no new npm dependency, so the rest of
 * the fixes stay drop-in.
 *
 * /api/login had no throttle at all, which meant this server would happily
 * relay an unlimited password-guessing run at the real SRM portal on behalf
 * of whoever pointed a script at it.
 *
 * For anything beyond a single instance, swap this for `express-rate-limit`
 * with a shared Redis store — a per-process Map resets on restart and does
 * not coordinate across workers.
 */
const buckets = new Map()

const MAX_TRACKED_KEYS = 10000

export const rateLimit = ({ windowMs = 60_000, max = 10, message = 'Too many requests, please slow down' } = {}) => {
  return (req, res, next) => {
    // Trust the proxy-provided client IP only because nginx sets it; if you
    // expose Node directly, drop the header and use req.ip alone.
    const key = req.ip || req.socket?.remoteAddress || 'unknown'
    const now = Date.now()

    let bucket = buckets.get(key)

    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs }

      if (buckets.size >= MAX_TRACKED_KEYS) {
        for (const [k, b] of buckets) {
          if (now > b.resetAt) buckets.delete(k)
        }
        if (buckets.size >= MAX_TRACKED_KEYS) buckets.clear()
      }

      buckets.set(key, bucket)
    }

    bucket.count += 1

    const remaining = Math.max(0, max - bucket.count)
    res.set('RateLimit-Limit', String(max))
    res.set('RateLimit-Remaining', String(remaining))
    res.set('RateLimit-Reset', String(Math.ceil((bucket.resetAt - now) / 1000)))

    if (bucket.count > max) {
      res.set('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)))
      return res.status(429).json({ message })
    }

    next()
  }
}

const sweep = setInterval(() => {
  const now = Date.now()
  for (const [key, bucket] of buckets) {
    if (now > bucket.resetAt) buckets.delete(key)
  }
}, 60_000)

sweep.unref?.()
