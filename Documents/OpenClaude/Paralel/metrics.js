const EventEmitter = require('events')

class Metrics extends EventEmitter {
  constructor(keys) {
    super()
    this.startTime = Date.now()
    this.totalTokensProcessed = 0
    this.totalRequests = 0
    this.totalErrors = 0
    this.totalRetries = 0

    this.keys = keys
    this.keyStats = {}
    for (const key of keys) {
      this.keyStats[key] = {
        activeRequests: 0,
        totalTokens: 0,
        totalRequests: 0,
        totalErrors: 0,
        totalRetries: 0,
        totalLatency: 0,   // time to first token
        requestCount: 0,
        lastTTFT: 0,
        lastTPS: 0,
        isSlow: false,
        lastActive: 0,
      }
    }
  }

  requestStart(key) {
    const s = this.keyStats[key]
    s.activeRequests++
    s.totalRequests++
    s.lastActive = Date.now()
    this.totalRequests++
  }

  firstToken(key, elapsed) {
    const s = this.keyStats[key]
    s.lastTTFT = elapsed
    s.totalLatency += elapsed
    s.requestCount++
  }

  token(key, count) {
    const s = this.keyStats[key]
    s.totalTokens += count
    this.totalTokensProcessed += count
    s.lastTPS = s.totalTokens / (s.requestCount || 1)
  }

  requestEnd(key) {
    this.keyStats[key].activeRequests--
  }

  error(key) {
    this.keyStats[key].totalErrors++
    this.totalErrors++
  }

  retry(key) {
    this.keyStats[key].totalRetries++
    this.totalRetries++
  }

  markSlow(key, slow) {
    this.keyStats[key].isSlow = slow
  }

  getAggregated() {
    const uptime = (Date.now() - this.startTime) / 1000
    const totalTPS = uptime > 0 ? this.totalTokensProcessed / uptime : 0
    const slowKeys = this.keys.filter(k => this.keyStats[k].isSlow).length

    return {
      uptime,
      totalTokensProcessed: this.totalTokensProcessed,
      totalRequests: this.totalRequests,
      totalErrors: this.totalErrors,
      totalRetries: this.totalRetries,
      totalTPS: +totalTPS.toFixed(1),
      activeKeys: this.keys.length - slowKeys,
      totalKeys: this.keys.length,
    }
  }

  getDetail() {
    const detail = {}
    for (const key of this.keys) {
      const s = this.keyStats[key]
      const avgTTFT = s.requestCount > 0 ? (s.totalLatency / s.requestCount).toFixed(0) : 0
      detail['..' + key.slice(-6)] = {
        activeRequests: s.activeRequests,
        totalTokens: s.totalTokens,
        avgTTFT: +avgTTFT,
        lastTTFT: s.lastTTFT,
        isSlow: s.isSlow,
        errors: s.totalErrors,
        retries: s.totalRetries,
        lastActive: s.lastActive ? Date.now() - s.lastActive : 0,
      }
    }
    return detail
  }
}

module.exports = Metrics
