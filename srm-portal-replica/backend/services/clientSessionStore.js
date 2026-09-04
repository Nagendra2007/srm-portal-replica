import crypto from 'crypto'
import axios from 'axios'
import { CookieJar } from 'tough-cookie'
import { wrapper } from 'axios-cookiejar-support'

const sessions = new Map()

// FIX: hard cap on concurrent sessions. Previously unbounded — anyone
// could loop GET /api/session and create unlimited cookie jars until the
// 768 MB heap died. Oldest-by-lastUsed is evicted when the cap is hit.
const MAX_SESSIONS = 500
const SESSION_TTL_MS = 30 * 60 * 1000

// FIX: no request ever had a timeout. One hung SRM request used to block
// the whole serialized queue for that session forever.
const REQUEST_TIMEOUT_MS = 15000

const generateSessionId = () => crypto.randomBytes(32).toString('hex')

const createAxiosClient = () => {
  const jar = new CookieJar()

  const client = wrapper(
    axios.create({
      jar,
      withCredentials: true,
      maxRedirects: 0,
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
      // Cap response size so a hostile/broken upstream can't balloon the heap.
      maxContentLength: 12 * 1024 * 1024,
      maxBodyLength: 12 * 1024 * 1024
    })
  )

  // Serialize all requests on this client sequentially to avoid JSP
  // session/cookie collisions on the SRM portal.
  let activePromise = Promise.resolve()
  const originalGet = client.get.bind(client)
  const originalPost = client.post.bind(client)

  client.get = (...args) => {
    const next = activePromise.then(() => originalGet(...args))
    activePromise = next.catch(() => {})
    return next
  }

  client.post = (...args) => {
    const next = activePromise.then(() => originalPost(...args))
    activePromise = next.catch(() => {})
    return next
  }

  return client
}

const evictOldestIfFull = () => {
  if (sessions.size < MAX_SESSIONS) return

  let oldestKey = null
  let oldestUsed = Infinity

  for (const [id, session] of sessions) {
    if (session.lastUsed < oldestUsed) {
      oldestUsed = session.lastUsed
      oldestKey = id
    }
  }

  if (oldestKey) sessions.delete(oldestKey)
}

export const createClientSession = () => {
  evictOldestIfFull()

  const sessionId = generateSessionId()
  const client = createAxiosClient()

  sessions.set(sessionId, {
    client,
    username: null,
    createdAt: Date.now(),
    lastUsed: Date.now(),
    loginPageVisited: false,
    // FIX: cache the student's internal id + photo URL per session so
    // /api/att stops re-scraping the dashboard on every single call.
    studentId: null,
    photoUrl: undefined
  })

  return { sessionId, client }
}

// Every route that uses this should call getClientSession, never read the
// sessions Map directly — keeps the "touch lastUsed on every use"
// behaviour in one place.
export const getClientSession = (sessionId) => {
  if (!sessionId || typeof sessionId !== 'string') return null

  const session = sessions.get(sessionId)
  if (!session) return null

  session.lastUsed = Date.now()
  return session
}

// FIX: went through getClientSession instead of touching the Map
// directly, which is what the comment above always claimed happened.
export const setSessionUsername = (sessionId, username) => {
  const session = getClientSession(sessionId)
  if (session) session.username = username
}

export const deleteClientSession = (sessionId) => {
  sessions.delete(sessionId)
}

export const sessionCount = () => sessions.size

const sweep = setInterval(() => {
  const now = Date.now()
  for (const [sessionId, session] of sessions) {
    if (now - session.lastUsed > SESSION_TTL_MS) sessions.delete(sessionId)
  }
}, 5 * 60 * 1000)

// FIX: unref so this timer can't hold the process open on shutdown.
sweep.unref?.()
