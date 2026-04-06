module.exports = {
  // Modelo e API
  model: 'qwen/qwen3.6-plus:free',
  baseUrl: 'https://openrouter.ai/api/v1',
  maxTokensPerRequest: 4096,
  requestTimeout: 300000,

  // Servidor
  port: 3000,
  host: '0.0.0.0',

  // Cluster
  maxConcurrentPerKey: 3,
  retryOnRateLimit: true,
  retryDelay: 2000,
  maxRetries: 5,
  slowKeyThresholdMs: 5000,

  // HTTP optimizations
  httpKeepAlive: true,
  maxSockets: 50,
  tcpNoDelay: true,
}
