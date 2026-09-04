import { createWorker } from 'tesseract.js'
import * as cheerio from 'cheerio'
import path from 'path'

const CAPTCHA_URL = 'https://student.srmap.edu.in/srmapstudentcorner/captchas'
const LOGIN_URL = 'https://student.srmap.edu.in/srmapstudentcorner/StudentLoginToPortal'
const REPORT_URL = 'https://student.srmap.edu.in/srmapstudentcorner/students/report/studentreportresources.jsp'

// SRM's report endpoint returns different data depending on which
// "ids" value you send it — same URL, same shape of request, just
// a different report. Naming them here means routes never need to
// remember magic numbers.
export const REPORT_IDS = {
  profile: '1',
  timetable: '10',
  attendance: '3'
}

const MIN_ATTENDANCE_PERCENT = 75

export const checkSessionExpiry = (html) => {
  if (!html || typeof html !== 'string') return
  const lower = html.toLowerCase()
  const stillOnLandingPage =
    lower.includes('developed by: firstline infotech') ||
    lower.includes('enter application number') ||
    lower.includes('enter captcha text') ||
    lower.includes('freshers') ||
    lower.includes('senior students') ||
    lower.includes('txtusername') ||
    lower.includes('txtauthkey')

  if (stillOnLandingPage) {
    const error = new Error('SRM session expired or logged out')
    error.statusCode = 401
    throw error
  }
}

// SRM's attendance table has 9 columns per subject row:
// code, description, classesConducted, present, absent, odmlTaken,
// presentPercent, odmlPercentApproved, attendancePercent — in that
// exact order. "Can skip" isn't sent by SRM at all; it's derived:
// how many more classes could you miss (each one also adding to the
// total) while staying at or above the minimum required percentage.
export const parseAttendance = (html) => {
  const $ = cheerio.load(html)
  const subjects = []

  $('#tblSubjectWiseAttendance tr').each((_, row) => {
    const cells = $(row).find('td')

    if (cells.length !== 9) {
      return
    }

    const code = $(cells[0]).text().trim()
    const description = $(cells[1]).text().trim()
    const present = parseInt($(cells[3]).text().trim(), 10)
    const absent = parseInt($(cells[4]).text().trim(), 10)
    const attendancePercent = parseFloat($(cells[8]).text().trim())

    if (!code || Number.isNaN(present) || Number.isNaN(absent)) {
      return
    }

    const total = present + absent
    const canSkip = Math.max(
      0,
      Math.floor(present / (MIN_ATTENDANCE_PERCENT / 100) - total)
    )

    subjects.push({
      code,
      description,
      present,
      absent,
      total,
      attendancePercent,
      canSkip
    })
  })

  return subjects
}

