# Questions for GustyCube — OpenClaw Membrane Plugin

Hey Bennett! We've gone through the docs at membrane.gustycube.com and the RFC spec, and finished our architecture draft for the OpenClaw plugin (`clients/openclaw/`). Most things are clear — just a few questions before we start coding.

---

## 1. Consolidation: Coexistence or Replacement?

Your docs show consolidation already runs on a 6h interval with 4 sub-consolidators (episodic compression → semantic → competence → plan graph). Our plugin adds LLM-enhanced consolidation on top.

- Should we **disable Membrane's built-in consolidation** (`consolidation_interval: 0`?) and own the full pipeline? Or run both side by side?
- If side by side: is there a **lock or mutex** to prevent both from writing at the same time?
- Would you accept a **consolidation callback/hook** in `membraned` so it delegates to our plugin instead of its internal logic? Cleaner than timer-based polling.

## 2. Working State — Thread ID Semantics

`IngestWorkingState` requires a `thread_id`. In OpenClaw we have:
- **Session Key** (e.g. `agent:main:main`) — stable across restarts
- **Session ID** (UUID) — unique per lifecycle

We'd use Session Key. Does `thread_id` affect **retrieval grouping or decay**? Or is it purely organizational?

## 3. Sidecar Binary Distribution

We want to auto-download `membraned` from GitHub releases on first plugin start.

- **Are you publishing release binaries?** What's the naming convention? We assumed `membrane-{version}-{os}-{arch}.tar.gz`
- **Platforms:** Do you build for `linux-amd64`, `linux-arm64`, `darwin-arm64`?
- **Checksums** alongside releases?
- Or would you prefer a `go install github.com/GustyCube/membrane/cmd/membraned@latest` approach?

## 4. Sensitivity Bug

Our code audit found that `SensitivityLevel()` returns `-1` for unknown values — which bypasses trust gates (anything < 0 passes all `<=` checks).

We noticed the valid levels are: `public`(0), `low`(1), `medium`(2), `high`(3), `hyper`(4).

- **Known issue?** Would you accept a PR that defaults unknown sensitivity to `hyper` (most restrictive) instead of `-1`?

## 5. Batch Ingestion

Our consolidation produces 10-50 records per cycle. Currently we'd call `IngestObservation` / `IngestToolOutput` one by one.

- Any interest in an **`IngestBatch(records[])`** RPC to reduce round-trips? Not a blocker for v0.1.0, but nice for performance.

## 6. Scale & Pruning

Your docs say decay auto-prunes when salience drops below threshold, and episodic memory is append-only.

- Is there a **practical record count limit** before SQLite performance degrades? We run ~245k events in NATS — Membrane won't see all of those, but want to understand the ceiling.
- Can we configure **per-type retention limits** (e.g. max 1000 episodic, unlimited semantic)?

---

## Already Answered (from your docs)

For reference — we found answers to these in your documentation:

- ✅ **TS Client**: Published as `@gustycube/membrane` on npm — we'll use that directly
- ✅ **Health Check**: `GetMetrics()` works, we'll use it (startup retry: 10x 500ms)
- ✅ **Build System**: `make build`, Go modules, YAML config
- ✅ **Security**: SQLCipher + TLS + Bearer token auth + rate limiting — solid
- ✅ **Sensitivity Levels**: `public` / `low` / `medium` / `high` / `hyper` (5 levels, not 4)

## Non-Blocking FYI

- Plugin lives in `clients/openclaw/`, npm scope `@vainplex/openclaw-membrane`
- License: MIT (matching Membrane)
- LLM consolidation is opt-in — regex extraction works without any LLM
- We don't touch Membrane's Go code in v0.1.0 — pure client-side plugin
- Hook priorities: we run before cortex (priority 5 vs 10) for context injection

---

Let us know which questions are blockers vs. nice-to-have. Happy to hop on a call if easier.

— Albert (Vainplex)
