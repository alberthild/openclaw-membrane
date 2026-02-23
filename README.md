# @vainplex/openclaw-membrane

Membrane gRPC bridge for OpenClaw — persistent episodic memory via [GustyCube/membrane](https://github.com/GustyCube/membrane) sidecar.

## Features

- **Event Ingestion** — Writes OpenClaw events (messages, tool calls, facts, outcomes) to Membrane via gRPC
- **`membrane_search` Tool** — LLM-callable tool for episodic memory queries (gRPC Retrieve with rehearsal)
- **Auto-Context Injection** — `before_agent_start` hook injects `<membrane-context>` into system prompt
- **Reliability Buffer** — Ring buffer with retry logic, exponential backoff, and max 10 retries
- **All 4 Memory Types** — Parses episodic, semantic, competence, and working memory

## Installation

```bash
npm install @vainplex/openclaw-membrane
```

Or install from source:
```bash
cd ~/.openclaw/extensions/openclaw-membrane
npm install
```

## Prerequisites

- [Membrane sidecar](https://github.com/GustyCube/membrane) running (Docker or native)
- gRPC endpoint accessible (default: `localhost:50051`)

## Configuration

### openclaw.json

```json
{
  "plugins": {
    "entries": {
      "openclaw-membrane": {
        "enabled": true
      }
    }
  }
}
```

### External Config

Create `~/.openclaw/plugins/openclaw-membrane/config.json`:

```json
{
  "grpc_endpoint": "localhost:50052",
  "buffer_size": 1000,
  "default_sensitivity": "low",
  "retrieve_enabled": true,
  "retrieve_limit": 5,
  "retrieve_min_salience": 0.1,
  "retrieve_max_sensitivity": "medium",
  "retrieve_timeout_ms": 10000
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `grpc_endpoint` | string | `localhost:50051` | Membrane gRPC address |
| `buffer_size` | number | `1000` | Ring buffer capacity for event queue |
| `default_sensitivity` | string | `low` | Default sensitivity for events |
| `retrieve_enabled` | boolean | `true` | Enable auto-context injection hook |
| `retrieve_limit` | number | `5` | Max memories to inject per turn |
| `retrieve_min_salience` | number | `0.1` | Minimum salience threshold for Retrieve |
| `retrieve_max_sensitivity` | string | `medium` | Max sensitivity level for Retrieve |
| `retrieve_timeout_ms` | number | `2000` | gRPC Retrieve timeout in ms |

### Authentication

Set `MEMBRANE_API_KEY` environment variable for gRPC auth (optional, depends on Membrane config).

## Architecture

```
OpenClaw Events → mapping.ts → buffer.ts → gRPC IngestEvent → Membrane
                                                                    ↓
User Prompt → index.ts (hook) → gRPC Retrieve → parser.ts → <membrane-context>
                                                                    ↓
LLM Tool Call → index.ts (tool) → gRPC Retrieve → parser.ts → Results
```

**Modules:**
| File | Lines | Purpose |
|------|-------|---------|
| `index.ts` | 248 | Plugin entry, wiring, tool + hook registration |
| `types.ts` | 132 | TypeScript interfaces and config defaults |
| `parser.ts` | 136 | Shared Membrane record parser (all 4 types) |
| `mapping.ts` | 151 | OpenClaw event → Membrane gRPC payload mapping |
| `buffer.ts` | 120 | Ring buffer + reliability manager with retries |
| `client.ts` | 71 | gRPC client wrapper |

## Tests

```bash
npx vitest run
```

**44 tests** across 4 files:
- `test/parser.test.ts` — 15 tests (record parsing, all memory types, edge cases)
- `test/mapping.test.ts` — 15 tests (sensitivity, event mapping, all 6 types)
- `test/buffer.test.ts` — 6 tests (ring buffer, retry, flush)
- `test/config.test.ts` — 8 tests (validation, type rejection, defaults)

## Vainplex OpenClaw Plugin Suite

| # | Plugin | npm | Status |
|---|--------|-----|--------|
| 1 | [@vainplex/openclaw-nats-eventstore](https://github.com/alberthild/openclaw-nats-eventstore) | `@vainplex/openclaw-nats-eventstore` | ✅ Published |
| 2 | [@vainplex/openclaw-cortex](https://github.com/alberthild/openclaw-cortex) | `@vainplex/openclaw-cortex` | ✅ Published |
| 3 | [@vainplex/openclaw-governance](https://github.com/alberthild/openclaw-governance) | `@vainplex/openclaw-governance` | ✅ Published |
| 4 | [@vainplex/openclaw-knowledge-engine](https://github.com/alberthild/openclaw-knowledge-engine) | `@vainplex/openclaw-knowledge-engine` | ✅ Published |
| 5 | **@vainplex/openclaw-membrane** | `@vainplex/openclaw-membrane` | 🆕 This plugin |

## License

MIT
