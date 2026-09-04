import { createWorker } from 'tesseract.js'
import * as cheerio from 'cheerio'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const SRM_HOST = 'student.srmap.edu.in'
const SRM_BASE_URL = `https://${SRM_HOST}/srmapstudentcorner/`

const CAPTCHA_URL = `${SRM_BASE_URL}captchas`
const LOGIN_URL = `${SRM_BASE_URL}StudentLoginToPortal`
const REPORT_URL = `${SRM_BASE_URL}students/report/studentreportresources.jsp`
const DASHBOARD_URL = `${SRM_BASE_URL.replace(/\/$/, '')}/HRDSystem`
const ATTENDANCE_URL = `${SRM_BASE_URL}students/transaction/studentattendanceresources.jsp`
const TODAY_ATTENDANCE_URL = `${SRM_BASE_URL}students/transaction/studentattendance.jsp`

export const REPORT_IDS = {
  profile: '1',
  timetable: '10',
  attendance: '3'
}

const MIN_ATTENDANCE_PERCENT = 75

/* --------------------------------------------------------------------------
   SSRF GUARD
   Anything that takes a URL from the client must be pinned to SRM's host.
   Previously /api/photo passed ?src= straight through, so the server would
   fetch any URL asked of it — including cloud metadata and localhost.
   -------------------------------------------------------------------------- */
export const resolveSrmUrl = (url) => {
  const resolved = new URL(url, SRM_BASE_URL)

  if (resolved.protocol !== 'https:' || resolved.hostname !== SRM_HOST) {
    const error = new Error('Refusing to fetch a non-SRM URL')
    error.statusCode = 400
    throw error
  }

  return resolved.href
}

/* --------------------------------------------------------------------------
   SESSION / LOGIN STATE DETECTION
   Single source of truth — checkSessionExpiry and isLoginSuccessful used to
   carry two byte-identical copies of this list, which is how they drift.
   -------------------------------------------------------------------------- */
const LANDING_PAGE_MARKERS = [
  'developed by: firstline infotech',
  'enter application number',
  'enter captcha text',
  'txtusername',
  'txtauthkey'
]

// FIX: 'incorrect' on its own matched any page that happened to contain the
// word. Anchored to the phrases SRM actually renders instead.
const LOGIN_ERROR_MARKERS = [
  'invalid captcha',
  'invalid username',
  'invalid password',
  'incorrect username',
  'incorrect password',
  'authentication failed'
]

const isLandingPage = (lower) => LANDING_PAGE_MARKERS.some((m) => lower.includes(m))

export const checkSessionExpiry = (html) => {
  if (!html || typeof html !== 'string') return

  if (isLandingPage(html.toLowerCase())) {
    const error = new Error('SRM session expired or logged out')
    error.statusCode = 401
    throw error
  }
}

// FIX: this used to `return true` when the body was empty or not a string —
// i.e. an empty response from SRM counted as a successful login. Failing
// closed is the only safe default for an auth check.
const isLoginSuccessful = (html) => {
  if (!html || typeof html !== 'string') return false

  const lower = html.toLowerCase()
  return !isLandingPage(lower) && !LOGIN_ERROR_MARKERS.some((m) => lower.includes(m))
}

/* --------------------------------------------------------------------------
   PARSERS
   -------------------------------------------------------------------------- */
export const parseAttendance = (html) => {
  const $ = cheerio.load(html)
  const subjects = []

  $('#tblSubjectWiseAttendance tr').each((_, row) => {
    const cells = $(row).find('td')
    if (cells.length !== 9) return

    const code = $(cells[0]).text().trim()
    const description = $(cells[1]).text().trim()
    const present = parseInt($(cells[3]).text().trim(), 10)
    const absent = parseInt($(cells[4]).text().trim(), 10)
    const attendancePercent = parseFloat($(cells[8]).text().trim())

    if (!code || Number.isNaN(present) || Number.isNaN(absent)) return

    const total = present + absent
    const canSkip = Math.max(
      0,
      Math.floor(present / (MIN_ATTENDANCE_PERCENT / 100) - total)
    )

    subjects.push({ code, description, present, absent, total, attendancePercent, canSkip })
  })

  return subjects
}

const clean = (text) => text.replace(/\u00a0/g, '').trim()

