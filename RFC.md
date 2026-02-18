# RFC: OpenClaw Membrane Plugin

**RFC ID:** membrane-openclaw-001
**Status:** DRAFT
**Author:** Vainplex (Albert Hild)
**Target:** GustyCube/membrane PR #1 — "Add OpenClaw Support"
**Date:** 2026-02-17
**Location:** `clients/openclaw/` in the Membrane monorepo

---

## 1. Summary

This RFC proposes an OpenClaw plugin (`@vainplex/openclaw-membrane`) that integrates Membrane's Go-based memory sidecar into the OpenClaw agent framework. The plugin manages the `membraned` sidecar lifecycle, maps OpenClaw hooks to Membrane's ingestion/retrieval API, and adds LLM-enhanced consolidation — the key capability Membrane's current stub implementation lacks.

The plugin lives in `clients/openclaw/` of the Membrane monorepo, alongside the existing TypeScript client in `clients/typescript/`.

---

## 2. Motivation

### 2.1 What Membrane Provides That OpenClaw Lacks

OpenClaw's existing plugin suite covers event streaming (nats-eventstore), conversation intelligence (cortex), and entity/fact extraction (knowledge-engine). None provide:

1. **Revision operations** — Supersede, fork, retract, contest, merge with full audit trails
2. **Competence learning** — Tracking tool success rates and building reusable skill records
3. **Plan graphs** — Storing multi-step workflows as reusable DAGs
4. **Typed memory decay** — Exponential/linear salience decay with automatic pruning
5. **Trust-gated retrieval** — Sensitivity levels with graduated access control

These are hard problems with correct implementations in Membrane's Go codebase. Building them from scratch in TypeScript would take 2–3 weeks and duplicate tested logic.

### 2.2 What OpenClaw Provides That Membrane Lacks

Membrane's consolidation pipeline (episodic → semantic/competence/plan) is currently a pattern-matching stub. The Go codebase acknowledges this gap but cannot solve it without LLM integration.

OpenClaw's plugin system provides:

1. **Hook-driven event flow** — Structured access to every conversation event
2. **LLM integration patterns** — Proven regex-first + LLM-batch approach (see cortex, knowledge-engine)
3. **Plugin lifecycle management** — Service start/stop, config resolution, command registration
4. **Production deployment** — Running on real agents with real conversations

### 2.3 Joint Value

The combination creates a feedback loop:

```
Conversation Events (OpenClaw hooks)
    → Episodic Ingestion (Membrane gRPC)
    → LLM Consolidation (OpenClaw plugin)
    → Semantic/Competence Records (Membrane gRPC)
    → Context Injection (OpenClaw session_start)
    → Better Agent Responses
    → More Events → ...
```

Neither system achieves this alone.

---

## 3. Design Principles

### 3.1 Zero Go Knowledge Required

Users install an npm package and configure it in `openclaw.json`. The Go sidecar is downloaded automatically and managed as a child process. Users never interact with `membraned` directly.

### 3.2 Regex-First, LLM-Optional

Following the pattern established by `@vainplex/openclaw-cortex` and `@vainplex/openclaw-knowledge-engine`:

- **Always on:** Regex-based extraction (semantic triples from structured patterns, tool call tracking from hook data)
- **Optional:** LLM-enhanced consolidation (batch processing, configurable endpoint/model)
- **Graceful degradation:** If LLM is unavailable, regex extraction continues; if sidecar is down, plugin logs warnings but doesn't crash the gateway

### 3.3 Sidecar, Not Embedded

Membrane runs as a separate process for several reasons:

- **Language boundary** — Go binary, TypeScript plugin
- **Crash isolation** — Sidecar crash doesn't take down OpenClaw
- **Independent upgrades** — Pin sidecar version separately from plugin version
- **Resource isolation** — SQLCipher operations don't block the Node.js event loop

### 3.4 Non-Overlapping With Existing Plugins

This plugin does NOT replace cortex or knowledge-engine. Clear boundaries:

