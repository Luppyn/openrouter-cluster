# OpenRouter Cluster

High-performance OpenRouter API cluster with **race-based deduplication** — dispatch requests to multiple API keys and return only the first response.

## Features

- **Race mechanism** — send the same request to all configured keys, use the first response, cancel the rest
- **Tool call support** — fully compatible with OpenAI streaming format (tool_calls, function calling)
- **OpenAI-compatible endpoint** — works with any OpenAI-compatible client (OpenClaude, Ollama WebUI, Continue, etc.)
- **Custom SSE endpoint** — lightweight `/chat` endpoint for direct integration
- **Dashboard & metrics** — real-time stats per key
- **Retry on rate limit** — automatic retry with configurable delay
- **Detailed logging** — per-day log files with race winner, cancelled keys, and tool call details

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure API keys
cp .env.example .env
# Edit .env with your OpenRouter keys (comma-separated)

# 3. Start server
npm start
# Server runs at http://localhost:3000
```

## Endpoints

| Endpoint | Method | Content-Type | Description |
|---|---|---|---|
| `/v1/chat/completions` | POST | application/json | OpenAI-compatible (streaming + non-streaming) |
| `/chat` | POST | application/json | Custom SSE stream (race across all keys) |
| `/chat/single` | POST | application/json | Single key stream |
| `/v1/models` | GET | | List available model |
| `/metrics` | GET | | Cluster statistics per key |
| `/health` | GET | | Health check |

## Use with OpenAI-compatible clients

Set your client to use `http://localhost:3000/v1` as the base URL:

```
OPENAI_BASE_URL=http://localhost:3000/v1
OPENAI_API_KEY=anything
```

Works with: OpenClaude, Continue, Cursor, Ollama WebUI, LangChain, and any client that supports the OpenAI Chat Completions API.

## Configuration

Edit `config.js`:

```js
module.exports = {
  model: 'qwen/qwen3.6-plus:free',
  maxTokensPerRequest: 4096,
  port: 3000,
  slowKeyThresholdMs: 5000,
  // ...
}
```

## Architecture

```
Client (any OpenAI-compatible)
    |
    v
server.js  →  cluster.raceStream()  →  3x OpenRouter API keys
    |                                      |
    v                                      v
SSE response back                   First response wins,
with tool_calls                    others are cancelled
```

## License

MIT
