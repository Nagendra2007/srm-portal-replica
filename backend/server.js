import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import authRoutes from './routes/auth.js'
import portalRoutes from './routes/portal.js'
import { createClientSession } from './services/clientSessionStore.js'

// import.meta.url is how ES modules get their own file path (there's
// no __dirname built in like there is in CommonJS) — these two lines
// reconstruct it so we can point express.static at a folder reliably,
// regardless of which directory the process is started from.
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()

app.use(cors({
  exposedHeaders: ['X-Client-Session']
}))
app.use(express.json())

// Serves login.html (and anything else you later add) as static
// files from the frontend folder. Once this is deployed, your
// frontend and backend live at the same URL — no more CORS between
// two different origins, no more hardcoded localhost.
app.use(express.static(path.join(__dirname, '../frontend')))

// express.static only auto-serves a file named index.html when you
// hit "/" — since our file is login.html, "/" wouldn't match
// anything without this explicit route, and Express would report
// "Cannot GET /" even though the file genuinely exists.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/login.html'))
})

app.use('/api', authRoutes)
app.use('/api', portalRoutes)

// Moved under /api to sit alongside the rest of your endpoints,
// now that '/' itself is reserved for serving login.html.
app.get('/api/session', async (req, res) => {
  try {
    const { sessionId, client } = createClientSession()

    await client.get('https://student.srmap.edu.in/srmapstudentcorner/StudentLoginPage')

    res.set('X-Client-Session', sessionId)
    res.json({ message: 'Session created' })
  } catch (error) {
    console.error('Session creation error:', error.message)
    res.status(500).json({ message: 'Failed to create session' })
  }
})

// Hosting platforms (Render, Railway, etc.) assign their own port and
// tell you what it is via process.env.PORT — hardcoding 5000 would
// break in production. Falls back to 5000 for local development.
const PORT = process.env.PORT || 5000

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})