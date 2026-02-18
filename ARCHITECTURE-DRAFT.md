# @vainplex/openclaw-membrane — Architecture Draft

**Plugin #5 in the Vainplex Plugin Suite**
**Status:** DRAFT — Design Proposal

---

## Overview

OpenClaw plugin that bridges Membrane (Go sidecar) into the OpenClaw hook system. Provides structured, revisable, typed memory with competence learning — features not covered by existing plugins.

```
┌─────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                   │
│                                                       │
│  ┌─────────────┐  ┌──────────┐  ┌─────────────────┐ │
│  │ nats-event   │  │ cortex   │  │ knowledge-engine│ │
│  │ store        │  │          │  │                 │ │
│  └─────────────┘  └──────────┘  └─────────────────┘ │
│                                                       │
│  ┌───────────────────────────────────────────────┐   │
│  │         @vainplex/openclaw-membrane            │   │
│  │                                                │   │
│  │  hooks.ts ──→ ingestion-bridge.ts ──→ gRPC ───┼───┼──→ membraned (Go)
│  │                                                │   │        │
│  │  retrieval-bridge.ts ←── gRPC ←───────────────┼───┼──← SQLCipher DB
│  │                                                │   │
│  │  llm-consolidator.ts ──→ gRPC (ingest) ──────┼───┼──→ (new records)
│  │                                                │   │
│  └───────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│          membraned (Go Sidecar)          │
│                                          │
│  gRPC :9090                              │
│  ├── Ingestion (5 methods)               │
│  ├── Retrieval (2 methods)               │
│  ├── Revision  (5 methods)               │
│  ├── Decay     (reinforce/penalize)      │
│  ├── Metrics   (1 method)                │
│  │                                       │
│  │  Background Jobs:                     │
│  │  ├── Decay Scheduler (1h)             │
│  │  ├── Consolidation Scheduler (6h)     │
│  │  └── Pruning (with decay)             │
│  │                                       │
│  └── SQLCipher DB (membrane.db)          │
└─────────────────────────────────────────┘
```

---

## Components

### 1. Plugin (TypeScript) — `@vainplex/openclaw-membrane`

**Our responsibility.** Runs inside OpenClaw, zero Go knowledge needed by users.

```
src/
├── index.ts              # Plugin entry, registers hooks
├── config.ts             # Plugin config + sidecar config
├── hooks.ts              # OpenClaw hook handlers
├── ingestion-bridge.ts   # Maps OpenClaw events → Membrane IngestEvent/Observation/WorkingState
├── retrieval-bridge.ts   # Context injection from Membrane → OpenClaw prompts
├── llm-consolidator.ts   # LLM-enhanced consolidation (our value-add)
├── competence-tracker.ts # Tracks tool success/failure → Competence records
├── sidecar-manager.ts    # Start/stop/health-check membraned process
├── grpc-client.ts        # Thin wrapper around Membrane's TS client
└── types.ts              # Shared types
```

### 2. Sidecar (Go Binary) — `membraned`

**GustyCube's responsibility.** Pre-built binary, managed by our plugin.

- Ships as platform-specific binary (linux-amd64, darwin-arm64)
- Plugin downloads on first install or bundles it
- Plugin starts/stops the process via `sidecar-manager.ts`
- Communication: gRPC on localhost:9090

---

## Hook Mapping

| OpenClaw Hook | Membrane Method | What it does |
|---|---|---|
| `session_start` | `Retrieve` | Pull relevant memory into session context |
| `message_received` | `IngestEvent` | Record user message as episodic memory |
| `message_sent` | `IngestEvent` + `IngestObservation` | Record response + extract semantic facts |
| `tool_call` (planned) | `IngestToolOutput` | Record tool usage for competence learning |
| `tool_result` (planned) | `IngestOutcome` | Record success/failure → competence stats |
| `before_compaction` | `IngestWorkingState` | Snapshot current task state |
| `gateway_stop` | — | Graceful shutdown of sidecar |

---

## LLM-Enhanced Consolidation (Our Value-Add)

Membrane's built-in consolidation is pattern-matching only. We add LLM extraction:

```
Every 30min (configurable):
1. Retrieve recent episodic records (last batch)
2. LLM prompt: "Extract semantic facts, competence procedures, and plan patterns"
3. For each extracted item:
   - Check if supersedes existing record → Revision.Supersede
   - Check if contradicts → Revision.Contest
   - Otherwise → Ingestion.IngestObservation (semantic) or create Competence
4. Fire Reinforce on records that were useful in retrievals
```

This is what makes the combination powerful:
- Membrane handles storage, decay, revision, trust — the boring-but-hard stuff
- We handle the intelligence — what to extract, when to revise, how to consolidate

---

## Competence Tracker (New Module)

Tracks tool usage patterns and builds Competence records:

```typescript
// On tool_call hook:
tracker.recordToolCall(sessionId, toolName, args);

// On tool_result hook:
tracker.recordOutcome(sessionId, toolName, success);

// Periodically:
// If tool pattern X succeeded 3+ times → create Competence record via gRPC
// If tool pattern X failed → update FailureCount, add FailureMode
```