// Parses the SRM timetable HTML (ids=10) which contains:
// 1. #tblClassTimetable (weekly schedule with periods, timing, course code, room)
// 2. #tblSubjectList (subject details with LTPC, faculty names, classrooms)
export const parseTimetableData = (html) => {
  if (!html) return { periods: [], schedule: [], subjects: [] }
  const $ = cheerio.load(html)

  // 1. Periods & Timings
  const periods = []
  const periodNums = []

  // Check header rows for slot numbers
  $('#tblClassTimetable tr.timetablehead td, #tblClassTimetable tr:first-child td, #tblClassTimetable tr:first-child th').each((i, cell) => {
    const num = $(cell).text().replace(/\u00a0/g, '').trim()
    if (num && num !== '&nbsp;' && !/^(day|time|period)/i.test(num)) {
      periodNums.push(num)
    }
  })

  // Check subheader or second row for slot timings
  $('#tblClassTimetable tr.subheader td, #tblClassTimetable tr:nth-child(2) td').each((i, cell) => {
    const timing = $(cell).text().replace(/\u00a0/g, '').trim()
    if (timing && timing !== '&nbsp;' && !/^(day|time|period)/i.test(timing) && (timing.includes(':') || timing.includes('-') || timing.toLowerCase().includes('to'))) {
      const idx = periods.length
      const slotNum = periodNums[idx] || String(idx + 1)
      periods.push({
        slotNumber: slotNum,
        period: slotNum,
        timing: timing.replace(/\s+/g, ' '),
        time: timing.replace(/\s+/g, ' ')
      })
    }
  })

  // 2. Schedule Grid by Day
  const schedule = []
  const validDayPattern = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|day\s*[-_]?\s*[1-6]|day\s*[ivx]+)/i

  $('#tblClassTimetable tr').each((_, row) => {
    const cells = $(row).find('td, th')
    if (cells.length < 2) return

    const firstCellText = $(cells[0]).text().replace(/\u00a0/g, '').trim()
    if (!firstCellText || !validDayPattern.test(firstCellText)) {
      return
    }

    const dayName = firstCellText.replace(/\s+/g, ' ')
    const slots = []

    $(row).find('td.timetabledetails, td:not(:first-child)').each((colIdx, cell) => {
      // Skip if this cell is header
      if ($(cell).hasClass('subheader') || $(cell).hasClass('timetablehead')) return

      const title = $(cell).attr('title')?.trim() || ''
      const rawText = $(cell).text().replace(/\u00a0/g, '').trim()

      let code = ''
      let room = ''
      if (rawText && rawText !== '-' && rawText !== '&nbsp;') {
        const match = rawText.match(/^(.*?)\((.*?)\)$/)
        if (match) {
          code = match[1].trim()
          room = match[2].trim()
        } else if (rawText.includes('\n')) {
          const parts = rawText.split('\n').map(p => p.trim()).filter(Boolean)
          code = parts[0] || rawText
          room = parts[1] || ''
        } else {
          code = rawText
        }
      }

      const pNum = periods[colIdx]?.period || periods[colIdx]?.slotNumber || String(colIdx + 1)
      const pTiming = periods[colIdx]?.time || periods[colIdx]?.timing || ''

      slots.push({
        slotIndex: colIdx,
        slotNumber: pNum,
        period: pNum,
        timing: pTiming,
        time: pTiming,
        codeRoom: rawText,
        code: code,
        courseCode: code,
        room: room,
        roomNo: room,
        subjectName: title,
        title: title,
        courseTitle: title || code
      })
    })

    if (slots.length > 0) {
      schedule.push({
        day: dayName,
        slots
      })
    }
  })

  // 3. Subject List with Faculty & Classrooms
  const subjects = []
  $('#tblSubjectList tr, table.subjectlist tr').each((i, row) => {
    const cells = $(row).find('td')
    if (cells.length < 4 || $(cells[0]).hasClass('subheader') || $(cells[0]).hasClass('tableheader')) {
      return
    }

    const code = $(cells[0]).text().replace(/\u00a0/g, '').trim()
    const title = $(cells[1]).text().replace(/\u00a0/g, '').trim()
    const ltpc = cells.length >= 5 ? $(cells[2]).text().replace(/\u00a0/g, '').trim() : ''
    const faculty = cells.length >= 5 ? $(cells[3]).text().replace(/\u00a0/g, '').trim() : $(cells[2]).text().replace(/\u00a0/g, '').trim()
    const room = cells.length >= 5 ? $(cells[4]).text().replace(/\u00a0/g, '').trim() : $(cells[3]).text().replace(/\u00a0/g, '').trim()

    if (code && !code.toLowerCase().includes('code') && !code.toLowerCase().includes('subject') && !code.toLowerCase().includes('s.no')) {
      subjects.push({
        code,
        courseCode: code,
        title,
        courseTitle: title,
        ltpc,
        faculty,
        facultyName: faculty,
        room,
        roomNo: room
      })
    }
  })

  return {
    periods,
    schedule,
    subjects
  }
}

// Creating a Tesseract worker loads the language model from disk,
// which is slow. Doing that on every single login would make every
// request pay that cost again — so we create it once, lazily, and
// reuse the same worker for every captcha after that.
let workerInstance = null

export const getWorker = async () => {
  if (!workerInstance) {
    const worker = await createWorker('eng', 1, {
      langPath: process.cwd(),
      gzip: false,
      parameters: {
        load_system_dawg: '0',
        load_freq_dawg: '0'
      }
    })
    try {
      await worker.setParameters({
        tessedit_char_whitelist: '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
        tessedit_pageseg_mode: '7' // Treat image as a single text line (PSM_SINGLE_LINE)
      })
    } catch (e) {
      console.warn('Tesseract param config warning:', e.message)
    }
    workerInstance = worker
  }
  return workerInstance
}

