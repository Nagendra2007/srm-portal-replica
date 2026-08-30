// In-memory cache — no MongoDB needed. Trade-off: this resets to
// empty every time the server restarts, unlike a real database.
// For a mini project running on one machine, that's a fine cost for
// the simplicity gained.
const cache = new Map()

// How long a cached report stays "fresh" before we bother SRM again.
const TTL_MS = 15 * 60 * 1000

const keyFor = (registrationNumber, reportType) => `${registrationNumber}:${reportType}`

// Generic now — stores whatever value you give it (a plain HTML
// string for timetable, or an object like { reportHtml, photoUrl }
// for profile). This matters because profile data includes a
// session-specific photo URL that must never be cached "baked in" —
// see /routes/portal.js for why.
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