Example competence record that would emerge:
```json
{
  "skill_name": "skill:docker+exec",
  "triggers": [{ "signal": "docker command" }],
  "recipe": [
    { "step": "Use sg docker -c wrapper", "tool": "exec" },
    { "step": "Check container status first", "tool": "exec" }
  ],
  "performance": {
    "success_count": 12,
    "failure_count": 2,
    "success_rate": 0.857
  }
}
```

---

## Sidecar Management

```typescript
// sidecar-manager.ts

class SidecarManager {
  private process: ChildProcess | null = null;

  async start(config: MembraneConfig): Promise<void> {
    // 1. Check if membraned binary exists
    // 2. Write config YAML to tmp
    // 3. Spawn: membraned --config /tmp/membrane-config.yaml
    // 4. Wait for gRPC health check (retry 5x, 1s apart)
    // 5. Log: "Membrane sidecar ready on :9090"
  }

  async stop(): Promise<void> {
    // Send SIGTERM, wait 5s, SIGKILL if needed
  }

  async healthCheck(): Promise<boolean> {
    // gRPC GetMetrics as health probe
  }
}
```

---

## Config Schema

```json
{
  "membrane": {
    "enabled": true,
    "sidecar": {
      "binary": "./bin/membraned",
      "autoStart": true,
      "port": 9090,
      "dbPath": "~/.openclaw/membrane/membrane.db",
      "encryptionKey": "${MEMBRANE_ENCRYPTION_KEY}",
      "decayInterval": "1h",
      "consolidationInterval": "6h"
    },
    "ingestion": {
      "captureMessages": true,
      "captureToolCalls": true,
      "captureWorkingState": true,
      "defaultSensitivity": "low"
    },
    "retrieval": {
      "enabled": true,
      "onSessionStart": true,
      "maxRecords": 20,
      "minSalience": 0.3,
      "memoryTypes": ["semantic", "competence", "working"]
    },
    "consolidation": {
      "llmEnabled": true,
      "llmEndpoint": "http://localhost:11434/v1",
      "llmModel": "mistral:7b",
      "intervalMinutes": 30
    },
    "competence": {
      "enabled": true,
      "minOccurrences": 3,
      "trackTools": true
    }
  }
}
```

---

## Installation Flow

```bash
# 1. Install plugin
npm install @vainplex/openclaw-membrane

# 2. Download sidecar binary (automated by plugin)
npx openclaw-membrane install-sidecar

# 3. Add to openclaw.json
# Plugin auto-configures on first load

# 4. Restart gateway
openclaw gateway restart
```

---

## Division of Labor

| Component | Owner | Notes |
|---|---|---|
| Plugin TypeScript code | Vainplex (us) | hooks, bridges, LLM consolidation, competence tracker |
| Sidecar binary | GustyCube | membraned, storage, decay, revision, gRPC |
| Proto/types sync | Shared | TS types auto-generated from proto |
| LLM consolidation prompts | Vainplex | Our expertise — what to extract, how to revise |
| RFC spec maintenance | GustyCube | Canonical spec, we propose additions |
| Testing | Both | Plugin tests (us), sidecar tests (him), integration tests (shared) |
| Binary distribution | GustyCube | GitHub releases, platform binaries |
| npm publishing | Vainplex | @vainplex scope, our pipeline |

---

## What This Enables (that we can't do today)

1. **"How did I fix X last time?"** → Competence retrieval with success rate ranking
2. **Fact versioning** → "Mondo Gate has 1,100 customers" gets superseded by "2,000 customers"
3. **Contested knowledge** → Two conflicting facts coexist until resolved
4. **Plan reuse** → Multi-step workflows stored as DAGs, reused when similar task appears
5. **Automatic skill extraction** → Repeated tool patterns → named procedures
6. **Memory metrics** → How much is remembered, what's decaying, retrieval usefulness

---

## Risk Mitigation

| Risk | Mitigation |
|---|---|
| GustyCube goes inactive | Plugin works standalone, we fork sidecar (MIT) |
| Go binary size/complexity | Single static binary, ~15MB, no runtime deps |
| gRPC overhead | localhost only, sub-ms latency |
| SQLite limits | Single-instance is fine for personal AI |
| Breaking proto changes | Pin sidecar version, semver compat |

---

## Timeline Estimate

| Phase | Duration | Deliverable |
|---|---|---|
| Design agreement | 1 week | Shared design doc, proto additions |
| Plugin scaffold | 2-3 days | hooks, sidecar-manager, grpc-client |
| Ingestion bridge | 2-3 days | All hooks → Membrane ingestion |
| Retrieval bridge | 2-3 days | Context injection on session_start |
| Competence tracker | 3-4 days | Tool tracking → competence records |
| LLM consolidation | 3-4 days | Batch extraction + revision logic |
| Integration tests | 2-3 days | End-to-end with real sidecar |
| Cerberus review | 1-2 days | Code quality gate |
| **Total** | **~3 weeks** | v0.1.0 on npm |

---

*Draft by Claudia — 2026-02-17*
*For discussion with GustyCube and Albert*
