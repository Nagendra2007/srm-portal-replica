import axios from 'axios'


// NOTE: The API key must be supplied via the OPENROUTER_API_KEY environment
// variable. There is no fallback in source — hard-coding it here would leak
// the key to anyone with read access to the repo, and the previous literal
// got rotated more than once because of that.
//
// The default model is the free tier of minimax/minimax-m3. Free-tier keys are
// rate-limited aggressively on OpenRouter (HTTP 429), which surfaces to the
// student as "rate-limited — try again in a moment". If that becomes a real
// problem, set OPENROUTER_MODEL to a paid model in the env.
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'minimax/minimax-m3:free'

export const askOpenRouter = async (systemPrompt, messages) => {
  const apiKey = process.env.API_KEY

  if (!apiKey) {
    const err = new Error('Ask AI is not configured on the server (missing OPENROUTER_API_KEY)')
    err.statusCode = 503
    throw err
  }

  let response
  try {
    response = await axios.post(
      OPENROUTER_URL,
      {
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages
        ],
        temperature: 0.2,
        // 500 used to clip the model on longer factual answers (especially
        // when the system prompt is large) and produced empty replies that
        // surfaced as a 502 to the student. 800 leaves headroom without
        // encouraging verbose output.
        max_tokens: 800
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.PUBLIC_APP_URL || 'https://srmsync.in',
          'X-Title': 'SRMSync'
        },
        timeout: 30_000
      }
    )
  } catch (error) {
    const status = error.response?.status
    const upstreamMsg = error.response?.data?.error?.message || error.response?.data?.message

    let message
    if (status === 429) {
      message = 'Ask AI is rate-limited right now — try again in a moment.'
    } else if (status === 401 || status === 403) {
      message = 'Ask AI rejected the server API key. The OPENROUTER_API_KEY env var on the deploy is missing, invalid, or revoked.'
    } else if (status && status >= 500) {
      message = `Ask AI's model provider returned ${status}${upstreamMsg ? `: ${upstreamMsg}` : ''}.`
    } else if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
      message = 'Ask AI could not resolve openrouter.ai from the deploy host (DNS blocked). Check egress firewall / DNS.'
    } else if (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
      message = `Ask AI could not reach openrouter.ai from the deploy host (${error.code}). Egress to openrouter.ai is likely blocked.`
    } else if (!status) {
      message = `Ask AI could not reach the model provider: ${error.message}`
    } else {
      message = `Ask AI returned ${status}${upstreamMsg ? `: ${upstreamMsg}` : ''}.`
    }

    // Always log the underlying cause so the deploy console tells you what
    // actually went wrong, even if the user only sees the sanitized message.
    console.error('Ask AI upstream failure:', { code: error.code, status, upstreamMsg, raw: error.message })

    const wrapped = new Error(message)
    wrapped.statusCode = status && status < 500 ? status : 502
    throw wrapped
  }

  const reply = response.data?.choices?.[0]?.message?.content
  if (!reply || !reply.trim()) {
    const err = new Error('Ask AI returned an empty response')
    err.statusCode = 502
    throw err
  }

  return reply.trim()
}