| Concern | Owner | Rationale |
|---|---|---|
| Thread tracking, mood, narrative | cortex | Conversation-level, in-memory, file-based |
| Entity/fact extraction (NER, triples) | knowledge-engine | Specialized extraction pipeline |
| Revisable semantic memory, decay, competence | **membrane** | Persistent, typed, with revision semantics |
| Event streaming, audit trail | nats-eventstore | Pub/sub, replay, multi-agent |

Membrane consumes extracted knowledge (from knowledge-engine via hooks or its own regex) and provides durable, revisable storage with decay and retrieval. It does not duplicate extraction logic.

---

## 4. Scope

### 4.1 In Scope (v0.1.0)

1. **Sidecar lifecycle management** — Download, start, stop, health check of `membraned`
2. **Hook-to-ingestion bridge** — Map 5 OpenClaw hooks to Membrane ingestion methods
3. **Session-start context injection** — Retrieve relevant memory and inject as system context
4. **Working state snapshots** — Capture task state before compaction
5. **Competence tracking** — Track tool call patterns and outcomes via existing hook data
6. **LLM-enhanced consolidation** — Periodic batch processing of episodic records
7. **Plugin config, commands, service registration** — Standard OpenClaw plugin contract

### 4.2 Out of Scope (Future)

- **Plan graph construction** — Requires multi-step workflow detection (v0.2.0)
- **Multi-agent memory sharing** — Requires Membrane federation protocol (future RFC)
- **Vector search** — Membrane doesn't support it yet; may propose upstream addition
- **Custom decay curves** — Use Membrane's defaults for now
- **GUI/dashboard** — Membrane has VitePress docs; we don't add UI

### 4.3 Upstream Requirements (GustyCube)

The plugin depends on capabilities that already exist in `membraned`. No upstream changes are required for v0.1.0. However, we propose the following for consideration in future Membrane releases:

1. **Health check endpoint** — Currently we use `GetMetrics` as a health probe. A dedicated `/health` or gRPC health check would be cleaner.
2. **Consolidation callback hook** — Allow external consolidators to register, so Membrane can invoke them instead of its internal stub.
3. **Batch ingestion** — `IngestBatch(records[])` to reduce round-trips during consolidation.

---

## 5. Hook Mapping

### 5.1 session_start → Retrieve + Context Injection

**Priority:** 5 (runs early, before cortex boot context at priority 10)

```
Trigger: session_start hook
Action:
  1. Build task descriptor from session context (channel, agent, recent activity)
  2. Call Membrane Retrieve(taskDescriptor, {
       memoryTypes: [semantic, competence, working],
       minSalience: 0.3,
       limit: configurable (default 20)
     })
  3. Format retrieved records as structured context block
  4. Inject into session via ctx.injectSystemContext() or write to workspace file
```

**Output format** (injected into agent context):

```markdown
## Membrane Memory Context

### Semantic Knowledge (5 records)
- [0.92] Docker commands require `sg docker -c` wrapper on this system
- [0.87] Mondo Gate API uses JWT auth with 1h expiry
- [0.71] The user prefers German for casual conversation, English for technical

### Competence (3 records)
- [0.89] skill:docker+exec — 12/14 success (use sg wrapper, check container first)
- [0.76] skill:git+rebase — 8/10 success (always fetch first, use --autostash)

### Working State
- Last task: "Membrane RFC design" (thread:abc123, 45min ago)
```

### 5.2 message_received → IngestEvent + IngestObservation

**Priority:** 100 (default, runs after most hooks)

```
Trigger: message_received hook
Action:
  1. IngestEvent("user_message", ref=sessionId, {
       content: event.content,
       sender: event.from,
       timestamp: event.timestamp,
       sensitivity: config.defaultSensitivity
     })
  2. Run regex extraction on event.content:
     - S-P-O patterns: "{X} is {Y}", "{X} has {Y}", "{X} uses {Y}"
     - For each triple found: IngestObservation(subject, predicate, object)
  3. Buffer for LLM consolidation batch (if enabled)
```

### 5.3 message_sent → IngestEvent + Extraction

**Priority:** 100

```
Trigger: message_sent hook
Action:
  1. IngestEvent("assistant_message", ref=sessionId, {
       content: event.content,
       role: "assistant",
       timestamp: event.timestamp
     })
  2. Run regex extraction (same as message_received)
  3. Buffer for LLM consolidation batch
```

