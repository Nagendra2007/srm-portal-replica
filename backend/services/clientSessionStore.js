import crypto from 'crypto'
import axios from 'axios'
import { CookieJar } from 'tough-cookie'
import { wrapper } from 'axios-cookiejar-support'

const sessions = new Map()

const generateSessionId = () => {
  return crypto.randomBytes(32).toString('hex')
}

const createAxiosClient = () => {
  const jar = new CookieJar()

  const client = wrapper(
    axios.create({
      jar,
      withCredentials: true,
      maxRedirects: 0,
      validateStatus: () => true
    })
  )

  // Serialize all requests on this client sequentially to avoid JSP session/cookie collisions on the SRM portal
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

export const createClientSession = () => {
  const sessionId = generateSessionId()
  const client = createAxiosClient()

  sessions.set(sessionId, {
    client,
    username: null,
    createdAt: Date.now(),
    lastUsed: Date.now(),
    loginPageVisited: false
  })

  return { sessionId, client }
}

// Every route that uses this should call getClientSession, never
// read the sessions Map directly — this keeps the "touch lastUsed
// on every use" behavior in one place instead of duplicated everywhere.
export const getClientSession = (sessionId) => {
  if (!sessionId) {
    return null
  }

  const session = sessions.get(sessionId)

  if (!session) {
    return null
  }

  session.lastUsed = Date.now()
  return session
}

// Called once, right after a real SRM login succeeds — attaches the
// student's registration number to their existing session so later
// routes (profile/timetable) know whose data to cache without the
// student having to send it again on every request.
export const setSessionUsername = (sessionId, username) => {
  const session = sessions.get(sessionId)

  if (session) {
    session.username = username
  }
}

export const deleteClientSession = (sessionId) => {
  sessions.delete(sessionId)
}

setInterval(() => {
  const now = Date.now()

  for (const [sessionId, session] of sessions) {
    const age = now - session.lastUsed
    if (age > 30 * 60 * 1000) {
      sessions.delete(sessionId)
    }
  }
}, 5 * 60 * 1000)
