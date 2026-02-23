# @vainplex/openclaw-membrane

Membrane gRPC bridge for OpenClaw — persistent episodic memory via [GustyCube/membrane](https://github.com/GustyCube/membrane) sidecar.

**What it does:** Every conversation, tool call, and decision flows into Membrane's biological memory model. Memories decay over time. Frequently accessed ones grow stronger. Your agent remembers what matters and forgets what doesn't.

## Quick Start

### 1. Run Membrane sidecar

```bash
# Docker (recommended)
docker run -d --name membrane \
  -p 50051:50051 \
  -v membrane-data:/data \
  openclaw-membrane:local \
  membraned -config /app/config.yaml

# Or use docker-compose (see below)
```

<details>
<summary>docker-compose.yml</summary>

```yaml
services:
  membrane:
    image: openclaw-membrane:local
    container_name: membrane
    ports:
      - "50051:50051"
    volumes:
      - ./data:/data:rw
      - ./config.yaml:/app/config.yaml:ro
    entrypoint: ["membraned", "-config", "/app/config.yaml"]
    restart: unless-stopped
```

Minimal `config.yaml`:
```yaml
listen_addr: ":50051"
db_path: "/data/membrane.db"
storage_backend: "sqlite"
log_level: "info"
```
</details>

### 2. Install the plugin

```bash
# From npm
cd ~/.openclaw/extensions
mkdir openclaw-membrane && cd openclaw-membrane
npm install @vainplex/openclaw-membrane

# Or from source
git clone https://github.com/alberthild/openclaw-membrane.git
cd openclaw-membrane
npm install && npx tsc
cp -r dist/ ~/.openclaw/extensions/openclaw-membrane/dist/
cp openclaw.plugin.json package.json ~/.openclaw/extensions/openclaw-membrane/
cd ~/.openclaw/extensions/openclaw-membrane && npm install --production
```

### 3. Enable in OpenClaw

Add to your `openclaw.json`:
```json
{
  "plugins": {
    "entries": {
      "openclaw-membrane": {
        "enabled": true,
        "config": {
          "grpc_endpoint": "localhost:50051"
        }
      }
    }
  }
}
```

### 4. Restart gateway

```bash
openclaw doctor --fix
openclaw gateway restart
```

### 5. Verify

Check gateway logs for:
```
[membrane] Registered bridge to localhost:50051
```

Send a message — it should appear as a Membrane record. Use the `membrane_search` tool to query:
```
membrane_search("what did we discuss yesterday")
```

## Features

| Feature | Description |
|---------|-------------|
| **Event Ingestion** | Writes messages, tool calls, facts, and outcomes to Membrane via gRPC |
| **`membrane_search` Tool** | LLM-callable search — each query boosts salience of matched records (rehearsal) |
| **Auto-Context** | `before_agent_start` hook injects `<membrane-context>` into the system prompt |
| **Reliability Buffer** | Ring buffer with exponential backoff, max 10 retries, graceful shutdown flush |
| **4 Memory Types** | Parses episodic (timeline), semantic (SPO facts), competence (patterns), working (state) |

## How it works

```
                         WRITE PATH
OpenClaw Events ──→ mapping.ts ──→ buffer.ts ──→ gRPC IngestEvent ──→ Membrane DB
                                                                          │
                         READ PATH                                        │
User Prompt ──→ before_agent_start hook ──→ gRPC Retrieve ──→ parser.ts ──┘
                                                    │
                                              <membrane-context>
                                            injected into prompt
                         
                         SEARCH PATH
LLM calls membrane_search ──→ gRPC Retrieve ──→ parser.ts ──→ formatted results
                                    │
                              salience boosted
                             (rehearsal effect)
```

**Write path:** Every OpenClaw event (message in/out, tool call, fact extraction, task outcome) is mapped to a Membrane gRPC call and queued in a ring buffer. Failed calls retry with exponential backoff.

**Read path:** Before each agent turn, the plugin calls Membrane's Retrieve with the user prompt. Matching records are parsed, filtered (prioritizing user/assistant messages over tool calls), and injected as `<membrane-context>`.

**Search path:** The `membrane_search` tool lets the LLM explicitly query Membrane. Each Retrieve call triggers Membrane's rehearsal mechanism — accessed memories gain salience and resist decay.

## Event Mapping

| OpenClaw Event | Membrane Method | Memory Kind |
|---------------|----------------|-------------|
| `message_received` | IngestEvent | user_message |
| `message_sent` | IngestEvent | assistant_message |
| `session_start` | IngestEvent | session_init |
| `after_tool_call` | IngestToolOutput | tool_call |
| `fact_extracted` | IngestObservation | semantic |
| `task_completed` | IngestOutcome | outcome |

## Configuration

### External Config (recommended)

Create `~/.openclaw/plugins/openclaw-membrane/config.json`:

```json
{
  "grpc_endpoint": "localhost:50051",
  "buffer_size": 1000,
  "default_sensitivity": "low",
  "retrieve_enabled": true,
  "retrieve_limit": 5,
  "retrieve_min_salience": 0.1,
  "retrieve_max_sensitivity": "medium",
  "retrieve_timeout_ms": 10000
}
```

### Config Reference

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `grpc_endpoint` | string | `localhost:50051` | Membrane gRPC address |
| `buffer_size` | number | `1000` | Ring buffer capacity |
| `default_sensitivity` | string | `low` | Default event sensitivity (`public`/`low`/`medium`/`high`/`hyper`) |
| `retrieve_enabled` | boolean | `true` | Enable auto-context injection |
| `retrieve_limit` | number | `5` | Max memories per turn |
| `retrieve_min_salience` | number | `0.1` | Min salience for Retrieve |
| `retrieve_max_sensitivity` | string | `medium` | Max sensitivity for Retrieve |
| `retrieve_timeout_ms` | number | `2000` | Retrieve timeout in ms |

### Sensitivity Model

Events are classified by sensitivity based on context:

| Condition | Sensitivity |
|-----------|------------|
| Credential/auth events | `hyper` |
| DM / private channel | `medium` |
| Tool calls | `medium` |
| Default | config value (`low`) |
| Invalid/unknown | `hyper` (secure fallback) |

### Authentication

Set `MEMBRANE_API_KEY` environment variable if your Membrane instance requires auth.

## Architecture

```
openclaw-membrane/
├── index.ts        # Plugin entry: wiring, tool + hook registration (248 LOC)
├── types.ts        # TypeScript interfaces, config defaults (132 LOC)
├── parser.ts       # Shared record parser, all 4 memory types (136 LOC)
├── mapping.ts      # Event → gRPC payload mapping, 6 types (151 LOC)
├── buffer.ts       # Ring buffer + reliability manager (120 LOC)
├── client.ts       # gRPC client wrapper (71 LOC)
├── test/
│   ├── parser.test.ts    # 15 tests
│   ├── mapping.test.ts   # 15 tests
│   ├── buffer.test.ts    # 6 tests
│   └── config.test.ts    # 8 tests
└── assets/proto/         # Membrane gRPC proto definitions
```

**Total:** 858 LOC source, 44 tests, 0 `any`.

## Tests

```bash
npx vitest run        # Run all 44 tests
npx vitest --watch    # Watch mode
```

## Known Limitations

**Be honest about what this can and can't do today:**

- **No fulltext search.** Membrane's Retrieve ranks by salience/recency/decay, not text content. If you search for "pipeline", it won't find records containing "pipeline" — it returns whatever has highest salience. This gets better over time as rehearsal boosts relevant records, but early on results can feel random.
- **Backfilled records don't benefit from decay.** If you bulk-import history, all records start with identical salience and no access history. Membrane's biological memory model needs organic growth — records written through real conversations develop natural salience patterns.
- **Single memory slot in OpenClaw.** The `before_agent_start` hook only fires for the active memory plugin. If you use `memory-lancedb` (default), Membrane's auto-context injection won't fire. The `membrane_search` tool works regardless.
- **No vector/semantic search.** Membrane doesn't have embedding-based search yet. The `membrane_search` tool queries via gRPC Retrieve which uses salience-based ranking. For fulltext needs, use the bundled `scripts/membrane-search.sh` (SQL LIKE queries directly on the SQLite DB).
- **Consolidation is early.** Membrane runs consolidation every 6h with 4 sub-consolidators, but the quality of merged records depends on your data volume and patterns.
- **SQLite scaling.** Works well up to ~100k records. Beyond that, query performance may degrade. No sharding or distributed mode.

## Membrane — Credit & Collaboration

This plugin bridges [GustyCube/membrane](https://github.com/GustyCube/membrane), created by **Bennett Schwartz** ([@GustyCube](https://github.com/GustyCube)).

Membrane is the memory substrate — a Go-based gRPC service (7.2k LOC) implementing biological memory dynamics: episodic timeline, semantic facts, competence learning, working memory, salience decay, and revision operations (supersede/fork/retract/contest/merge). The [RFC specification](https://github.com/GustyCube/membrane/blob/main/RFC.md) (849 lines) is one of the best-documented agent memory specs we've seen.

This plugin is the **bridge layer** — it handles OpenClaw event mapping, buffered ingestion, search tooling, and context injection. Membrane does the heavy lifting on storage, decay math, and memory consolidation.

We're exploring joint development with GustyCube — Vainplex brings plugin infrastructure + LLM enhancement + production experience, GustyCube brings the storage backend + revision system + decay math.

- **Membrane docs:** [membrane.gustycube.com](https://membrane.gustycube.com)
- **TS Client:** `@gustycube/membrane` on npm
- **Memory types:** episodic (timeline), semantic (SPO triples), competence (learned patterns), working (task state)
- **Revision ops:** supersede, fork, retract, contest, merge

## Vainplex OpenClaw Plugin Suite

| # | Plugin | Version | Tests | Description |
|---|--------|---------|-------|-------------|
| 1 | [@vainplex/openclaw-nats-eventstore](https://github.com/alberthild/openclaw-nats-eventstore) | 0.2.1 | 60 | NATS JetStream event persistence |
| 2 | [@vainplex/openclaw-cortex](https://github.com/alberthild/openclaw-cortex) | 0.4.2 | 756 | Boot context, threads, decisions, trace analysis |
| 3 | [@vainplex/openclaw-governance](https://github.com/alberthild/openclaw-governance) | 0.3.2 | 402 | Policy engine, trust scores, credential guard |
| 4 | [@vainplex/openclaw-knowledge-engine](https://github.com/alberthild/openclaw-knowledge-engine) | 0.1.4 | 94 | LanceDB knowledge extraction + search |
| 5 | **@vainplex/openclaw-membrane** | **0.3.0** | **44** | **Membrane episodic memory bridge** |

## License

MIT