### 5.4 before_compaction → IngestWorkingState

**Priority:** 3 (runs before cortex pre-compaction at priority 5)

```
Trigger: before_compaction hook
Action:
  1. Summarize compacting messages (last N, configurable)
  2. IngestWorkingState(threadId=sessionId, {
       messageCount: event.compactingCount,
       summary: summarized content,
       openThreads: (if cortex data available, reference thread IDs),
       timestamp: now
     })
```

### 5.5 gateway_stop → Graceful Sidecar Shutdown

**Priority:** 1000 (runs last)

```
Trigger: gateway_stop hook (system event)
Action:
  1. Flush any pending LLM consolidation batch
  2. Send SIGTERM to membraned process
  3. Wait up to 5 seconds for clean exit
  4. If still running, SIGKILL
  5. Log shutdown status
```

### 5.6 Future Hooks (when available in OpenClaw)

| Hook | Membrane Method | Purpose |
|---|---|---|
| `before_tool_call` | Buffer tool call | Track tool invocation for competence |
| `after_tool_call` | `IngestToolOutput` + `IngestOutcome` | Record result + success/failure |

These hooks exist in the nats-eventstore plugin's mapping table, indicating OpenClaw supports them. We register handlers when available and gracefully skip when not.

---

## 6. LLM-Enhanced Consolidation

### 6.1 Trigger

Consolidation runs on a configurable interval (default: 30 minutes) via `setInterval`. It also runs on `gateway_stop` (flush remaining buffer).

### 6.2 Pipeline

```
1. Retrieve recent episodic records from Membrane:
   Retrieve("recent_episodes", { memoryTypes: [episodic], limit: 50, since: lastConsolidation })

2. Group into conversation segments (by session/time proximity)

3. For each segment, LLM prompt:
   "Given these conversation events, extract:
    a) Semantic facts as subject-predicate-object triples
    b) Competence observations (what worked, what failed, procedures)
    c) Corrections to previously known facts
    d) Confidence level for each extraction"

4. For each LLM extraction:
   a) Semantic fact → Check for existing conflicting record:
      - If exists + new contradicts → Contest(existingId, newRef, actor, rationale)
      - If exists + new updates → Supersede(existingId, newRecord, actor, rationale)
      - If new → IngestObservation(subject, predicate, object)
   b) Competence → IngestToolOutput or update existing via Supersede
   c) Correction → Supersede old record, log rationale

5. Reinforce records that were retrieved and used (appeared in context injection)

6. Update lastConsolidation timestamp
```

### 6.3 LLM Prompt Design

The consolidation prompt follows the same structure as cortex and knowledge-engine: structured JSON output with validation.

```
System: You are a memory consolidation engine. Given a sequence of conversation
events, extract durable knowledge that should persist beyond this session.

Output JSON:
{
  "facts": [
    { "subject": "...", "predicate": "...", "object": "...", "confidence": 0.0-1.0 }
  ],
  "competence": [
    { "skill": "...", "triggers": [...], "steps": [...], "outcome": "success|failure" }
  ],
  "corrections": [
    { "old_fact": "...", "new_fact": "...", "reason": "..." }
  ]
}

Rules:
- Only extract facts that would be useful in future conversations
- Minimum confidence 0.6 for facts, 0.7 for competence
- Corrections require explicit evidence in the conversation
- Do NOT extract conversational noise, greetings, or meta-discussion
```

### 6.4 Fallback Without LLM

When LLM is disabled (`consolidation.llmEnabled: false`), consolidation falls back to:

1. **Regex extraction only** — S-P-O patterns from episodic content
2. **Tool call statistics** — Pure numeric competence tracking (success/failure counts)
3. **No corrections/supersedes** — Only new facts are ingested, no conflict detection

This is still useful — it captures structured facts and tool stats. LLM adds nuance, contradiction detection, and procedure extraction.

---

## 7. Competence Tracking

### 7.1 Data Flow

