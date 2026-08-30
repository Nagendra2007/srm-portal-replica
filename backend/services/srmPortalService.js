import { createWorker } from 'tesseract.js'

const CAPTCHA_URL = 'https://student.srmap.edu.in/srmapstudentcorner/captchas'
const LOGIN_URL = 'https://student.srmap.edu.in/srmapstudentcorner/StudentLoginToPortal'
const REPORT_URL = 'https://student.srmap.edu.in/srmapstudentcorner/students/report/studentreportresources.jsp'

// SRM's report endpoint returns different data depending on which
// "ids" value you send it — same URL, same shape of request, just
// a different report. Naming them here means routes never need to
// remember magic numbers.
export const REPORT_IDS = {
  profile: '1',
  timetable: '10'
}

// Creating a Tesseract worker loads the language model from disk,
// which is slow. Doing that on every single login would make every
// request pay that cost again — so we create it once, lazily, and
// reuse the same worker for every captcha after that.
let workerPromise = null

const getWorker = () => {
  if (!workerPromise) {
    workerPromise = createWorker('eng')
  }
  return workerPromise
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

  const match = html.match(/src="([^"]*resources\/photos\/[^"]+)"/i)

  return match ? match[1] : null
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

  return response.data
}