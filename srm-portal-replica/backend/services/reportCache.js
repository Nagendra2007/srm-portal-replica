const cache = new Map()

const TTL_MS = 15 * 60 * 1000

// FIX: the cache was unbounded. Profile entries hold whole scraped HTML
// reports, so on a 768 MB heap a few hundred students was enough to hurt.
const MAX_ENTRIES = 300

const keyFor = (registrationNumber, reportType) => `${registrationNumber}:${reportType}`

export const getCachedReport = (registrationNumber, reportType) => {
  const key = keyFor(registrationNumber, reportType)
  const entry = cache.get(key)

  if (!entry) return null

  if (Date.now() - entry.fetchedAt > TTL_MS) {
    cache.delete(key)
    return null
  }

  // Refresh insertion order so genuinely hot entries survive eviction.
  cache.delete(key)
  cache.set(key, entry)

  return entry.value
}

export const saveReportCache = (registrationNumber, reportType, value) => {
  const key = keyFor(registrationNumber, reportType)

  if (!cache.has(key) && cache.size >= MAX_ENTRIES) {
    // Map preserves insertion order, so the first key is the coldest.
    const coldest = cache.keys().next().value
    if (coldest !== undefined) cache.delete(coldest)
  }

  cache.set(key, { value, fetchedAt: Date.now() })
}

export const clearReportCache = (registrationNumber) => {
  if (!registrationNumber) return
  const prefix = `${registrationNumber}:`
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
}

const sweep = setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of cache) {
    if (now - entry.fetchedAt > TTL_MS) cache.delete(key)
  }
}, 5 * 60 * 1000)

sweep.unref?.()