```
before_tool_call hook → buffer { tool, args, startTime }
after_tool_call hook  → match buffer entry, record outcome

Outcome tracking (in-memory, flushed periodically):
  toolName → {
    calls: number,
    successes: number,
    failures: number,
    failureModes: Map<string, number>,   // error pattern → count
    avgDurationMs: number,
    lastUsed: timestamp
  }

When a tool reaches minOccurrences (default 3):
  → IngestToolOutput(toolName, { recipe, performance })
  → Subsequent updates: Supersede(oldRecordId, updatedRecord)
```

### 7.2 Competence Record Format

```json
{
  "memory_type": "competence",
  "content": {
    "skill_name": "skill:exec+docker",
    "triggers": [
      { "signal": "docker command needed", "confidence": 0.85 }
    ],
    "recipe": [
      { "step": "Check if container is running", "tool": "exec", "args_pattern": "docker ps" },
      { "step": "Use sg docker -c wrapper", "tool": "exec", "args_pattern": "sg docker -c '...'" }
    ],
    "performance": {
      "success_count": 12,
      "failure_count": 2,
      "success_rate": 0.857,
      "failure_modes": { "permission denied": 1, "container not found": 1 },
      "avg_duration_ms": 2340
    }
  },
  "sensitivity": "low",
  "salience": 0.85
}
```

### 7.3 Reinforcement

When a competence record is retrieved during `session_start` context injection and the subsequent tool calls succeed, the record is reinforced:

```
After successful tool call:
  If tool matches a retrieved competence record:
    → Reinforce(recordId, "openclaw-membrane", "tool call succeeded matching competence")
```

When a tool call fails and a competence record exists:

```
After failed tool call:
  If tool matches a retrieved competence record:
    → Penalize(recordId, 0.1, "openclaw-membrane", "tool call failed: {error}")
    → If failure introduces new failure mode: update record via Supersede
```

---

## 8. Sidecar Management

### 8.1 Binary Distribution

The `membraned` binary ships as GitHub release assets on `GustyCube/membrane`:

```
membrane-v0.x.y-linux-amd64.tar.gz
membrane-v0.x.y-linux-arm64.tar.gz
membrane-v0.x.y-darwin-amd64.tar.gz
membrane-v0.x.y-darwin-arm64.tar.gz
membrane-v0.x.y-windows-amd64.zip
```

The plugin provides a download command:

```bash
npx openclaw-membrane install-sidecar [--version v0.x.y] [--platform linux-amd64]
```

This downloads the appropriate binary to `~/.openclaw/membrane/bin/membraned` (or the configured path).

### 8.2 Lifecycle

```
Plugin service.start():
  1. Check binary exists at config.sidecar.binary path
  2. If not found and config.sidecar.autoDownload: trigger download
  3. If not found and !autoDownload: log error, disable membrane features, continue
  4. Write sidecar config YAML to temp file:
     - gRPC listen address: 127.0.0.1:{port}
     - Database path: config.sidecar.dbPath
     - Encryption key: from env MEMBRANE_ENCRYPTION_KEY or config
     - Decay interval: config.sidecar.decayInterval
     - Log level: matches OpenClaw log level
  5. Spawn: membraned serve --config /tmp/membrane-{pid}.yaml
  6. Health check loop: GetMetrics() with retry (5 attempts, 1s backoff)
  7. On success: log "Membrane sidecar ready on :{port}"
  8. On failure: log error, disable membrane features, continue

Plugin service.stop():
  1. Flush pending consolidation batch
  2. Send SIGTERM to sidecar process
  3. Wait up to 5s for exit
  4. If still running: SIGKILL
  5. Clean up temp config file
  6. Log shutdown status
```

### 8.3 Crash Recovery

If the sidecar process exits unexpectedly:

1. Log the exit code and stderr
2. Attempt restart (max 3 restarts within 5 minutes)
3. If restart fails, disable membrane features and log a persistent warning
4. On next gateway restart, try fresh sidecar start

### 8.4 Port Allocation

Default port: 9090. If port is in use:

1. Check if the process on that port is a `membraned` instance (via `GetMetrics()`)
2. If yes: reuse existing sidecar (supports multi-gateway scenarios)
3. If no: increment port and retry (up to 9095)
4. Store actual port in runtime state for hook handlers

