import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import authRoutes from './routes/auth.js'
import portalRoutes from './routes/portal.js'
import { terminateWorker } from './services/srmPortalService.js'

/*
 * dotenv was already a declared dependency but nothing ever loaded it, so
 * .env was silently ignored and every process.env lookup fell through to the
 * default. Both this and compression are optional-imported so the server
 * still boots against a stale node_modules.
 */
try {
  await import('dotenv/config')
} catch {
  console.warn('dotenv not installed — skipping .env file loading')
}

let compression = null
try {
  compression = (await import('compression')).default
} catch {
  console.warn('compression not installed — run `npm install compression` for ~80% smaller HTML responses')
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()

// Behind nginx, so req.ip must come from X-Forwarded-For or every client
// looks like 127.0.0.1 and the rate limiter throttles everyone as one bucket.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1))

// Don't advertise the framework.
app.disable('x-powered-by')

/*
 * PERFORMANCE: the single biggest win in the whole project.
 * frontend/login.html is 150 KB of inline CSS + JS and was served
 * uncompressed. gzip takes it to ~28 KB (81% smaller).
 */
if (compression) {
  app.use(compression({ threshold: 1024 }))
}

/*
 * Security headers, set directly so there's no new dependency. If you'd
 * rather have the maintained version of this, `helmet` covers the same ground
 * plus more.
 */
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff')
  res.set('X-Frame-Options', 'DENY')
  res.set('Referrer-Policy', 'no-referrer')
  res.set('Cross-Origin-Opener-Policy', 'same-origin')
  res.set('Permissions-Policy', 'geolocation=(), camera=(), microphone=()')

  // The frontend is a single file with inline <style> and <script>, so
  // 'unsafe-inline' is required until those are extracted. Even so, this
  // still blocks external script origins, which is what stops a stored-XSS
  // payload from calling home.
  res.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "object-src 'none'"
    ].join('; ')
  )

  next()
})

/*
 * CORS was wide open — `cors()` with no origin reflects any caller, so any
 * website could drive these endpoints. This app is served from the same
 * origin as its API, so no cross-origin access is needed at all by default.
 * Set CORS_ORIGINS=https://a.example,https://b.example to allow specific ones.
 */
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)

app.use(
  cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : false,
    exposedHeaders: ['X-Client-Session'],
    allowedHeaders: ['Content-Type', 'X-Client-Session'],
    methods: ['GET', 'POST']
  })
)

// Explicit limit — the payload here is a short username and password.
app.use(express.json({ limit: '16kb' }))

/*
 * PERFORMANCE: static assets had no cache headers, so the browser
 * re-validated on every navigation. login.html itself must stay
 * revalidate-always (it's the app shell and has no content hash), but
 * everything else can sit in cache.
 */
app.use(
  express.static(path.join(__dirname, '../frontend'), {
    etag: true,
    lastModified: true,
    maxAge: '30d',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('login.html')) {
        res.set('Cache-Control', 'no-cache')
      }
    }
  })
)

app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-cache')
  res.sendFile(path.join(__dirname, '../frontend/login.html'))
})

app.get('/healthz', (req, res) => res.json({ ok: true }))

app.use('/api', authRoutes)
app.use('/api', portalRoutes)

/*
 * REMOVED: server.js also defined `app.get('/api/session')` here. Because
 * app.use('/api', authRoutes) is registered first, that handler was
 * unreachable — Express matched the router every time. It was a second,
 * slightly different copy of the same endpoint (no OCR warm-up, no timeout),
 * which is exactly the kind of thing that gets edited by mistake later.
 */

app.use((req, res) => {
  res.status(404).json({ message: 'Not found' })
})

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message)
  if (res.headersSent) return next(err)
  res.status(500).json({ message: 'Internal server error' })
})

const PORT = process.env.PORT || 3000
const HOST = process.env.HOST || '0.0.0.0'

const server = app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`)
})

// Keep-alive tuning for sitting behind nginx.
server.keepAliveTimeout = 65_000
server.headersTimeout = 66_000

// The Tesseract worker holds a native/WASM handle; without this the process
// needed a SIGKILL to actually exit.
let shuttingDown = false

const shutdown = async (signal) => {
  if (shuttingDown) return
  shuttingDown = true

  console.log(`${signal} received — shutting down`)

  server.close(() => console.log('HTTP server closed'))

  try {
    await terminateWorker()
  } catch (e) {
    console.warn('Worker shutdown warning:', e.message)
  }

  setTimeout(() => process.exit(0), 3000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
