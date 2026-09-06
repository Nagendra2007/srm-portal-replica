import express from 'express'
import cors from 'cors'
import path from 'path'
import compression from 'compression'
import { fileURLToPath } from 'url'
import authRoutes from './routes/auth.js'
import portalRoutes from './routes/portal.js'
import { createClientSession } from './services/clientSessionStore.js'


const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()

app.use(compression())
app.use(cors({
  exposedHeaders: ['X-Client-Session']
}))
app.use(express.json())


app.use(express.static(path.join(__dirname, '../frontend')))


app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/login.html'))
})

app.use('/api', authRoutes)
app.use('/api', portalRoutes)


app.get('/api/session', (req, res) => {
  // Create the server-side session immediately so the frontend always gets a
  // usable session id, even if the upstream SRM portal is unreachable from the
  // deployment environment. Previously this endpoint awaited a real GET to
  // student.srmap.edu.in before responding — when that timed out (which it
  // does behind many hosting providers' egress firewalls), the catch returned
  // 500 with no X-Client-Session header, the frontend fell back to a fake
  // 'sess_<timestamp>' id, and every subsequent /api/* call came back 401,
  // surfacing as the "reinitiate session" overlay.
  //
  // The login flow already warms the cookie jar via auth.js, so warming it
  // here in the background is best-effort only.
  const { sessionId, client } = createClientSession()

  res.set('X-Client-Session', sessionId)
  res.json({ sessionId, message: 'Session created' })

  client.get('https://student.srmap.edu.in/srmapstudentcorner/StudentLoginPage')
    .catch((err) => console.warn('Background SRM warmup failed:', err.message))
})


const PORT = 3000

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`)
})
