import express from 'express'
import { getClientSession } from '../services/clientSessionStore.js'
import { fetchReport, fetchBinaryResource, fetchStudentPhotoUrl, REPORT_IDS } from '../services/srmPortalService.js'
import { getCachedReport, saveReportCache } from '../services/reportCache.js'

const router = express.Router()

// Every authenticated route needs the same "find session or 401"
// check — pulled out once here instead of repeated in every handler.
const requireSession = (req, res) => {
  const sessionId = req.headers['x-client-session']
  const session = getClientSession(sessionId)

  if (!session) {
    res.status(401).json({ message: 'Session not found or expired' })
    return null
  }

  return session
}

// The photo tag embeds the CURRENT session's id, never a cached one.
// Sessions are per-login (a fresh sessionId every time you log in),
// so a photo URL built during a previous login points at a session
// that may already be gone — building this fresh every time, even on
// a cache hit, is what fixes that.
// The src is relative (not http://localhost:5000/...) since the
// frontend and backend are served from the same origin now — this
// makes the tag work identically on localhost and once deployed.
const buildPhotoTag = (photoUrl, sessionId) => {
  if (!photoUrl) return ''
  return `<img src="/api/photo?src=${encodeURIComponent(photoUrl)}&session=${sessionId}">`
}

router.get('/profile', async (req, res) => {
  const session = requireSession(req, res)
  if (!session) return

  const sessionId = req.headers['x-client-session']
  const registrationNumber = session.username

  try {
    // Cache hit: skip SRM entirely for the report + photo URL — but
    // still rebuild the <img> tag using this request's own sessionId,
    // since the cached photoUrl is safe to reuse while a baked-in
    // <img> tag from a previous session would not be.
    if (registrationNumber) {
      const cached = getCachedReport(registrationNumber, 'profile')
      if (cached) {
        const photoTag = buildPhotoTag(cached.photoUrl, sessionId)
        res.set('Content-Type', 'text/html')
        res.set('X-Cache', 'HIT')
        return res.send(photoTag + cached.reportHtml)
      }
    }

    // Cache miss (or no username yet) — fetch fresh from SRM.
    // These two requests hit different SRM pages and don't depend on
    // each other's result, so running them in parallel roughly halves
    // the wait compared to doing them one after another.
    const [reportHtml, photoUrl] = await Promise.all([
      fetchReport(session.client, REPORT_IDS.profile),
      fetchStudentPhotoUrl(session.client)
    ])

    if (registrationNumber) {
      // Cache the raw pieces, not the rendered <img> tag — the tag
      // is rebuilt per-request above so it always matches whichever
      // session is asking.
      saveReportCache(registrationNumber, 'profile', { reportHtml, photoUrl })
    }

    const photoTag = buildPhotoTag(photoUrl, sessionId)

    res.set('Content-Type', 'text/html')
    res.set('X-Cache', 'MISS')
    res.send(photoTag + reportHtml)
  } catch (error) {
    console.error('Profile error:', error.message)
    res.status(500).json({ message: 'Failed to fetch profile' })
  }
})

router.get('/timetable', async (req, res) => {
  const session = requireSession(req, res)
  if (!session) return

  const registrationNumber = session.username

  try {
    if (registrationNumber) {
      const cachedHtml = getCachedReport(registrationNumber, 'timetable')
      if (cachedHtml) {
        res.set('Content-Type', 'text/html')
        res.set('X-Cache', 'HIT')
        return res.send(cachedHtml)
      }
    }

    const html = await fetchReport(session.client, REPORT_IDS.timetable)

    if (registrationNumber) {
      saveReportCache(registrationNumber, 'timetable', html)
    }

    res.set('Content-Type', 'text/html')
    res.set('X-Cache', 'MISS')
    res.send(html)
  } catch (error) {
    console.error('Timetable error:', error.message)
    res.status(500).json({ message: 'Failed to fetch timetable' })
  }
})

// Proxies the student's profile photo. Uses a query param for the
// session id, not a header, because <img src="..."> requests are
// made by the browser itself and can't attach custom headers.
router.get('/photo', async (req, res) => {
  const sessionId = req.query.session
  const session = getClientSession(sessionId)

  if (!session) {
    console.error('Photo error: no valid session for id', sessionId)
    return res.status(401).send()
  }

  const photoUrl = req.query.src

  if (!photoUrl) {
    console.error('Photo error: no src query param provided')
    return res.status(400).send()
  }

  try {
    const { contentType, imageBuffer } = await fetchBinaryResource(session.client, photoUrl)
    res.set('Content-Type', contentType)
    res.send(imageBuffer)
  } catch (error) {
    console.error('Photo error:', error.message, '| src was:', photoUrl)
    res.status(500).send()
  }
})

export default router