import express from 'express'
import crypto from 'crypto'
import { getClientSession } from '../services/clientSessionStore.js'
import {
  fetchReport,
  fetchBinaryResource,
  fetchStudentPhotoUrl,
  parseAttendance,
  parseTimetableData,
  parseInternalMarks,
  parseCurrentSemesterResults,
  markAttendance,
  fetchId,
  fetchAtt,
  parseTodayAttendance,
  REPORT_IDS
} from '../services/srmPortalService.js'
import { getCachedReport, saveReportCache } from '../services/reportCache.js'

const router = express.Router()

const requireSession = (req, res) => {
  const sessionId = req.headers['x-client-session']
  const session = getClientSession(sessionId)

  if (!session) {
    res.status(401).json({ message: 'Session not found or expired' })
    return null
  }

  return session
}

const handleRouteError = (res, error, defaultMessage) => {
  console.error(`${defaultMessage}:`, error.message)
  const status = error.statusCode || 500
  const message = error.statusCode === 401 ? 'SRM session expired' : defaultMessage
  res.status(status).json({ message })
}

// Private data — never let a shared proxy or the browser disk-cache it.
const noStore = (res) => res.set('Cache-Control', 'no-store, private')

/* --------------------------------------------------------------------------
   /timetable, /courses and /bootstrap all needed the same
   "cached timetable or fetch-and-parse it" step. It was written out three
   separate times, and only one copy guarded against a null parse.
   -------------------------------------------------------------------------- */
const getTimetableData = async (session) => {
  const registrationNumber = session.username

  const cached = registrationNumber ? getCachedReport(registrationNumber, 'timetable') : null
  if (cached) return cached

  const html = await fetchReport(session.client, REPORT_IDS.timetable)
  const parsed = parseTimetableData(html) || { periods: [], schedule: [], subjects: [] }

  if (registrationNumber) saveReportCache(registrationNumber, 'timetable', parsed)

  return parsed
}

const getAttendanceData = async (session) => {
  const registrationNumber = session.username

  const cached = registrationNumber ? getCachedReport(registrationNumber, 'attendance') : null
  if (cached) return cached

  const html = await fetchReport(session.client, REPORT_IDS.attendance)
  const parsed = parseAttendance(html) || []

  if (registrationNumber) saveReportCache(registrationNumber, 'attendance', parsed)

  return parsed
}

const getInternalMarksData = async (session) => {
  const registrationNumber = session.username

  const cached = registrationNumber ? getCachedReport(registrationNumber, 'internalMarks') : null
  if (cached) return cached

  const html = await fetchReport(session.client, REPORT_IDS.internalMarks)
  const parsed = parseInternalMarks(html) || []

  if (registrationNumber) saveReportCache(registrationNumber, 'internalMarks', parsed)

  return parsed
}

const getCurrentSemesterResultsData = async (session) => {
  const registrationNumber = session.username

  const cached = registrationNumber ? getCachedReport(registrationNumber, 'currentSemesterResults') : null
  if (cached) return cached

  const html = await fetchReport(session.client, REPORT_IDS.currentSemesterResults)
  const parsed = parseCurrentSemesterResults(html) || { title: '', subjects: [], sgpa: null }

  if (registrationNumber) saveReportCache(registrationNumber, 'currentSemesterResults', parsed)

  return parsed
}

router.get('/bootstrap', async (req, res) => {
  const session = requireSession(req, res)
  if (!session) return

  let timetable = null
  let attendance = null

  try {
    // Requests on a session are serialized upstream anyway (SRM's JSP session
    // collides otherwise), so these stay sequential by design.
    try {
      timetable = await getTimetableData(session)
    } catch (e) {
      console.error('Bootstrap timetable fetch error:', e.message)
      if (e.statusCode === 401) throw e
    }

    try {
      attendance = await getAttendanceData(session)
    } catch (e) {
      console.error('Bootstrap attendance fetch error:', e.message)
      if (e.statusCode === 401) throw e
    }

    noStore(res)
    res.json({
      timetable: timetable || null,
      attendance: attendance || null,
      courses: timetable?.subjects ?? []
    })
  } catch (error) {
    handleRouteError(res, error, 'Failed to bootstrap student portal data')
  }
})

