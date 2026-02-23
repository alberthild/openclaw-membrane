# Changelog

## [0.3.0] — 2026-02-23

### Added
- `membrane_search` tool — gRPC Retrieve with client-side filtering, prioritizes user/assistant messages
- `before_agent_start` hook — auto-injects `<membrane-context>` into system prompt
- `parser.ts` — shared record parser for all 4 Membrane memory types (episodic, semantic, competence, working)
- `types.ts` — full TypeScript interfaces (PluginApi, PluginConfig, MembraneRecord, etc.)
- `validateConfig()` — typed config extraction (rejects wrong types)
- `maxRetries` cap (10) on reliability buffer — prevents infinite retry loops
- 44 tests across 4 files (parser, mapping, buffer, config)

### Changed
- `register()` refactored from 277 lines to 38 (split into 7 focused functions)
- `mapEvent()` refactored from 82 lines to 10 (6 individual mappers)
- Zero `any` remaining (was 18)
- Logger passed to ReliabilityManager (was `console.error`)
- All catches log with `logger.debug/warn` (was silent `catch {}`)

### Removed
- Hardcoded API key fallback — auth via `MEMBRANE_API_KEY` env only
- Module-level mutable state — now closure-scoped in `register()`

### Security
- Removed `'anothersecretapi456'` hardcoded credential from client.ts

## [0.1.0] — 2026-02-23

### Added
- Initial plugin: event ingestion via gRPC IngestEvent
- Ring buffer with retry logic and exponential backoff
- Event mapping for 6 OpenClaw event types
- Sensitivity mapping with secure fallback