export const parseTimetableData = (html) => {
  if (!html) return { periods: [], schedule: [], subjects: [] }
  const $ = cheerio.load(html)

  const periods = []
  const periodNums = []

  $('#tblClassTimetable tr.timetablehead td, #tblClassTimetable tr:first-child td, #tblClassTimetable tr:first-child th').each((i, cell) => {
    const num = clean($(cell).text())
    if (num && num !== '&nbsp;' && !/^(day|time|period)/i.test(num)) periodNums.push(num)
  })

  $('#tblClassTimetable tr.subheader td, #tblClassTimetable tr:nth-child(2) td').each((i, cell) => {
    const timing = clean($(cell).text())
    if (timing && timing !== '&nbsp;' && !/^(day|time|period)/i.test(timing) &&
        (timing.includes(':') || timing.includes('-') || timing.toLowerCase().includes('to'))) {
      const slotNum = periodNums[periods.length] || String(periods.length + 1)
      const normalized = timing.replace(/\s+/g, ' ')
      periods.push({ slotNumber: slotNum, period: slotNum, timing: normalized, time: normalized })
    }
  })

  const schedule = []
  const validDayPattern = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|day\s*[-_]?\s*[1-6]|day\s*[ivx]+)/i

  $('#tblClassTimetable tr').each((_, row) => {
    const cells = $(row).find('td, th')
    if (cells.length < 2) return

    const firstCellText = clean($(cells[0]).text())
    if (!firstCellText || !validDayPattern.test(firstCellText)) return

    const dayName = firstCellText.replace(/\s+/g, ' ')
    const slots = []

    $(row).find('td.timetabledetails, td:not(:first-child)').each((colIdx, cell) => {
      const $cell = $(cell)
      if ($cell.hasClass('subheader') || $cell.hasClass('timetablehead')) return

      const title = $cell.attr('title')?.trim() || ''
      const rawText = clean($cell.text())

      let code = ''
      let room = ''
      if (rawText && rawText !== '-' && rawText !== '&nbsp;') {
        const match = rawText.match(/^(.*?)\((.*?)\)$/)
        if (match) {
          code = match[1].trim()
          room = match[2].trim()
        } else if (rawText.includes('\n')) {
          const parts = rawText.split('\n').map((p) => p.trim()).filter(Boolean)
          code = parts[0] || rawText
          room = parts[1] || ''
        } else {
          code = rawText
        }
      }

      const slot = periods[colIdx]
      const pNum = slot?.period || slot?.slotNumber || String(colIdx + 1)
      const pTiming = slot?.time || slot?.timing || ''

      slots.push({
        slotIndex: colIdx,
        slotNumber: pNum,
        period: pNum,
        timing: pTiming,
        time: pTiming,
        codeRoom: rawText,
        code,
        courseCode: code,
        room,
        roomNo: room,
        subjectName: title,
        title,
        courseTitle: title || code
      })
    })

    if (slots.length > 0) schedule.push({ day: dayName, slots })
  })

  const subjects = []
  $('#tblSubjectList tr, table.subjectlist tr').each((i, row) => {
    const cells = $(row).find('td')
    if (cells.length < 4 || $(cells[0]).hasClass('subheader') || $(cells[0]).hasClass('tableheader')) return

    const wide = cells.length >= 5
    const code = clean($(cells[0]).text())
    const title = clean($(cells[1]).text())
    const ltpc = wide ? clean($(cells[2]).text()) : ''
    const faculty = wide ? clean($(cells[3]).text()) : clean($(cells[2]).text())
    const room = wide ? clean($(cells[4]).text()) : clean($(cells[3]).text())

    const lowerCode = code.toLowerCase()
    if (code && !lowerCode.includes('code') && !lowerCode.includes('subject') && !lowerCode.includes('s.no')) {
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

  return { periods, schedule, subjects }
}

export const parseTodayAttendance = (html) => {
  const $ = cheerio.load(html || '')

  let dayOrder = ''
  const onlineAttendance = []
  const periods = []

  $('.container-fluid').each((_, container) => {
    const $container = $(container)
    const heading = $container.find('.row').first().text().trim()

    if (/current attendance/i.test(heading)) {
      $container.find('.row').each((__, row) => {
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
        if (date.toLowerCase() === 'date') return

        periods.push({
          date,
          dayOrder: $(cols[1]).text().trim(),
          hour: $(cols[2]).text().trim(),
          subject: $(cols[3]).text().trim(),
          status: $(cols[4]).text().trim()
        })
      })
    }
  })

  return { dayOrder, onlineAttendance, periods }
}

/* --------------------------------------------------------------------------
   OCR WORKER
   FIX: the old version cached the *worker*, not the promise, so two logins
   arriving together both saw null and each built a Tesseract worker. Every
   duplicate loaded its own language model and never got freed.

   FIX: langPath was process.cwd(), which differs between `npm start` at the
   repo root and `npm start` inside backend/ — so whether OCR worked at all
   depended on which directory you launched from.

   FIX: the repo has no eng.traineddata, and hardcoding langPath to a local
   directory made that a hard crash (ENOENT) rather than a recoverable miss.
   tesseract.js only falls back to its jsdelivr CDN when langPath is left
   UNSET, so we now set it only if a real local file is present. cachePath
   makes the first download persist, so run one needs the network and every
   run after it does not.

   FIX: tesseract.js v7 does `throw Error(data)` from inside a MessagePort
   event handler when a worker job rejects and no errorHandler was supplied
   (node_modules/tesseract.js/src/createWorker.js:217). That throw escapes
   every try/catch here and kills the process. Supplying errorHandler routes
   the failure into our promise instead, so a missing or corrupt model is a
   503 from /api/login rather than a crashed server.
   -------------------------------------------------------------------------- */
const TESSDATA_DIR = process.env.TESSDATA_PATH || path.resolve(__dirname, '../..')

// tesseract.js reads/writes the *decompressed* model as `<dir>/eng.traineddata`.
const localModelPath = path.join(TESSDATA_DIR, 'eng.traineddata')

// FIX: with no local model AND an unreachable CDN, createWorker() never
// settles — it just waits on the socket. Verified: a worker build with egress
// blocked hung past 120s with no error. An unbounded wait here stalls the
// login request behind it, so cap it and surface a 503 instead.
const OCR_INIT_TIMEOUT_MS = Number(process.env.OCR_INIT_TIMEOUT_MS || 60_000)

// FIX: when createWorker() fails, tesseract.js gives us no handle to the
// worker thread it already spawned, so we cannot terminate it — and it keeps
// the event loop alive. Verified: a bare script with a failed init never
// exited. (server.js force-exits on shutdown, so this only leaks while
// running.) Retrying on every login would therefore add a dead thread per
// attempt and hammer the CDN, so hold a short cooldown and fail fast instead.
const OCR_FAIL_COOLDOWN_MS = Number(process.env.OCR_FAIL_COOLDOWN_MS || 60_000)
let lastOcrFailureAt = 0

const hasLocalModel = () => {
  try {
    return fs.statSync(localModelPath).size > 0
  } catch {
    return false
  }
}

let workerPromise = null

export const getWorker = () => {
  if (!workerPromise) {
    const sinceFailure = Date.now() - lastOcrFailureAt

    if (lastOcrFailureAt && sinceFailure < OCR_FAIL_COOLDOWN_MS) {
      const wait = Math.ceil((OCR_FAIL_COOLDOWN_MS - sinceFailure) / 1000)
      const e = new Error(
        `OCR is unavailable (last init failed). Retrying in ${wait}s. ` +
        `Place eng.traineddata at ${localModelPath} to fix this permanently.`
      )
      e.statusCode = 503
      return Promise.reject(e)
    }

    workerPromise = (async () => {
      const useLocal = hasLocalModel()

      if (!useLocal) {
        console.log(
          `[ocr] no model at ${localModelPath} — downloading eng.traineddata ` +
          `once from the tesseract.js CDN and caching it there. Drop the file ` +
          `in yourself to skip the network entirely.`
        )
      }

      const creating = createWorker('eng', 1, {
        // Only pin langPath when the file really exists. Left unset,
        // tesseract.js downloads from cdn.jsdelivr.net instead of throwing.
        ...(useLocal ? { langPath: TESSDATA_DIR, gzip: false } : {}),
        // Persist the model so only the first run touches the network.
        cachePath: TESSDATA_DIR,
        // Without this, a load failure throws from an event handler and
        // takes the whole process down. See the FIX note above.
        errorHandler: (err) => {
          console.error('[ocr] tesseract worker error:', err?.message || err)
        },
        parameters: {
          load_system_dawg: '0',
          load_freq_dawg: '0'
        }
      })

      let timedOut = false

      // If we give up waiting, don't leak the worker that eventually arrives.
      creating.then(
        (w) => { if (timedOut) Promise.resolve(w.terminate()).catch(() => {}) },
        () => {}
      )

      let timer
      const worker = await Promise.race([
        creating,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true
            const e = new Error(
              `OCR init timed out after ${OCR_INIT_TIMEOUT_MS}ms. ` +
              (useLocal
                ? `Model at ${localModelPath} may be corrupt.`
                : `Could not reach the tesseract.js CDN — place eng.traineddata at ${localModelPath}.`)
            )
            e.statusCode = 503
            reject(e)
          }, OCR_INIT_TIMEOUT_MS)
          timer.unref?.()
        })
      ]).finally(() => clearTimeout(timer))

      try {
        await worker.setParameters({
          tessedit_char_whitelist: '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
          tessedit_pageseg_mode: '7'
        })
      } catch (e) {
        console.warn('Tesseract param config warning:', e.message)
      }

      lastOcrFailureAt = 0
      return worker
    })().catch((err) => {
      // Don't cache a rejected promise — otherwise one cold-start failure
      // permanently disables captcha solving for the process lifetime.
      workerPromise = null
      lastOcrFailureAt = Date.now()
      throw err
    })
  }

  return workerPromise
}

