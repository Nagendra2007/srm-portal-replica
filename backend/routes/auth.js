import express from 'express'
import {
  createClientSession,
  getClientSession,
  setSessionUsername,
  deleteClientSession
} from '../services/clientSessionStore.js'
import { solveCaptcha, submitLogin, getWorker } from '../services/srmPortalService.js'
import { clearReportCache } from '../services/reportCache.js'
import { rateLimit } from '../middleware/rateLimit.js'

const router = express.Router()

const LOGIN_PAGE_URL = 'https://student.srmap.edu.in/srmapstudentcorner/StudentLoginPage'

// Session creation is cheap but not free — each one holds a cookie jar.
const sessionLimiter = rateLimit({ windowMs: 60_000, max: 30, message: 'Too many session requests' })

// FIX: /login had no throttle. 8 attempts/minute is generous for a human and
// useless for a credential-stuffing script.
const loginLimiter = rateLimit({
  windowMs: 60_000,
  max: 8,
  message: 'Too many login attempts. Wait a minute and try again.'
})

router.get('/session', sessionLimiter, async (req, res) => {
  try {
    const { sessionId, client } = createClientSession()
    const session = getClientSession(sessionId)

    // Warm the OCR worker while the user is still typing.
    getWorker().catch((err) => console.warn('Worker background warm up warning:', err.message))

    try {
      await client.get(LOGIN_PAGE_URL, { timeout: 5000 })
      if (session) session.loginPageVisited = true
    } catch (e) {
      console.warn('Initial SRM page pre-fetch warning:', e.message)
    }

    res.set('X-Client-Session', sessionId)
    res.json({ message: 'Session created', sessionId })
  } catch (error) {
    console.error('Session creation error:', error.message)
    res.status(500).json({ message: 'Failed to create session' })
  }
})

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {}
  let { captchaCode } = req.body || {}
  console.log(username , password);

  // FIX: only truthiness was checked, so a JSON body of {username:{},
  // password:[]} reached URLSearchParams and stringified into garbage.
  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
    return res.status(400).json({ message: 'Username and password are required' })
  }

  if (username.length > 64 || password.length > 256) {
    return res.status(400).json({ message: 'Username or password is too long' })
  }

  if (captchaCode !== undefined && typeof captchaCode !== 'string') {
    return res.status(400).json({ message: 'Invalid captcha value' })
  }

  /*
   * SECURITY: two console.log calls used to sit here, printing the submitted
   * username and the submitted password to stdout on every single attempt.
   * That put real students' SRM passwords in cleartext into the process log,
   * journald, and any log shipper attached to the host — where they persist
   * long after the request, readable by anyone with log access.
   *
   * Both calls are deleted. Nothing on an auth path should log req.body, and
   * if you need request tracing here, log the username only, never the secret.
   */

  // FIX: rotate the session id on every login attempt instead of reusing the
  // caller-supplied one. Re-keying costs nothing and removes the window where
  // a pre-seeded X-Client-Session value could be ridden after a real login.
  const previousSessionId = req.headers['x-client-session']
  if (typeof previousSessionId === 'string' && previousSessionId) {
    deleteClientSession(previousSessionId)
  }

  const { sessionId } = createClientSession()
  const session = getClientSession(sessionId)

  if (!session) {
    return res.status(500).json({ message: 'Failed to create session' })
  }

  try {
    try {
      await session.client.get(LOGIN_PAGE_URL, { timeout: 8000 })
      session.loginPageVisited = true
    } catch (e) {
      console.warn('Login page load during auth failed:', e.message)
    }

    if (!captchaCode) {
      try {
        captchaCode = await solveCaptcha(session.client)
      } catch (captchaErr) {
        console.warn('OCR captcha solve failed:', captchaErr.message)
        // FIX: this used to fall back to the literal string 'SRM', which can
        // never be the right answer — so an OCR outage surfaced to the student
        // as "invalid credentials" and sent a doomed request to SRM anyway.
        deleteClientSession(sessionId)
        return res.status(503).json({
          message: 'Captcha could not be read automatically. Please try again in a moment.'
        })
      }
    }

    if (!captchaCode) {
      deleteClientSession(sessionId)
      return res.status(503).json({
        message: 'Captcha could not be read automatically. Please try again in a moment.'
      })
    }

    const { success } = await submitLogin(session.client, { username, password, captchaCode })

    if (!success) {
      deleteClientSession(sessionId)
      return res.status(401).json({ message: 'Invalid credentials or captcha verification failed' })
    }

    setSessionUsername(sessionId, username)
    clearReportCache(username)

    res.set('X-Client-Session', sessionId)
    res.json({ message: 'Login successful', sessionId, username })
  } catch (error) {
    console.error('Login error:', error.message)
    deleteClientSession(sessionId)
    // FIX: was `error.message || ...`, which handed internal axios/DNS/stack
    // detail to the browser. Log it, return something generic.
    res.status(500).json({ message: 'Login failed due to a server error' })
  }
})

router.post('/logout', (req, res) => {
  const sessionId = req.headers['x-client-session'] || req.body?.sessionId
  if (typeof sessionId === 'string' && sessionId) deleteClientSession(sessionId)
  res.json({ message: 'Logged out successfully' })
})

export default router