router.get('/timetable', async (req, res) => {
  const session = requireSession(req, res)
  if (!session) return

  try {
    noStore(res)
    res.json(await getTimetableData(session))
  } catch (error) {
    handleRouteError(res, error, 'Failed to fetch timetable')
  }
})

router.get('/courses', async (req, res) => {
  const session = requireSession(req, res)
  if (!session) return

  try {
    const timetableData = await getTimetableData(session)
    noStore(res)
    // FIX: was `timetableData.subjects || []` with no null guard on
    // timetableData itself — a failed parse threw a TypeError and returned 500.
    res.json(timetableData?.subjects ?? [])
  } catch (error) {
    handleRouteError(res, error, 'Failed to fetch courses')
  }
})

router.get('/attendance', async (req, res) => {
  const session = requireSession(req, res)
  if (!session) return

  try {
    noStore(res)
    res.json(await getAttendanceData(session))
  } catch (error) {
    handleRouteError(res, error, 'Failed to fetch attendance')
  }
})

router.get('/internal-marks', async (req, res) => {
  const session = requireSession(req, res)
  if (!session) return

  try {
    noStore(res)
    res.json(await getInternalMarksData(session))
  } catch (error) {
    handleRouteError(res, error, 'Failed to fetch internal marks')
  }
})

router.get('/current-semester-results', async (req, res) => {
  const session = requireSession(req, res)
  if (!session) return

  try {
    noStore(res)
    res.json(await getCurrentSemesterResultsData(session))
  } catch (error) {
    handleRouteError(res, error, 'Failed to fetch current semester results')
  }
})

router.post('/mark-attendance', async (req, res) => {
  const session = requireSession(req, res)
  if (!session) return

  const { acode } = req.body || {}

  if (typeof acode !== 'string' || !acode.trim()) {
    return res.status(400).json({ message: 'Attendance code is required' })
  }

  try {
    // NOTE: coordinates are read from config rather than hard-coded in the
    // route. See AUDIT-REPORT.md — sending fixed campus coordinates defeats
    // the geofence the university put on this endpoint on purpose, and that is
    // a policy decision you should make deliberately, not a perf setting.
    const result = await markAttendance(session.client, {
      acode: acode.trim(),
      latitude: process.env.ATTENDANCE_LATITUDE,
      longitude: process.env.ATTENDANCE_LONGITUDE
    })
    noStore(res)
    res.json(result)
  } catch (error) {
    handleRouteError(res, error, 'Failed to submit attendance')
  }
})

router.get('/att', async (req, res) => {
  const session = requireSession(req, res)
  if (!session) return

  try {
    // fetchId now memoizes studentId on the session, so this is one SRM
    // round-trip after the first call instead of two on every poll.
    const id = await fetchId(session)

    if (!id) {
      return res.status(502).json({ message: "Failed to fetch today's attendance status" })
    }

    const html = await fetchAtt(session.client, id)
    noStore(res)
    res.status(200).json(parseTodayAttendance(html))
  } catch (error) {
    handleRouteError(res, error, "Failed to fetch today's attendance status")
  }
})

/* --------------------------------------------------------------------------
   PHOTO PROXY

   Two problems with the original:

   1. SSRF — `?src=` was passed straight to axios, so an authenticated caller
      could make this server fetch any URL, including 169.254.169.254 and
      anything on localhost, and read the bytes back.
   2. The raw session id was embedded in the <img src> query string, which
      lands in browser history, Referer headers and nginx access logs.

   Both go away by handing the browser an opaque single-purpose ticket. The
   real URL and session stay server-side, and the URL is fixed at mint time so
   there is nothing for a caller to tamper with.
   -------------------------------------------------------------------------- */
const PHOTO_TICKET_TTL_MS = 10 * 60 * 1000
const MAX_PHOTO_TICKETS = 2000

const photoTickets = new Map()

