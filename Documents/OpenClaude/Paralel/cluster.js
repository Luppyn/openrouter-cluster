const https = require('https')
const config = require('./config')
const Metrics = require('./metrics')

class Cluster {
  constructor(apiKeys) {
    this.apiKeys = apiKeys
    this.metrics = new Metrics(apiKeys)

    // Reusable HTTPS agent with keep-alive
    this.agent = new https.Agent({
      keepAlive: config.httpKeepAlive,
      maxSockets: config.maxSockets,
      maxFreeSockets: 20,
      timeout: config.requestTimeout,
    })
  }

  // Pick the key with least active requests
  pickKey() {
    const available = this.apiKeys
      .map(k => ({ key: k, active: this.metrics.keyStats[k].activeRequests }))
      .filter(x => x.active < config.maxConcurrentPerKey && !this.metrics.keyStats[x.key].isSlow)

    if (available.length === 0) {
      // Fallback: pick least busy among all keys
      return this.apiKeys.reduce((a, k) =>
        this.metrics.keyStats[k].activeRequests < this.metrics.keyStats[a].activeRequests ? k : a
      )
    }

    return available.reduce((a, b) => a.active <= b.active ? a : b).key
  }

  // Stream a single request, forward tokens as they arrive via callbacks
  stream(key, messages, onToken, onError, onComplete, opts = {}) {
    const startTime = Date.now()
    let tokens = 0
    let responded = false
    let accumulatedToolCalls = []

    const body = JSON.stringify({
      model: opts.model || config.model,
      messages,
      max_tokens: opts.max_tokens || config.maxTokensPerRequest,
      stream: true,
      tools: opts.tools,
      temperature: opts.temperature,
    })

    const options = {
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost',
        'X-Title': 'openrouter-cluster',
      },
      agent: this.agent,
      timeout: config.requestTimeout,
    }

    this.metrics.requestStart(key)

