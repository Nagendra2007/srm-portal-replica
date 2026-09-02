import express from 'express'
import { getClientSession } from '../services/clientSessionStore.js'
import { fetchReport, fetchBinaryResource, fetchStudentPhotoUrl, parseAttendance, parseTimetableData, markAttendance, REPORT_IDS } from '../services/srmPortalService.js'
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

router.get('/bootstrap', async (req, res) => {
  const session = requireSession(req, res)
  if (!session) return

  const registrationNumber = session.username

  try {
    let timetable = registrationNumber ? getCachedReport(registrationNumber, 'timetable') : null
    let attendance = registrationNumber ? getCachedReport(registrationNumber, 'attendance') : null

    // Fetch sequentially using the serialized Axios client to avoid SRM portal JSP session collisions
    if (!timetable) {
      try {
        const html = await fetchReport(session.client, REPORT_IDS.timetable)
        timetable = parseTimetableData(html)
        if (registrationNumber && timetable) {
          saveReportCache(registrationNumber, 'timetable', timetable)
        }
      } catch (e) {
        console.error('Bootstrap timetable fetch error:', e.message)
      }
    }

    if (!attendance) {
      try {
        const html = await fetchReport(session.client, REPORT_IDS.attendance)
        attendance = parseAttendance(html)
        if (registrationNumber && attendance) {
          saveReportCache(registrationNumber, 'attendance', attendance)
        }
      } catch (e) {
        console.error('Bootstrap attendance fetch error:', e.message)
      }
    }

    res.json({
      timetable: timetable || null,
      attendance: attendance || null,
      courses: timetable ? timetable.subjects : []
    })
  } catch (error) {
    console.error('Bootstrap error:', error.message)
    res.status(500).json({ message: 'Failed to bootstrap student portal data' })
  }
})

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
      // These are independent requests to SRM (report data vs. the
      // dashboard page for the photo) — running them one after
      // another was paying for two full round-trips back to back
      // when they could just happen at the same time.
      [reportHtml, photoUrl] = await Promise.all([
        fetchReport(session.client, REPORT_IDS.profile),
        fetchStudentPhotoUrl(session.client)
      ])

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

// Timetable route (ids=10) returns parsed schedule, periods, and subject/faculty list
router.get('/timetable', async (req, res) => {
  const session = requireSession(req, res)
  if (!session) return

  const registrationNumber = session.username

  try {
    const cached = registrationNumber ? getCachedReport(registrationNumber, 'timetable') : null

    let timetableData = cached

    if (!timetableData) {
      const html = await fetchReport(session.client, REPORT_IDS.timetable)
      timetableData = parseTimetableData(html)

      if (registrationNumber) {
        saveReportCache(registrationNumber, 'timetable', timetableData)
      }
    }

    res.json(timetableData)
  } catch (error) {
    console.error('Timetable error:', error.message)
    res.status(500).json({ message: 'Failed to fetch timetable' })
  }
})

// Courses & Faculty endpoint
router.get('/courses', async (req, res) => {
  const session = requireSession(req, res)
  if (!session) return

  const registrationNumber = session.username

  try {
    const cached = registrationNumber ? getCachedReport(registrationNumber, 'timetable') : null

    let timetableData = cached

    if (!timetableData) {
      const html = await fetchReport(session.client, REPORT_IDS.timetable)
      timetableData = parseTimetableData(html)

      if (registrationNumber) {
        saveReportCache(registrationNumber, 'timetable', timetableData)
      }
    }

    res.json(timetableData.subjects || [])
  } catch (error) {
    console.error('Courses error:', error.message)
    res.status(500).json({ message: 'Failed to fetch courses' })
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

// Geolocation requirement removed: client sends only acode.
// Fixed coordinates (16.464478869582308, 80.50074625327288) are passed automatically.
router.post('/mark-attendance', async (req, res) => {
  const session = requireSession(req, res)
  if (!session) return

  const { acode } = req.body

  if (!acode) {
    return res.status(400).json({ message: 'Attendance code is required' })
  }

  try {
    const result = await markAttendance(session.client, {
      acode,
      latitude: 16.464478869582308,
      longitude: 80.50074625327288
    })
    res.json(result)
  } catch (error) {
    console.error('Mark attendance error:', error.message)
    res.status(500).json({ message: 'Failed to submit attendance' })
  }
})

const photoCache = new Map()

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

  const cacheKey = `${session.username || 'default'}:${photoUrl}`
  const cachedPhoto = photoCache.get(cacheKey)
  if (cachedPhoto && (Date.now() - cachedPhoto.fetchedAt < 12 * 60 * 60 * 1000)) {
    res.set('Content-Type', cachedPhoto.contentType)
    res.set('Cache-Control', 'public, max-age=86400')
    return res.send(cachedPhoto.imageBuffer)
  }

  try {
    const { contentType, imageBuffer } = await fetchBinaryResource(session.client, photoUrl)
    photoCache.set(cacheKey, {
      contentType,
      imageBuffer,
      fetchedAt: Date.now()
    })
    res.set('Content-Type', contentType)
    res.set('Cache-Control', 'public, max-age=86400')
    res.send(imageBuffer)
  } catch (error) {
    console.error('Photo error:', error.message)
    res.status(500).send()
  }
})

export default router