export const terminateWorker = async () => {
  if (!workerPromise) return
  try {
    const worker = await workerPromise
    await worker.terminate()
  } catch {
    /* already gone */
  } finally {
    workerPromise = null
  }
}

export const solveCaptcha = async (client) => {
  const captchaResponse = await client.get(CAPTCHA_URL, { responseType: 'arraybuffer' })

  const worker = await getWorker()
  const { data } = await worker.recognize(captchaResponse.data)

  return data.text.replace(/[^a-zA-Z0-9]/g, '').trim()
}

/* --------------------------------------------------------------------------
   SRM REQUESTS
   -------------------------------------------------------------------------- */
export const fetchBinaryResource = async (client, url) => {
  const response = await client.get(resolveSrmUrl(url), { responseType: 'arraybuffer' })

  return {
    contentType: response.headers['content-type'] || 'image/jpeg',
    imageBuffer: response.data
  }
}

export const fetchStudentPhotoUrl = async (client) => {
  const response = await client.get(DASHBOARD_URL)
  const html = typeof response.data === 'string' ? response.data : ''
  checkSessionExpiry(html)

  const match = html.match(/src="([^"]*resources\/photos\/[^"]+)"/i)
  return match ? match[1] : null
}

// Campus coordinates. Kept as the default so existing behaviour is unchanged,
// but overridable via ATTENDANCE_LATITUDE / ATTENDANCE_LONGITUDE so the value
// is a deployment decision rather than a hard-coded constant in a route.
const DEFAULT_LATITUDE = 16.464478869582308
const DEFAULT_LONGITUDE = 80.50074625327288

