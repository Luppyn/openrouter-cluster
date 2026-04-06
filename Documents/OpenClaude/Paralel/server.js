require('dotenv').config()
const Fastify = require('fastify')
const path = require('path')
const fs = require('fs')
const config = require('./config')
const Cluster = require('./cluster')

// Ensure logs directory exists
const logsDir = path.join(__dirname, 'logs')
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true })

// Log file with date
const logFile = path.join(logsDir, `server-${new Date().toISOString().slice(0, 10)}.log`)
const logStream = fs.createWriteStream(logFile, { flags: 'a' })

function log(msg) {
  const ts = new Date().toISOString()
  const line = `[${ts}] ${msg}`
  console.log(line)
  logStream.write(line + '\n')
}

// Parse API keys from .env
const apiKeys = (process.env.OPENROUTER_API_KEYS || '')
  .split(',')
  .map(k => k.trim())
  .filter(k => k.length > 0)

if (apiKeys.length === 0) {
  console.error('ERROR: No API keys found in .env')
  process.exit(1)
}

log(`Loaded ${apiKeys.length} API key(s)`)

const cluster = new Cluster(apiKeys)

const fastify = Fastify({
  logger: {
    level: 'debug',
    stream: {
      write: (msg) => {
        const ts = new Date().toISOString()
        logStream.write(`[FASTIFY] ${ts} ${msg}`)
        process.stderr.write(`[FASTIFY] ${msg}`)
      },
    },
  },
  http2: false,
})

// Serve static files (dashboard)
fastify.register(require('@fastify/static'), {
  root: path.join(__dirname, 'public'),
})