---

## 9. Configuration

### 9.1 openclaw.json Entry

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-membrane": {
        "enabled": true,
        "config": {
          "sidecar": {
            "binary": "~/.openclaw/membrane/bin/membraned",
            "autoStart": true,
            "autoDownload": true,
            "version": "v0.1.0",
            "port": 9090,
            "dbPath": "~/.openclaw/membrane/membrane.db",
            "encryptionKey": "${MEMBRANE_ENCRYPTION_KEY}",
            "decayInterval": "1h",
            "maxRestarts": 3
          },
          "ingestion": {
            "captureMessages": true,
            "captureToolCalls": true,
            "captureWorkingState": true,
            "defaultSensitivity": "low",
            "regexExtraction": true
          },
          "retrieval": {
            "onSessionStart": true,
            "maxRecords": 20,
            "minSalience": 0.3,
            "memoryTypes": ["semantic", "competence", "working"],
            "contextFormat": "markdown"
          },
          "consolidation": {
            "enabled": true,
            "intervalMinutes": 30,
            "llmEnabled": false,
            "llmEndpoint": "http://localhost:11434/v1",
            "llmModel": "mistral:7b",
            "llmApiKey": "",
            "llmTimeoutMs": 30000,
            "batchSize": 50,
            "minConfidence": 0.6
          },
          "competence": {
            "enabled": true,
            "minOccurrences": 3,
            "reinforceOnSuccess": true,
            "penalizeOnFailure": true,
            "penaltyAmount": 0.1
          }
        }
      }
    }
  }
}
```

### 9.2 Environment Variables

| Variable | Purpose | Default |
|---|---|---|
| `MEMBRANE_ENCRYPTION_KEY` | SQLCipher encryption key for the database | (required if encryption enabled) |
| `MEMBRANE_BINARY` | Override binary path | `~/.openclaw/membrane/bin/membraned` |
| `MEMBRANE_PORT` | Override gRPC port | `9090` |

### 9.3 Defaults

The plugin works with zero configuration beyond `"enabled": true`. All values have sensible defaults:

- Sidecar auto-downloads the latest stable release
- LLM consolidation is disabled by default (regex-only)
- All ingestion hooks are active
- Context injection on session_start with 20 records, 0.3 minimum salience
- Competence tracking active with 3-occurrence threshold

---

## 10. Plugin API Contract

Following established OpenClaw plugin conventions (matching cortex, nats-eventstore, knowledge-engine):

```typescript
// index.ts — Plugin entry point
const plugin = {
  id: "openclaw-membrane",
  name: "OpenClaw Membrane",
  description: "Structured memory with revision operations, competence learning, and decay — powered by Membrane sidecar",
  version: "0.1.0",

  register(api: OpenClawPluginApi): void {
    // 1. Resolve config
    // 2. Register sidecar service (start/stop lifecycle)
    // 3. Register hook handlers
    // 4. Register /membranestatus command
    // 5. Register gateway methods (membrane.status, membrane.retrieve)
  }
};