const coord = (value, fallback) => {
  const parsed = typeof value === 'number' ? value : parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const markAttendance = async (client, { acode, latitude, longitude } = {}) => {
  // Guard against String(undefined) === 'undefined' reaching SRM when the env
  // vars are unset.
  const lat = coord(latitude, coord(process.env.ATTENDANCE_LATITUDE, DEFAULT_LATITUDE))
  const lon = coord(longitude, coord(process.env.ATTENDANCE_LONGITUDE, DEFAULT_LONGITUDE))

  const form = new URLSearchParams()
  form.append('ids', '1')
  form.append('acode', acode)
  form.append('dynamiclatdata', String(lat))
  form.append('dynamiclonxdata', String(lon))

  const response = await client.post(ATTENDANCE_URL, form.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest'
    }
  })

  if (typeof response.data === 'string') checkSessionExpiry(response.data)

  return response.data
}

// FIX: takes the session, not just the client, so the scraped studentId is
// remembered. /api/att used to re-download the whole dashboard page on every
// poll just to read one hidden input.
export const fetchId = async (session) => {
  const client = session.client ?? session

  if (session.studentId) return session.studentId

  const response = await client.post(DASHBOARD_URL)
  const html = typeof response.data === 'string' ? response.data : ''
  checkSessionExpiry(html)

  const studentId = cheerio.load(html)('#studentId').attr('value')
  if (studentId && session.client) session.studentId = studentId

  return studentId
}

export const fetchAtt = async (client, id) => {
  const form = new URLSearchParams()
  form.append('ids', '33')
  form.append('studId', id)

  const response = await client.post(TODAY_ATTENDANCE_URL, form.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'text/html, */*; q=0.01'
    }
  })

  checkSessionExpiry(response.data)
  return response.data
}

export const fetchReport = async (client, ids) => {
  const form = new URLSearchParams()
  form.append('ids', ids)

  const response = await client.post(REPORT_URL, form.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'text/html, */*; q=0.01'
    }
  })

  checkSessionExpiry(response.data)
  return response.data
}

// FIX: only one redirect hop was followed. SRM chains Location headers on
// some login paths, which showed up as a random "invalid credentials".
export const submitLogin = async (client, { username, password, captchaCode }) => {
  const form = new URLSearchParams()
  form.append('ccode', captchaCode)
  form.append('txtUserName', username)
  form.append('txtAuthKey', password)

  let response = await client.post(LOGIN_URL, form.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  })

  let currentUrl = LOGIN_URL
  let hops = 0

  while (response.status >= 300 && response.status < 400 && response.headers.location && hops < 5) {
    currentUrl = new URL(response.headers.location, currentUrl).href
    response = await client.get(currentUrl)
    hops += 1
  }

  const finalHtml = typeof response.data === 'string' ? response.data : ''
  const success = response.status >= 200 && response.status < 300 && isLoginSuccessful(finalHtml)

  return { success, status: response.status }
}
