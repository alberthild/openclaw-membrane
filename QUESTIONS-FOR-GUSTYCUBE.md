# Questions for GustyCube — OpenClaw Membrane Plugin

Hey Bennett! We've finished the RFC and architecture draft for the OpenClaw plugin (`clients/openclaw/`). Before we start coding, we have some questions to make sure we're aligned.

---

## 1. TypeScript Client Publishing

The plugin imports from `clients/typescript/` for gRPC types and the client wrapper.

- **Is the TS client published to npm** (e.g. `@gustycube/membrane-client`)? If not, are you planning to?
- If it's not published yet: should we **vendor the types** into the plugin for now, or would you prefer we help set up npm publishing for `clients/typescript/` as part of this PR?
- What's the **import path** we should use in the monorepo? We assumed `../../typescript/client.js` — is that correct?

## 2. Consolidation Architecture

Membrane's consolidation pipeline (episodic → semantic/competence) is currently a pattern-matching stub. Our plugin replaces this with LLM-enhanced batch processing.

- Would you accept a **consolidation callback/webhook** in `membraned`? The idea: our plugin registers as the external consolidator, and Membrane invokes it instead of its internal stub. This is cleaner than our current approach (timer-based polling via `Retrieve`).
- Alternatively: should we just **disable Membrane's internal consolidation** entirely and own the full pipeline from the plugin side?
- Is there a **consolidation lock** or flag we should respect to avoid both systems running simultaneously?

## 3. Health Check

We currently probe the sidecar via `GetMetrics()` as a health check. This works but it's not ideal.

- Would you consider adding **standard gRPC health check** (`grpc.health.v1.Health`) to `membraned`?
- Or is there a **lighter endpoint** we missed that's better suited for health probes?
- What's the expected **startup time** for `membraned`? We currently retry health checks 10x with 500ms intervals (5 seconds total). Is that enough?

## 4. Working State & Thread IDs

`IngestWorkingState` requires a `threadId`. In OpenClaw, we have multiple ID concepts:

- **Session Key** (e.g. `agent:main:main`) — identifies the agent session
- **Session ID** (UUID) — unique per session lifecycle
- **Cortex Thread ID** — conversation topic thread (if cortex plugin is active)

**Which should we use as `threadId`?** Our current plan is Session Key, but we want to make sure this plays well with Membrane's retrieval and decay logic. Does `threadId` affect how records are grouped or decayed?

## 5. Sidecar Binary Distribution

Our plan: auto-download from GitHub releases on first run.

- **Are you publishing release binaries** on GitHub? If yes, what's the naming convention? We assumed: `membrane-{version}-{os}-{arch}.tar.gz`
- Which **platforms** are you building for? We need at minimum: `linux-amd64`, `linux-arm64`, `darwin-arm64`
- Is there a **checksum file** alongside releases for verification?
- Would you prefer we use a **Go install** approach instead (`go install github.com/GustyCube/membrane/cmd/membraned@latest`)? That would require Go on the user's machine though.

## 6. Sensitivity / Trust Model

The Cerberus code audit flagged a **CRITICAL**: `SensitivityLevel()` returns -1 for unknown values, which bypasses all trust gates.

- Is this a **known issue** or something you'd like us to file?
- Our plugin always sets explicit sensitivity values (`low`, `medium`, `high`, `critical`) — so we're safe on our end. But other clients could send invalid values.
- **Suggestion:** Return `critical` (most restrictive) as default for unknown sensitivity, rather than -1. Would you accept a PR for that?

## 7. Batch Ingestion

Our consolidation pipeline may produce 10-50 records per cycle. Currently we'd call `IngestObservation` / `IngestToolOutput` individually.

- Would you consider adding **`IngestBatch(records[])`** to reduce gRPC round-trips?
- Not a blocker for v0.1.0, but would be nice for performance.

## 8. Record Limits & Pruning

- Is there a **maximum record count** before performance degrades? We're running ~245k events in our NATS store — Membrane won't see all of those, but we want to understand the scale.
- How does **pruning** work in practice? When salience drops below threshold, are records deleted or just hidden from retrieval?
- Can we configure **per-type retention limits** (e.g. max 1000 episodic, unlimited semantic)?

## 9. Monorepo Build Integration

- What's your **build system**? We saw Go modules for the server — is there a top-level Makefile or build script?
- Should `clients/openclaw/` have its own **CI workflow** (`.github/workflows/test-openclaw.yml`) or integrate into an existing one?
- Any **linting/formatting** conventions we should follow for the TypeScript code?

## 10. Existing Tests & Mocking

- Does `clients/typescript/` have **integration tests** against a real `membraned` instance? If so, how do you run them?
- Is there a **mock gRPC server** or test fixtures we can reuse, or should we build our own?
- Any **proto file changes** planned for the near future that might affect our hook mapping?

---

## Non-Blocking, Just FYI

These are things we've already decided but want you to be aware of:

- **Plugin lives in `clients/openclaw/`** alongside the TS client
- **npm scope:** `@vainplex/openclaw-membrane` — our publishing pipeline
- **License:** MIT (matching Membrane)
- **Hook priorities:** We run before cortex (priority 5 vs 10) for session_start context injection
- **LLM consolidation is opt-in** — regex extraction works without any LLM
- **We don't touch Membrane's Go code** in v0.1.0 — pure client-side plugin

---

Let us know what works, what needs changing, and which questions are blockers vs. nice-to-have. Happy to hop on a call if easier.

— Albert (Vainplex)
