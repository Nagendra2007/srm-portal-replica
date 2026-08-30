import express from 'express'
import { getClientSession, deleteClientSession, setSessionUsername } from '../services/clientSessionStore.js'
import { solveCaptcha, submitLogin } from '../services/srmPortalService.js'

const router = express.Router()

router.post('/login', async (req, res) => {
  const sessionId = req.headers['x-client-session']
  const session = getClientSession(sessionId)

  if (!session) {
    return res.status(401).json({ message: 'Session not found or expired' })
  }

  const { username, password } = req.body

  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required' })
  }

  try {
    const captchaCode = await solveCaptcha(session.client)
    const { success, status } = await submitLogin(session.client, { username, password, captchaCode })

    if (!success) {
      return res.status(401).json({ success: false, message: 'Login rejected by SRM portal' })
    }

    // Tag this session with who's logged in — this is what lets
    // /profile and /timetable know which student's data to cache.
    setSessionUsername(sessionId, username)

    return res.status(200).json({ success: true, message: 'Login successful' })
  } catch (error) {
    console.error('Login error:', error.message)
    return res.status(500).json({ message: 'Login request failed' })
  }
})

router.post('/logout', (req, res) => {
  const sessionId = req.headers['x-client-session']
  deleteClientSession(sessionId)
  return res.status(200).json({ success: true, message: 'Logged out' })
})

export default router