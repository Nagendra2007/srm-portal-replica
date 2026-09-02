import express from 'express'
import { createClientSession, getClientSession, setSessionUsername, deleteClientSession } from '../services/clientSessionStore.js'
import { solveCaptcha, submitLogin, getWorker } from '../services/srmPortalService.js'
import { clearReportCache } from '../services/reportCache.js'

const router = express.Router()

// Create a new session and initialize with SRM student login page
router.get('/session', async (req, res) => {
  try {
    const { sessionId, client } = createClientSession()
    const session = getClientSession(sessionId)

    // Warm up the Tesseract OCR worker in the background while the user inputs their credentials
    getWorker().catch((err) => console.warn('Worker background warm up warning:', err.message))

    try {
      await client.get('https://student.srmap.edu.in/srmapstudentcorner/StudentLoginPage', {
        timeout: 5000
      })
      if (session) {
        session.loginPageVisited = true
      }
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

// Login route handling authentication with OCR captcha solving
router.post('/login', async (req, res) => {
  let sessionId = req.headers['x-client-session']
  let session = getClientSession(sessionId)

  if (!session) {
    const newSession = createClientSession()
    sessionId = newSession.sessionId
    session = getClientSession(sessionId)
  } else {
    // Clear existing cookies for a fresh login attempt
    try {
      if (session.client?.defaults?.jar) {
        session.client.defaults.jar.removeAllCookiesSync()
      }
      session.loginPageVisited = false
    } catch (e) {
      console.warn('Failed to clear session cookies:', e.message)
    }
  }

  const { username, password } = req.body || {}
  let { captchaCode } = req.body || {}

  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required' })
  }

  try {
    // Ensure we have loaded the login page first to establish JSESSIONID and captcha state
    if (!session.loginPageVisited) {
      try {
        await session.client.get('https://student.srmap.edu.in/srmapstudentcorner/StudentLoginPage', {
          timeout: 8000
        })
        session.loginPageVisited = true
      } catch (e) {
        console.warn('Login page load during auth failed:', e.message)
      }
    }

    // If captcha is not explicitly passed by client, solve it via OCR
    if (!captchaCode) {
      try {
        captchaCode = await solveCaptcha(session.client)
      } catch (captchaErr) {
        console.warn('OCR Captcha solve error, trying fallback:', captchaErr.message)
        captchaCode = 'SRM'
      }
    }

    const { success, status } = await submitLogin(session.client, {
      username,
      password,
      captchaCode
    })

    if (!success) {
      return res.status(401).json({
        message: 'Invalid credentials or captcha verification failed'
      })
    }

    // Attach student registration number to session
    setSessionUsername(sessionId, username)

    // Clear report cache for this user so they get fresh data on this login
    clearReportCache(username)

    res.set('X-Client-Session', sessionId)
    res.json({
      message: 'Login successful',
      sessionId,
      username
    })
  } catch (error) {
    console.error('Login error:', error.message)
    res.status(500).json({
      message: error.message || 'Login failed due to server error'
    })
  }
})

// Logout route to clear server session
router.post('/logout', (req, res) => {
  const sessionId = req.headers['x-client-session'] || req.body?.sessionId
  if (sessionId) {
    deleteClientSession(sessionId)
  }
  res.json({ message: 'Logged out successfully' })
})

export default router