// Main SSE streaming endpoint
fastify.post('/chat', async (request, reply) => {
  const { messages } = request.body || {}

  if (!messages || !Array.isArray(messages)) {
    return reply.code(400).send({ error: 'messages array required' })
  }

  log(`[chat] Incoming request: ${JSON.stringify(request.body)}`)

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  reply.raw.flushHeaders()

  const sendEvent = (event, data) => {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  cluster.raceStream(messages,
    (token) => sendEvent('token', { content: token }),
    (err) => { log(`[chat] Error: ${err}`); sendEvent('error', { message: String(err) }) },
    (result) => {
      log(`[chat] Done: ${result.tokens} tokens`)
      sendEvent('done', result)
      reply.raw.end()
    }
  )
})

// Single key stream endpoint
fastify.post('/chat/single', async (request, reply) => {
  const { messages, keyIndex } = request.body || {}

  if (!messages || !Array.isArray(messages)) {
    return reply.code(400).send({ error: 'messages array required' })
  }

  const key = apiKeys[keyIndex || 0]
  if (!key) return reply.code(400).send({ error: 'Invalid keyIndex' })

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  reply.raw.flushHeaders()

  const sendEvent = (event, data) => {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  cluster.stream(key, messages,
    (token) => sendEvent('token', { content: token }),
    (err) => sendEvent('error', { message: String(err) }),
    (result) => {
      sendEvent('done', result)
      reply.raw.end()
    }
  )
})

function genId(prefix) {
  return prefix + Math.random().toString(36).slice(2, 12) + Date.now().toString(36)
}

// OpenAI-compatible endpoint for openclaude
fastify.post('/v1/chat/completions', async (request, reply) => {
  const { model, messages, functions, function_call, tools, tool_choice, temperature, max_tokens, stream } = request.body || {}

  if (!messages || !Array.isArray(messages)) {
    log(`[v1] Bad request: ${JSON.stringify(request.body)}`)
    return reply.code(400).send({ error: { message: 'messages array required', type: 'invalid_request_error' } })
  }

  log(`[v1] Request - model: ${model || 'none'}, messages: ${messages.length}, stream: ${stream}, body: ${JSON.stringify(request.body)}`)

  if (stream) {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    reply.raw.flushHeaders()

    const respId = genId('chatcmpl-')
    const created = Math.floor(Date.now() / 1000)

    const opts = { max_tokens, model, tools, temperature, logger: msg => log(msg) }

    cluster.raceStream(messages,
      (token) => {
        reply.raw.write(`data: ${JSON.stringify({
          id: respId,
          object: 'chat.completion.chunk',
          created,
          model: model || config.model,
          choices: [{ index: 0, delta: { content: token }, finish_reason: null }],
          usage: { completion_tokens: 0 },
        })}\n\n`)
      },
      (err) => {
        log(`[v1] Streaming error: ${err}`)
        reply.raw.write(`data: ${JSON.stringify({
          error: { message: String(err), type: 'api_error' }
        })}\n\n`)
        reply.raw.end()
      },
      (result) => {
        if (result.toolCalls && result.toolCalls.length > 0) {
          log(`[v1] Done: ${result.tokens} tokens, ${result.toolCalls.length} tool_call(s)`)
          // Send tool_calls as OpenAI streaming format
          for (const tc of result.toolCalls) {
            const tcPayload = JSON.stringify({
              name: tc.function?.name || '',
              args: tc.function?.arguments || '{}',
            })
            log(`[v1]   -> tool_call: ${tcPayload.slice(0, 300)}`)
            reply.raw.write(`data: ${JSON.stringify({
              id: respId,
              object: 'chat.completion.chunk',
              created,
              model: model || config.model,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: tc.index,
                    id: tc.id || `call_${tc.index}`,
                    type: 'function',
                    function: {
                      name: tc.function?.name || '',
                      arguments: tc.function?.arguments || '{}',
                    }
                  }]
                },
                finish_reason: null,
              }],
            })}\n\n`)
          }
          reply.raw.write(`data: ${JSON.stringify({
            id: respId,
            object: 'chat.completion.chunk',
            created,
            model: model || config.model,
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 0, completion_tokens: result.tokens, total_tokens: result.tokens },
            done: true,
          })}\n\n`)
        } else {
          log(`[v1] Done: ${result.tokens} tokens`)
          reply.raw.write(`data: ${JSON.stringify({
            id: respId,
            object: 'chat.completion.chunk',
            created,
            model: model || config.model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: result.tokens, total_tokens: result.tokens },
            done: true,
          })}\n\n`)
        }
        reply.raw.write('data: [DONE]\n\n')
        reply.raw.end()
      },
      opts
    )
  } else {
    let fullContent = ''

    return new Promise((resolve, reject) => {
      cluster.raceStream(messages,
        (token) => { fullContent += token },
        (err) => { log(`[v1] Non-stream error: ${err}`); reject(new Error(err)) },
        (result) => {
          log(`[v1] Non-stream done: ${result.tokens} tokens, toolCalls: ${result.toolCalls ? result.toolCalls.length : 0}`)
          const respId = genId('chatcmpl-')
          const created = Math.floor(Date.now() / 1000)
          const toolCalls = result.toolCalls || []
          const finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop'
          resolve({
            id: respId,
            object: 'chat.completion',
            created,
            model: model || config.model,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: fullContent || null,
                tool_calls: toolCalls.length > 0 ? toolCalls.map(tc => ({
                  id: tc.id || `call_${tc.index}`,
                  type: 'function',
                  function: {
                    name: tc.function?.name || '',
                    arguments: tc.function?.arguments || '{}',
                  }
                })) : undefined,
              },
              finish_reason: finishReason,
              logprobs: null,
            }],
            usage: {
              prompt_tokens: 0,
              completion_tokens: result.tokens,
              total_tokens: result.tokens,
            },
          })
        }
      )
    })
  }
})

// /v1/models endpoint
fastify.get('/v1/models', async (request, reply) => {
  log('[v1] Models list requested')
  return {
    object: 'list',
    data: [{
      id: config.model,
      object: 'model',
      owned_by: 'openrouter',
    }],
  }
})

// Metrics endpoint
fastify.get('/metrics', async () => cluster.getMetrics())

// Health check
fastify.get('/health', async () => {
  log('[health] Health check')
  return {
    status: 'ok',
    keys: apiKeys.length,
    model: config.model,
  }
})

const start = async () => {
  try {
    await fastify.listen({ port: config.port, host: config.host })
    log(`Server running at http://localhost:${config.port}`)
    log(`Dashboard: http://localhost:${config.port}/`)
    log(`Logs saved to: ${logFile}`)
  } catch (err) {
    console.error(err)
    process.exit(1)
  }
}

start()
