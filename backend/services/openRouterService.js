import axios from 'axios'



const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'minimax/minimax-m3:free'

export const askOpenRouter = async (systemPrompt, messages) => {
  const apiKey = process.env.API_KEY;

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
        max_tokens: 500
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
    const wrapped = new Error(
      status === 429
        ? 'Ask AI is rate-limited right now — try again in a moment.'
        : 'Ask AI could not reach the model provider.'
    )
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