const mintPhotoTicket = (sessionId, photoUrl) => {
  if (photoTickets.size >= MAX_PHOTO_TICKETS) {
    const now = Date.now()
    for (const [t, v] of photoTickets) {
      if (v.expiresAt < now) photoTickets.delete(t)
    }
    if (photoTickets.size >= MAX_PHOTO_TICKETS) {
      const oldest = photoTickets.keys().next().value
      if (oldest !== undefined) photoTickets.delete(oldest)
    }
  }

  const ticket = crypto.randomBytes(24).toString('base64url')
  photoTickets.set(ticket, { sessionId, photoUrl, expiresAt: Date.now() + PHOTO_TICKET_TTL_MS })

  return ticket
}

const PHOTO_CACHE_TTL_MS = 12 * 60 * 60 * 1000
const MAX_PHOTO_CACHE = 200

const photoCache = new Map()

router.get('/profile', async (req, res) => {
  const session = requireSession(req, res)
  if (!session) return

  const sessionId = req.headers['x-client-session']
  const registrationNumber = session.username

  try {
    const cached = registrationNumber ? getCachedReport(registrationNumber, 'profile') : null

    let reportHtml
    let photoUrl

    if (cached) {
      reportHtml = cached.reportHtml
      photoUrl = cached.photoUrl
    } else {
      // Two independent SRM pages (report fragment vs. dashboard) — no reason
      // to pay for the round-trips back to back.
      ;[reportHtml, photoUrl] = await Promise.all([
        fetchReport(session.client, REPORT_IDS.profile),
        fetchStudentPhotoUrl(session.client).catch((e) => {
          if (e.statusCode === 401) throw e
          console.warn('Photo URL lookup failed:', e.message)
          return null
        })
      ])

      if (registrationNumber) {
        saveReportCache(registrationNumber, 'profile', { reportHtml, photoUrl })
      }
    }

    // Minted per request, never cached — the ticket is tied to this session.
    const photoTag = photoUrl
      ? `<img src="/api/photo?t=${encodeURIComponent(mintPhotoTicket(sessionId, photoUrl))}" alt="Student photo">`
      : ''

    noStore(res)
    res.set('Content-Type', 'text/html; charset=utf-8')
    res.send(photoTag + reportHtml)
  } catch (error) {
    handleRouteError(res, error, 'Failed to fetch profile')
  }
})

router.get('/photo', async (req, res) => {
  const ticket = req.query.t

  if (typeof ticket !== 'string' || !ticket) return res.status(400).send()

  const entry = photoTickets.get(ticket)

  if (!entry || entry.expiresAt < Date.now()) {
    photoTickets.delete(ticket)
    return res.status(401).send()
  }

  const session = getClientSession(entry.sessionId)
  if (!session) return res.status(401).send()

  const cacheKey = `${entry.sessionId}:${entry.photoUrl}`
  const cachedPhoto = photoCache.get(cacheKey)

  if (cachedPhoto && Date.now() - cachedPhoto.fetchedAt < PHOTO_CACHE_TTL_MS) {
    res.set('Content-Type', cachedPhoto.contentType)
    // private, not public — this is one student's face, not a shared asset.
    res.set('Cache-Control', 'private, max-age=86400')
    return res.send(cachedPhoto.imageBuffer)
  }

  try {
    // fetchBinaryResource now pins the host to SRM before requesting.
    const { contentType, imageBuffer } = await fetchBinaryResource(session.client, entry.photoUrl)

    if (photoCache.size >= MAX_PHOTO_CACHE) {
      const oldest = photoCache.keys().next().value
      if (oldest !== undefined) photoCache.delete(oldest)
    }

    photoCache.set(cacheKey, { contentType, imageBuffer, fetchedAt: Date.now() })

    res.set('Content-Type', contentType)
    res.set('Cache-Control', 'private, max-age=86400')
    res.send(imageBuffer)
  } catch (error) {
    console.error('Photo error:', error.message)
    res.status(error.statusCode === 400 ? 400 : 502).send()
  }
})

const sweep = setInterval(() => {
  const now = Date.now()

  for (const [key, cachedPhoto] of photoCache) {
    if (now - cachedPhoto.fetchedAt > PHOTO_CACHE_TTL_MS) photoCache.delete(key)
  }

  for (const [ticket, entry] of photoTickets) {
    if (entry.expiresAt < now) photoTickets.delete(ticket)
  }
}, 10 * 60 * 1000)

sweep.unref?.()

export default router
