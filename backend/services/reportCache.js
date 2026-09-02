const cache = new Map()

const TTL_MS = 15 * 60 * 1000

const keyFor = (registrationNumber, reportType) => `${registrationNumber}:${reportType}`

export const getCachedReport = (registrationNumber, reportType) => {
  const key = keyFor(registrationNumber, reportType)
  const entry = cache.get(key)

  if (!entry) {
    return null
  }

  const age = Date.now() - entry.fetchedAt

  if (age > TTL_MS) {
    cache.delete(key)
    return null
  }

  return entry.value
}

export const saveReportCache = (registrationNumber, reportType, value) => {
  cache.set(keyFor(registrationNumber, reportType), {
    value,
    fetchedAt: Date.now()
  })
}

export const clearReportCache = (registrationNumber) => {
  if (!registrationNumber) return
  const prefix = `${registrationNumber}:`
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key)
    }
  }
}