const SRM_BASE_URL = 'https://student.srmap.edu.in/srmapstudentcorner/'

export const fetchBinaryResource = async (client, url) => {
  // The photo URL pulled from the dashboard page is often a relative
  // path (e.g. "resources/photos/hash.jpg?rn=123"), not a full
  // https:// URL. axios has no baseURL configured on this client, so
  // a relative path here throws immediately. Resolving against SRM's
  // own base URL first makes it work whether the source gave us a
  // relative or already-absolute path.
  const resolvedUrl = new URL(url, SRM_BASE_URL).href

  const response = await client.get(resolvedUrl, { responseType: 'arraybuffer' })

  return {
    contentType: response.headers['content-type'] || 'image/jpeg',
    imageBuffer: response.data
  }
}

const DASHBOARD_URL = 'https://student.srmap.edu.in/srmapstudentcorner/HRDSystem'

// The photo lives on the post-login dashboard page, not inside the
// report fragment (studentreportresources.jsp) — those are two
// separate pages SRM serves, so we fetch this one too, just to pull
// the photo URL out of it.
export const fetchStudentPhotoUrl = async (client) => {
  const response = await client.get(DASHBOARD_URL)
  const html = typeof response.data === 'string' ? response.data : ''
  checkSessionExpiry(html)

  const match = html.match(/src="([^"]*resources\/photos\/[^"]+)"/i)

  return match ? match[1] : null
}

const ATTENDANCE_URL = 'https://student.srmap.edu.in/srmapstudentcorner/students/transaction/studentattendanceresources.jsp'

// Fixed campus GPS coordinates (SRM AP Campus)
const FIXED_LATITUDE = 16.464478869582308
const FIXED_LONGITUDE = 80.50074625327288

// Submits an attendance code with fixed campus coordinates
// without requiring client-side geolocation.
export const markAttendance = async (client, { acode, latitude = FIXED_LATITUDE, longitude = FIXED_LONGITUDE }) => {
  const form = new URLSearchParams()
  form.append('ids', '1')
  form.append('acode', acode)
  form.append('dynamiclatdata', String(latitude || FIXED_LATITUDE))
  form.append('dynamiclonxdata', String(longitude || FIXED_LONGITUDE))

  const response = await client.post(ATTENDANCE_URL, form.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest'
    }
  })

  if (typeof response.data === 'string') {
    checkSessionExpiry(response.data)
  }

  return response.data
}

// Fetches the logged-in student's internal studentId (needed by
// the today's-attendance-status endpoint) from the post-login
// dashboard page's hidden #studentId field.
export const fetchId = async (client) => {
  const response = await client.post(DASHBOARD_URL)
  const html = typeof response.data === 'string' ? response.data : ''
  checkSessionExpiry(html)

  const $ = cheerio.load(html)
  const studentId = $('#studentId').attr('value')
  return studentId
}

const TODAY_ATTENDANCE_URL = 'https://student.srmap.edu.in/srmapstudentcorner/students/transaction/studentattendance.jsp'

// Today's attendance status (ids=33) — a different endpoint/shape
// than the subject-wise attendance report (ids=3 via fetchReport).
// Unlike the other report endpoints, this one returns a full HTML
// *page* (its own <head>/<script>), not a fragment, so it can't be
// safely injected into our own DOM — parse it into clean JSON instead.
export const fetchAtt = async (client, id) => {
  const form = new URLSearchParams()
  form.append('ids', 33)
  form.append('studId', id)

  const response = await client.post(TODAY_ATTENDANCE_URL, form.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'text/html, */*; q=0.01'
    }
  })

  checkSessionExpiry(response.data)

  return response.data
}

