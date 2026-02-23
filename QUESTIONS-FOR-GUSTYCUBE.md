# Questions for GustyCube — OpenClaw Membrane Plugin

Hey Bennett! We're building a clean OpenClaw wrapper plugin for Membrane — just store, query, retrieve. No cross-repo wiring, that's a later step. Three questions before we start coding:

---

## 1. Thread ID Semantics

`IngestWorkingState` requires a `thread_id`. In OpenClaw we have:
- **Session Key** (e.g. `agent:main:main`) — stable across restarts
- **Session ID** (UUID) — unique per lifecycle

We'd use Session Key. Does `thread_id` affect **retrieval grouping or decay**? Or is it purely organizational?

## 2. Sidecar Binary Distribution

We want to auto-download `membraned` from GitHub releases on first plugin start.

- **Are you publishing release binaries?** What's the naming convention? (e.g. `membrane-{version}-{os}-{arch}.tar.gz`)
- **Platforms:** `linux-amd64`, `linux-arm64`, `darwin-arm64`?
- **Checksums** alongside releases?
- Or would you prefer a `go install github.com/GustyCube/membrane/cmd/membraned@latest` approach?

## 3. Sensitivity Bug

Our code audit found that `SensitivityLevel()` returns `-1` for unknown values — which bypasses trust gates (anything < 0 passes all `<=` checks).

Valid levels: `public`(0), `low`(1), `medium`(2), `high`(3), `hyper`(4).

- **Known issue?** Would you accept a PR that defaults unknown sensitivity to `hyper` (most restrictive) instead of `-1`?

---

## Already Answered (from your docs)

- ✅ **TS Client**: `@gustycube/membrane` on npm
- ✅ **Health Check**: `GetMetrics()` — we'll use it
- ✅ **Consolidation**: Runs every 6h with 4 sub-consolidators — we'll use it as-is in v0.1
- ✅ **Build System**: `make build`, Go 1.24+, YAML config
- ✅ **Security**: SQLCipher + TLS + Bearer token auth + rate limiting

## FYI

- Plugin scope: `@vainplex/openclaw-membrane` (MIT license)
- Pure client-side wrapper — we don't touch Membrane's Go code
- Integration with our other plugins (cortex, knowledge engine) is a separate step later

---

— Albert (Vainplex)