    const req = https.request(options, (res) => {
      if (res.statusCode === 429 && config.retryOnRateLimit) {
        opts.onResponse?.(key)
        req.destroy()
        this.metrics.retry(key)
        this.metrics.requestEnd(key)
        return scheduleRetry(() => this.stream(key, messages, onToken, onError, onComplete), config.retryDelay, config.maxRetries)
      }

      if (res.statusCode !== 200) {
        let errData = ''
        res.on('data', c => errData += c)
        res.on('end', () => {
          this.metrics.error(key)
          this.metrics.requestEnd(key)
          onError?.(`HTTP ${res.statusCode}: ${errData}`)
        })
        return
      }

      let buffer = ''

      res.on('data', (chunk) => {
        if (!responded) {
          responded = true
          opts.onResponse?.(key)
        }

        if (tokens === 0) {
          this.metrics.firstToken(key, Date.now() - startTime)
        }

        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() // keep incomplete line in buffer

        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed === '' || trimmed === 'data: [DONE]') continue
          if (!trimmed.startsWith('data: ')) continue

          try {
            const json = JSON.parse(trimmed.slice(6))
            const delta = json.choices?.[0]?.delta
            if (delta?.content) {
              tokens++
              onToken?.(delta.content)
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                // Merge fragments by index
                if (!accumulatedToolCalls[tc.index]) {
                  accumulatedToolCalls[tc.index] = { index: tc.index, id: tc.id, type: tc.type, function: { name: tc.function?.name || '', arguments: '' } }
                }
                if (tc.function?.name) accumulatedToolCalls[tc.index].function.name = tc.function.name
                if (tc.function?.arguments) accumulatedToolCalls[tc.index].function.arguments += tc.function.arguments
                if (tc.id) accumulatedToolCalls[tc.index].id = tc.id
              }
            }
          } catch {
            // skip malformed SSE
          }
        }
      })

      res.on('end', () => {
        this.metrics.token(key, tokens)
        this.metrics.requestEnd(key)
        const tcs = accumulatedToolCalls.filter(Boolean)
        opts.onToolCalls?.(key, tcs)
        onComplete?.({ tokens, toolCalls: tcs })
      })

      res.on('error', (err) => {
        this.metrics.error(key)
        this.metrics.requestEnd(key)
        onError?.(err.message)
      })
    })

    req.on('error', (err) => {
      this.metrics.error(key)
      this.metrics.requestEnd(key)
      onError?.(err.message)
    })

    req.on('timeout', () => {
      req.destroy()
      this.metrics.error(key)
      this.metrics.requestEnd(key)
      onError?.('Request timeout')
    })

    req.write(body)
    req.end()

    return req
  }

  // Split a prompt into N chunks and send each chunk with a different key in parallel
  parallelStream(messages, onToken, onError, onComplete) {
    const totalKeys = this.apiKeys.length
    const chunks = this._splitMessages(messages, totalKeys)

    let completed = 0
    let totalTokens = 0

    chunks.forEach((chunkMessages, i) => {
      const key = this.apiKeys[i]
      const prefix = chunkMessages.length > 0 ? `[Chunk ${i + 1}/${totalKeys}] ` : ''

      this.stream(key, chunkMessages,
        (token) => onToken(prefix + token),
        (err) => { this._handleChunkError(key, chunkMessages, i, onToken, onError, prefix, completed++, chunks.length) },
        (result) => {
          totalTokens += result.tokens
          completed++
          if (completed === totalKeys) {
            onComplete?.({ tokens: totalTokens, chunks: totalKeys })
          }
        }
      )
    })
  }

  // Split messages across keys round-robin
  _splitMessages(messages, n) {
    const chunks = Array.from({ length: n }, () => [])
    for (let i = 0; i < messages.length; i++) {
      chunks[i % n].push(messages[i])
    }
    // If single message, all keys get it (same prompt, different outputs)
    if (messages.length === 1 && n > 1) {
      const msg = messages[0]
      for (let i = 0; i < n; i++) {
        chunks[i] = [msg]
      }
    }
    return chunks
  }

  _handleChunkError(key, messages, index, onToken, onError, prefix, completed, total) {
    onError?.(`Chunk ${index + 1} failed, key: ${key.slice(-6)}`)
    completed++
    if (completed === total) {
      onComplete?.({ tokens: 0, chunks: total, partial: true })
    }
  }

  // Race: dispatch to all keys, use first response, cancel the rest
  raceStream(messages, onToken, onError, onComplete, opts = {}) {
    let firstTokenKey = null
    let raceFinished = false
    const requests = {}
    let allFailed = true
    const log = opts.logger || (() => {})

    const declareWinner = (winKey) => {
      if (raceFinished) return
      firstTokenKey = winKey
      raceFinished = true
      log(`[race] Winner: key ${winKey.slice(-6)}`)

      // Cancel competitors
      for (const [key, req] of Object.entries(requests)) {
        if (key !== winKey && req && !req.destroyed) {
          log(`[race] Cancelled: key ${key.slice(-6)}`)
          req.destroy()
        }
      }
    }

    const raceCompleteHandler = (key, result) => {
      log(`[race] Complete key ${key.slice(-6)}: ${result.tokens} tokens, ${result.toolCalls?.length || 0} tool_calls`)
      allFailed = false
      if (key === firstTokenKey) {
        log(`[race] Sending result to client (winner)`)
        onComplete?.(result)
      } else {
        log(`[race] Ignoring late result from key ${key.slice(-6)}`)
      }
    }

    const raceErrorHandler = (key, err) => {
      log(`[race] Error key ${key.slice(-6)}: ${err}`)
      if (key === firstTokenKey) {
        onError?.(err)
      } else if (!firstTokenKey) {
        // Check if ALL competing requests failed
        const stillRacing = this.apiKeys.filter(k => {
          const r = requests[k]
          return r && !r.destroyed && r.writableEnded !== true
        })
        if (stillRacing.length === 0) {
          onError?.('All keys failed: ' + err)
        }
      }
    }

    // Dispatch one request per key (same message, races for first token)
    const raceOpts = {
      ...opts,
      onResponse: (key) => {
        if (!firstTokenKey) declareWinner(key)
      }
    }

    log(`[race] Starting race for ${this.apiKeys.length} keys`)

    for (const key of this.apiKeys) {
      const req = this.stream(key, messages,
        (token) => {
          if (key === firstTokenKey) onToken(token)
        },
        (err) => raceErrorHandler(key, err),
        (result) => raceCompleteHandler(key, result),
        raceOpts
      )
      requests[key] = req
    }
  }

  getMetrics() {
    return {
      aggregate: this.metrics.getAggregated(),
      keys: this.metrics.getDetail(),
    }
  }
}

function scheduleRetry(fn, delay, maxRetries) {
  setTimeout(fn, delay)
}

module.exports = Cluster