// Pulls the three sections out of the ids=33 page:
// - dayOrder: today's day order label (e.g. "Wednesday")
// - onlineAttendance: log lines of attendance codes already accepted today
// - periods: today's hour-by-hour status rows (date, dayOrder, hour, subject, status)
export const parseTodayAttendance = (html) => {
  const $ = cheerio.load(html || '')

  const containers = $('.container-fluid')
  let dayOrder = ''
  const onlineAttendance = []
  const periods = []

  containers.each((_, container) => {
    const $container = $(container)
    const heading = $container.find('.row').first().text().trim()

    if (/current attendance/i.test(heading)) {
      const rows = $container.find('.row')
      rows.each((__, row) => {
        const cols = $(row).find('div[class*="col-"]')
        if (cols.length === 2 && $(cols[0]).text().trim().toLowerCase() === 'day order') {
          dayOrder = $(cols[1]).text().trim()
        }
      })
      return
    }

    if (/online attendance/i.test(heading)) {
      $container.find('.row').each((__, row) => {
        const cols = $(row).find('div[class*="col-"]')
        if (cols.length === 1) {
          const text = $(cols[0]).text().trim()
          if (text) onlineAttendance.push(text)
        }
      })
      return
    }

    if (/today attendance/i.test(heading)) {
      $container.find('.row').each((__, row) => {
        const cols = $(row).find('div[class*="col-"]')
        if (cols.length !== 5) return

        const date = $(cols[0]).text().trim()
        const rowDayOrder = $(cols[1]).text().trim()

        // Skip the header row (labels instead of data)
        if (date.toLowerCase() === 'date') return

        periods.push({
          date,
          dayOrder: rowDayOrder,
          hour: $(cols[2]).text().trim(),
          subject: $(cols[3]).text().trim(),
          status: $(cols[4]).text().trim()
        })
      })
    }
  })

  return { dayOrder, onlineAttendance, periods }
}

export const solveCaptcha = async (client) => {
  const captchaResponse = await client.get(CAPTCHA_URL, {
    responseType: 'arraybuffer'
  })

  const worker = await getWorker()
  const { data } = await worker.recognize(captchaResponse.data)

  return data.text.replace(/[^a-zA-Z0-9]/g, '').trim()
}

const isLoginSuccessful = (html) => {
  if (!html || typeof html !== 'string') {
    return true
  }

  const lower = html.toLowerCase()

  // These only ever appear on the generic pre-login / landing page,
  // never on real portal data — so their presence means we're still
  // looking at an unauthenticated response, regardless of exact
  // attribute quoting or casing in the login form itself.
  const stillOnLandingPage =
    lower.includes('developed by: firstline infotech') ||
    lower.includes('enter application number') ||
    lower.includes('enter captcha text') ||
    lower.includes('freshers') ||
    lower.includes('senior students') ||
    lower.includes('txtusername') ||
    lower.includes('txtauthkey')

  const explicitError =
    lower.includes('invalid captcha') ||
    lower.includes('invalid username') ||
    lower.includes('invalid password') ||
    lower.includes('incorrect') ||
    lower.includes('authentication failed')

  return !stillOnLandingPage && !explicitError
}

export const submitLogin = async (client, { username, password, captchaCode }) => {
  const form = new URLSearchParams()
  form.append('ccode', captchaCode)
  form.append('txtUserName', username)
  form.append('txtAuthKey', password)

  const loginResponse = await client.post(LOGIN_URL, form.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  })

  let finalHtml = typeof loginResponse.data === 'string' ? loginResponse.data : ''
  let finalStatus = loginResponse.status

  const isRedirect =
    loginResponse.status >= 300 &&
    loginResponse.status < 400 &&
    loginResponse.headers.location

  if (isRedirect) {
    const redirectUrl = new URL(loginResponse.headers.location, LOGIN_URL).href
    const portalResponse = await client.get(redirectUrl)

    finalHtml = typeof portalResponse.data === 'string' ? portalResponse.data : ''
    finalStatus = portalResponse.status
  }

  const success = finalStatus >= 200 && finalStatus < 300 && isLoginSuccessful(finalHtml)

  return { success, status: finalStatus }
}

// Shared by /profile and /timetable — same SRM endpoint, only the
// "ids" value differs, so there's no reason to duplicate this logic.
export const fetchReport = async (client, ids) => {
  const form = new URLSearchParams()
  form.append('ids', ids)

  const response = await client.post(REPORT_URL, form.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'text/html, */*; q=0.01'
    }
  })

  checkSessionExpiry(response.data)

  return response.data
}