export default plugin;
```

### 10.1 Registered Service

```typescript
api.registerService({
  id: "membrane-sidecar",
  start: async (ctx) => { /* start membraned, wait for health */ },
  stop: async (ctx) => { /* flush, SIGTERM, cleanup */ }
});
```

### 10.2 Registered Commands

| Command | Description | Auth Required |
|---|---|---|
| `/membranestatus` | Show sidecar status, record counts, memory type distribution | Yes |
| `/membranerecall <query>` | Manual retrieval query against Membrane | Yes |

### 10.3 Registered Gateway Methods

| Method | Purpose |
|---|---|
| `membrane.status` | Programmatic status (sidecar health, record counts, last consolidation) |
| `membrane.retrieve` | Programmatic retrieval (for other plugins) |
| `membrane.ingest` | Programmatic ingestion (for other plugins) |

---

## 11. Inter-Plugin Interaction

### 11.1 With Cortex

Cortex writes `threads.json` and `decisions.json` to the workspace. Membrane can read these on `before_compaction` to enrich working state snapshots with thread context. This is one-way (read-only) — Membrane does not write to cortex's files.

### 11.2 With Knowledge Engine

Knowledge-engine extracts entities and facts via its own pipeline. Membrane does not duplicate this work. However, knowledge-engine's extracted facts could be ingested into Membrane as semantic records in a future version (v0.2.0), giving them decay, revision, and retrieval capabilities.

### 11.3 With NATS Event Store

Both plugins independently process the same hooks. No coordination needed — they serve different purposes (event streaming vs. persistent memory).

---

## 12. Security Considerations

### 12.1 Encryption at Rest

Membrane uses SQLCipher for database encryption. The encryption key:

- MUST be provided via environment variable (`MEMBRANE_ENCRYPTION_KEY`), not stored in `openclaw.json`
- Is passed to the sidecar via temporary config file (mode 0600, deleted after read)
- If not provided, the database is unencrypted (with a logged warning)

### 12.2 Network Exposure

- gRPC listens on `127.0.0.1` only — never on `0.0.0.0`
- No authentication on the gRPC channel (localhost trust model, consistent with Membrane's design)
- The Cerberus audit (2026-02-17) identified a CRITICAL finding: trust bypass via unvalidated sensitivity enum. This is a Membrane-side issue; our plugin sets sensitivity values correctly but cannot enforce server-side validation.

### 12.3 Sensitivity Levels

The plugin maps content sensitivity based on channel and content type:

| Source | Default Sensitivity | Rationale |
|---|---|---|
| Public channel messages | `low` | Already visible to others |
| DM messages | `medium` | Private conversation |
| Tool call results | `low` | Operational data |
| Working state snapshots | `medium` | May contain task context |
| LLM consolidation output | Inherits from source | Derived data |

Users can override via `config.ingestion.defaultSensitivity`.

---

## 13. Error Handling

### 13.1 Sidecar Unavailable

If the sidecar is not running or unreachable:

- **Ingestion hooks:** Log warning, skip ingestion, do not block the hook pipeline
- **Retrieval (session_start):** Skip context injection, log warning
- **Consolidation:** Skip cycle, retry next interval
- **Never throw** — all hook handlers are wrapped in try/catch, matching cortex/nats-eventstore pattern

### 13.2 gRPC Errors

Individual gRPC call failures are logged and skipped. The plugin maintains a failure counter exposed via `/membranestatus`:

```
gRPC Errors (last hour): 3 ingestion, 0 retrieval, 1 consolidation
```

### 13.3 LLM Failures

Same pattern as cortex `LlmEnhancer`:

- LLM call failure → fall back to regex-only for that batch
- Timeout → configurable (default 30s for consolidation, longer than cortex's 15s due to larger batches)
- Invalid JSON response → discard, log warning
- Consecutive failures → exponential backoff (up to 10 minutes)

---

## 14. Testing Strategy

### 14.1 Unit Tests

- **Config resolution** — All config permutations, env var substitution, defaults
- **Regex extraction** — S-P-O pattern matching, edge cases
- **Competence tracking** — Occurrence counting, threshold logic, reinforcement
- **Context formatting** — Markdown output, record sorting by salience
- **Sidecar manager** — Spawn mock, port detection, crash recovery logic

### 14.2 Integration Tests

- **Hook pipeline** — Simulate OpenClaw hooks, verify gRPC calls to mock sidecar
- **Consolidation cycle** — End-to-end with mock LLM and mock sidecar
- **Context injection** — Retrieve + format with real Membrane TS client against mock gRPC

### 14.3 Test Infrastructure

- Mock gRPC server (implements Membrane's proto, returns canned responses)
- Mock LLM server (returns structured JSON for consolidation prompts)
- No real `membraned` binary in unit/integration tests — only in manual smoke tests

---

## 15. Package & Distribution

### 15.1 npm Package

```
Package: @vainplex/openclaw-membrane
Registry: npm (public)
Scope: @vainplex
License: MIT (matching Membrane)
```

### 15.2 Monorepo Location

```
membrane/
└── clients/
    └── openclaw/
        ├── package.json
        ├── tsconfig.json
        ├── openclaw.plugin.json
        ├── index.ts
        ├── src/
        │   ├── types.ts
        │   ├── config.ts
        │   ├── sidecar-manager.ts
        │   ├── grpc-client.ts
        │   ├── hooks.ts
        │   ├── ingestion-bridge.ts
        │   ├── retrieval-bridge.ts
        │   ├── consolidator.ts
        │   ├── competence-tracker.ts
        │   └── patterns.ts
        ├── test/
        │   └── ...
        ├── README.md
        └── LICENSE
