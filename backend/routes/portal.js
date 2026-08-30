import express from 'express'
import { getClientSession } from '../services/clientSessionStore.js'
import { fetchReport, fetchBinaryResource, fetchStudentPhotoUrl, parseAttendance, REPORT_IDS } from '../services/srmPortalService.js'
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
      reportHtml = await fetchReport(session.client, REPORT_IDS.profile)
      photoUrl = await fetchStudentPhotoUrl(session.client)

      if (registrationNumber) {
        saveReportCache(registrationNumber, 'profile', { reportHtml, photoUrl })
      }
    }

    // Rebuilt fresh every time, cached or not — this is the one part
    // that must never come from the cache, since it embeds THIS
    // request's sessionId, not whatever session existed when the
    // report was first fetched.
    const photoTag = photoUrl
      ? `<img src="/api/photo?src=${encodeURIComponent(photoUrl)}&session=${sessionId}">`
      : ''

    res.set('Content-Type', 'text/html')
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
    const cached = registrationNumber ? getCachedReport(registrationNumber, 'timetable') : null
    const html = cached || await fetchReport(session.client, REPORT_IDS.timetable)

    if (!cached && registrationNumber) {
      saveReportCache(registrationNumber, 'timetable', html)
    }

    res.set('Content-Type', 'text/html')
    res.send(html)
  } catch (error) {
    console.error('Timetable error:', error.message)
    res.status(500).json({ message: 'Failed to fetch timetable' })
  }
})

router.get('/attendance', async (req, res) => {
  const session = requireSession(req, res)
  if (!session) return

  const registrationNumber = session.username

  try {
    const cached = registrationNumber ? getCachedReport(registrationNumber, 'attendance') : null

    let subjects = cached

    if (!subjects) {
      const html = await fetchReport(session.client, REPORT_IDS.attendance)
      subjects = parseAttendance(html)

      if (registrationNumber) {
        saveReportCache(registrationNumber, 'attendance', subjects)
      }
    }

    res.json(subjects)
  } catch (error) {
    console.error('Attendance error:', error.message)
    res.status(500).json({ message: 'Failed to fetch attendance' })
  }
})

// Proxies the student's profile photo. Uses a query param for the
// session id, not a header, because <img src="..."> requests are
// made by the browser itself and can't attach custom headers.
router.get('/photo', async (req, res) => {
  const sessionId = req.query.session
  const session = getClientSession(sessionId)

  if (!session) {
    return res.status(401).send()
  }

  const photoUrl = req.query.src

  if (!photoUrl) {
    return res.status(400).send()
  }

  try {
    const { contentType, imageBuffer } = await fetchBinaryResource(session.client, photoUrl)
    res.set('Content-Type', contentType)
    res.send(imageBuffer)
  } catch (error) {
    console.error('Photo error:', error.message)
    res.status(500).send()
  }
})

export default router