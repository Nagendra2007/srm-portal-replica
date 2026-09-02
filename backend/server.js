import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import authRoutes from './routes/auth.js'
import portalRoutes from './routes/portal.js'
import { createClientSession } from './services/clientSessionStore.js'


const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()

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


const PORT = process.env.PORT || 3000

app.listen(PORT,"0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`)
})