```

### 15.3 Dependency on TypeScript Client

The plugin imports from `../../clients/typescript/` (Membrane's existing TS client) for gRPC types and client wrapper. In npm distribution, this becomes a peer dependency:

```json
{
  "peerDependencies": {
    "@gustycube/membrane-client": "^0.1.0"
  }
}
```

If the TS client isn't published to npm yet, the plugin bundles the necessary types and wraps gRPC directly via `@grpc/grpc-js`.

---

## 16. Migration & Rollout

### 16.1 Phase 1: Design Agreement (This RFC)

- File PR on GustyCube/membrane with RFC + ARCHITECTURE
- Discuss with GustyCube, iterate on design
- Agree on directory structure and build integration

### 16.2 Phase 2: Scaffold (Days 1–3)

- Plugin entry, config, sidecar manager, gRPC client wrapper
- Basic hook registration (no logic yet)
- CI integration in Membrane monorepo

### 16.3 Phase 3: Core Features (Days 4–10)

- Ingestion bridge (all hook handlers)
- Retrieval bridge + context injection
- Competence tracker (tool call tracking)

### 16.4 Phase 4: Consolidation (Days 11–14)

- LLM-enhanced consolidation pipeline
- Regex fallback extraction
- Revision operations (supersede, contest)

### 16.5 Phase 5: Polish (Days 15–18)

- Integration tests with mock sidecar
- Commands (/membranestatus, /membranerecall)
- Documentation, README
- Cerberus security review

### 16.6 Phase 6: Release

- npm publish @vainplex/openclaw-membrane v0.1.0
- Update Vainplex Plugin Suite table in all repos
- Announce in OpenClaw + Membrane docs

---

## 17. Open Questions

1. **TS client npm publishing** — Is `clients/typescript/` published to npm as `@gustycube/membrane-client`? If not, should we publish it or vendor the types?

2. **Consolidation callback** — Would GustyCube accept a PR to add a consolidation callback/webhook in `membraned`, so our plugin registers as the consolidator instead of running on a timer?

3. **Health check endpoint** — Should we propose a gRPC health check service (standard `grpc.health.v1.Health`) upstream?

4. **Working state thread ID** — `IngestWorkingState` requires a `threadId`. Should this be the OpenClaw session ID, the cortex thread ID (if available), or a synthetic ID?

5. **Binary auto-download** — Should the plugin download `membraned` automatically on first run, or require explicit `npx openclaw-membrane install-sidecar`? Auto-download is more convenient but raises supply-chain concerns.

6. **Encryption key management** — Environment variable is the minimum. Should we support keyring integration (macOS Keychain, GNOME Keyring) for better key management?

---

## 18. Decision Record

| Decision | Choice | Rationale |
|---|---|---|
| Plugin lives in Membrane monorepo | `clients/openclaw/` | Keeps all clients together, single PR, shared CI |
| TypeScript, not Go | TS | OpenClaw plugins are TS; we wrap the Go binary |
| Sidecar pattern | Child process, not embedded | Language boundary, crash isolation, independent upgrades |
| Regex-first consolidation | Always-on regex, optional LLM | Matches cortex/knowledge-engine pattern, works without LLM |
| Config in openclaw.json | Standard plugin config | Consistent with all other Vainplex plugins |
| npm scope | `@vainplex` | Our publishing pipeline, consistent branding |
| Priority: session_start=5 | Runs before cortex (10) | Memory context should be available for cortex boot context |
| Default LLM: disabled | Opt-in | Not everyone has a local LLM; regex works standalone |

---

*RFC by Vainplex — 2026-02-17*
*For PR on GustyCube/membrane#1*
