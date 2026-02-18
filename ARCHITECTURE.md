# @vainplex/openclaw-membrane — Architecture

**Plugin #5 in the Vainplex Plugin Suite**
**Version:** 0.1.0
**Location:** `clients/openclaw/` in GustyCube/membrane monorepo
**Depends on:** `clients/typescript/` (Membrane TS client)

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         OpenClaw Gateway                             │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │              @vainplex/openclaw-membrane                      │    │
│  │                                                               │    │
│  │  ┌─────────┐   ┌──────────────────┐   ┌──────────────────┐  │    │
│  │  │  hooks   │──→│ ingestion-bridge │──→│   grpc-client    │──┼────┼──→ gRPC :9090
│  │  │  .ts     │   └──────────────────┘   │   .ts            │  │    │
│  │  │          │   ┌──────────────────┐   │                  │  │    │
│  │  │          │──→│ retrieval-bridge │←──│  (MembraneClient │  │    │
│  │  │          │   └──────────────────┘   │   from clients/  │  │    │
│  │  │          │   ┌──────────────────┐   │   typescript/)   │  │    │
│  │  │          │──→│  competence-     │──→│                  │──┼────┼──→ gRPC :9090
│  │  │          │   │  tracker.ts      │   └──────────────────┘  │    │
│  │  └─────────┘   └──────────────────┘                          │    │
│  │                                                               │    │
│  │  ┌──────────────────┐   ┌──────────────────┐                 │    │
│  │  │  consolidator    │──→│   llm-client      │──→ LLM API     │    │
│  │  │  .ts             │   └──────────────────┘                 │    │
│  │  │  (timer-driven)  │──→ grpc-client ─────────────────────────┼────┼──→ gRPC :9090
│  │  └──────────────────┘                                        │    │
│  │                                                               │    │
│  │  ┌──────────────────┐                                        │    │
│  │  │ sidecar-manager  │──→ spawn/kill membraned process        │    │
│  │  │ .ts              │                                        │    │
│  │  └──────────────────┘                                        │    │
│  └──────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              │ child_process.spawn
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                    membraned (Go Sidecar)                     │
│                                                               │
│  gRPC 127.0.0.1:9090                                         │
│  ├── IngestEvent / IngestToolOutput / IngestObservation       │
│  ├── IngestOutcome / IngestWorkingState                       │
│  ├── Retrieve / RetrieveById                                  │
│  ├── Supersede / Fork / Retract / Merge / Contest             │
│  ├── Reinforce / Penalize                                     │
│  └── GetMetrics                                               │
│                                                               │
│  Background:                                                  │
│  ├── Decay scheduler (exponential/linear)                     │
│  ├── Pruning (salience < threshold)                           │
│  └── Consolidation stub (we replace via LLM)                  │
│                                                               │
│  Storage: SQLCipher (membrane.db)                             │
└──────────────────────────────────────────────────────────────┘
```

---

## File Structure

```
clients/openclaw/
├── index.ts                    # Plugin entry point — register(api)
├── package.json                # @vainplex/openclaw-membrane
├── tsconfig.json               # TypeScript config (strict, ESM)
├── openclaw.plugin.json        # Plugin manifest
├── README.md                   # User-facing documentation
├── LICENSE                     # MIT
├── src/
│   ├── types.ts                # All TypeScript types (plugin API, config, internal)
│   ├── config.ts               # Config resolution with defaults
│   ├── sidecar-manager.ts      # membraned process lifecycle
│   ├── grpc-client.ts          # Thin wrapper around Membrane TS client
│   ├── hooks.ts                # Hook registration orchestrator
│   ├── ingestion-bridge.ts     # Hook events → Membrane ingestion calls
│   ├── retrieval-bridge.ts     # Membrane retrieval → context injection
│   ├── consolidator.ts         # LLM-enhanced + regex consolidation
│   ├── competence-tracker.ts   # Tool call pattern tracking
│   ├── patterns.ts             # Regex patterns for S-P-O extraction
│   └── context-formatter.ts    # Format retrieved records for agent context
├── test/
│   ├── config.test.ts
│   ├── sidecar-manager.test.ts
│   ├── ingestion-bridge.test.ts
│   ├── retrieval-bridge.test.ts
│   ├── consolidator.test.ts
│   ├── competence-tracker.test.ts
│   ├── patterns.test.ts
│   ├── context-formatter.test.ts
│   ├── hooks.test.ts
│   └── helpers/
│       ├── mock-grpc-server.ts  # Mock Membrane gRPC for tests
│       └── mock-llm-server.ts   # Mock OpenAI-compatible API
└── scripts/
    └── install-sidecar.ts       # npx openclaw-membrane install-sidecar
```

---

## Module Specifications

### 1. index.ts — Plugin Entry Point

**Responsibility:** Register the plugin with OpenClaw, wire up all components.

```typescript
import type { OpenClawPluginApi } from "./src/types.js";
import { resolveConfig } from "./src/config.js";
import { SidecarManager } from "./src/sidecar-manager.js";
import { GrpcClient } from "./src/grpc-client.js";
import { registerMembraneHooks } from "./src/hooks.js";

const plugin = {
  id: "openclaw-membrane",
  name: "OpenClaw Membrane",
  description:
    "Structured memory with revision operations, competence learning, and decay — powered by Membrane sidecar",
  version: "0.1.0",

  register(api: OpenClawPluginApi): void {
    const config = resolveConfig(api.pluginConfig);

    if (!config.enabled) {
      api.logger.info("[membrane] Disabled via config");
      return;
    }

    api.logger.info("[membrane] Registering memory substrate hooks...");

    // Shared state
    const sidecar = new SidecarManager(config.sidecar, api.logger);
    const grpc = new GrpcClient(config.sidecar.port, api.logger);

    // Register sidecar as a managed service
    api.registerService({
      id: "membrane-sidecar",
      start: async (ctx) => {
        if (!config.sidecar.autoStart) {
          api.logger.info("[membrane] Sidecar autoStart disabled, skipping");
          return;
        }
        await sidecar.start();
        await grpc.connect();
        api.logger.info(`[membrane] Sidecar ready on :${sidecar.actualPort}`);
      },
      stop: async (ctx) => {
        await grpc.disconnect();
        await sidecar.stop();
        api.logger.info("[membrane] Sidecar stopped");
      },
    });

    // Register all hook handlers
    registerMembraneHooks(api, config, grpc);

    // Register /membranestatus command
    api.registerCommand({
      name: "membranestatus",
      description: "Show Membrane sidecar status and memory statistics",
      requireAuth: true,
      handler: async () => {
        try {
          const metrics = await grpc.getMetrics();
          const sidecarStatus = sidecar.status();
          return {
            text: [
              "**Membrane Status**",
              `Sidecar: ${sidecarStatus.running ? "✅ running" : "❌ stopped"} (pid: ${sidecarStatus.pid ?? "n/a"})`,
              `Port: ${sidecar.actualPort}`,
              `Records: ${metrics?.totalRecords ?? "n/a"}`,
              `Types: episodic=${metrics?.episodic ?? 0} semantic=${metrics?.semantic ?? 0} competence=${metrics?.competence ?? 0} working=${metrics?.working ?? 0} plan=${metrics?.plan ?? 0}`,
              `Last consolidation: ${metrics?.lastConsolidation ?? "never"}`,
              `gRPC errors (1h): ${grpc.errorCount}`,
            ].join("\n"),
          };
        } catch {
          return { text: "[membrane] Status: sidecar unreachable" };
        }
      },
    });

    // Register /membranerecall command
    api.registerCommand({
      name: "membranerecall",
      description: "Query Membrane memory manually",
      requireAuth: true,
      handler: async (args) => {
        const query = (args?.query as string) ?? "recent";
        try {
          const records = await grpc.retrieve(query, {
            limit: 10,
            minSalience: 0.1,
          });
          if (!records.length) return { text: "[membrane] No records found" };
          const lines = records.map(
            (r) => `- [${r.salience.toFixed(2)}] ${r.memoryType}: ${r.summary}`
          );
          return { text: `**Recall: "${query}"**\n${lines.join("\n")}` };
        } catch {
          return { text: "[membrane] Recall failed: sidecar unreachable" };
        }
      },
    });

    // Register gateway methods for inter-plugin use
    api.registerGatewayMethod?.("membrane.status", async () => {
      return { sidecar: sidecar.status(), metrics: await grpc.getMetrics() };
    });

    api.registerGatewayMethod?.("membrane.retrieve", async (params: any) => {
      return grpc.retrieve(params.query, params.options);
    });

    api.logger.info("[membrane] Ready");
  },
};

export default plugin;
```

### 2. src/types.ts — Type Definitions

```typescript
// ============================================================
// OpenClaw Plugin API (subset — what this plugin needs)
// ============================================================

export type PluginLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug: (msg: string) => void;
};

export type OpenClawPluginApi = {
  id: string;
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  config: Record<string, unknown>;
  registerService: (service: PluginService) => void;
  registerCommand: (command: PluginCommand) => void;
  registerGatewayMethod?: (method: string, handler: (...args: any[]) => any) => void;
  on: (
    hookName: string,
    handler: (event: HookEvent, ctx: HookContext) => void | Promise<void>,
    opts?: { priority?: number },
  ) => void;
};

export type PluginService = {
  id: string;
  start: (ctx: ServiceContext) => Promise<void>;
  stop: (ctx: ServiceContext) => Promise<void>;
};

export type ServiceContext = {
  logger: PluginLogger;
  config: Record<string, unknown>;
};

export type PluginCommand = {
  name: string;
  description: string;
  requireAuth?: boolean;
  handler: (args?: Record<string, unknown>) => { text: string } | Promise<{ text: string }>;
};

export type HookEvent = {
  content?: string;
  message?: string;
  text?: string;
  from?: string;
  to?: string;
  sender?: string;
  role?: string;
  timestamp?: string;
  sessionId?: string;
  messageCount?: number;
  compactingCount?: number;
  compactingMessages?: CompactingMessage[];
  // Tool call hooks
  toolName?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs?: number;
  success?: boolean;
  [key: string]: unknown;
};

export type HookContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  channelId?: string;
  workspaceDir?: string;
  injectSystemContext?: (content: string) => void;
};

export type CompactingMessage = {
  role: string;
  content: string;
  timestamp?: string;
};

// ============================================================
// Plugin Config Types
// ============================================================

export type MembraneConfig = {
  enabled: boolean;
  sidecar: SidecarConfig;
  ingestion: IngestionConfig;
  retrieval: RetrievalConfig;
  consolidation: ConsolidationConfig;
  competence: CompetenceConfig;
};

export type SidecarConfig = {
  binary: string;
  autoStart: boolean;
  autoDownload: boolean;
  version: string;
  port: number;
  dbPath: string;
  encryptionKey: string;
  decayInterval: string;
  maxRestarts: number;
};

export type IngestionConfig = {
  captureMessages: boolean;
  captureToolCalls: boolean;
  captureWorkingState: boolean;
  defaultSensitivity: Sensitivity;
  regexExtraction: boolean;
};

export type RetrievalConfig = {
  onSessionStart: boolean;
  maxRecords: number;
  minSalience: number;
  memoryTypes: MemoryType[];
  contextFormat: "markdown" | "json";
};

export type ConsolidationConfig = {
  enabled: boolean;
  intervalMinutes: number;
  llmEnabled: boolean;
  llmEndpoint: string;
  llmModel: string;
  llmApiKey: string;
  llmTimeoutMs: number;
  batchSize: number;
  minConfidence: number;
};

export type CompetenceConfig = {
  enabled: boolean;
  minOccurrences: number;
  reinforceOnSuccess: boolean;
  penalizeOnFailure: boolean;
  penaltyAmount: number;
};

// ============================================================
// Membrane Domain Types
// ============================================================

export type MemoryType = "episodic" | "semantic" | "competence" | "working" | "plan_graph";
export type Sensitivity = "low" | "medium" | "high" | "critical";

export type MemoryRecord = {
  id: string;
  memoryType: MemoryType;
  content: Record<string, unknown>;
  sensitivity: Sensitivity;
  salience: number;
  createdAt: string;
  updatedAt: string;
  summary: string;
  tags?: string[];
  actor?: string;
  lineage?: Lineage;
};

export type Lineage = {
  parentIds: string[];
  operation: "original" | "supersede" | "fork" | "merge";
  actor: string;
  rationale: string;
  timestamp: string;
};

export type RetrievalOptions = {
  memoryTypes?: MemoryType[];
  minSalience?: number;
  limit?: number;
  sensitivity?: Sensitivity;
  since?: string;
  tags?: string[];
};

// ============================================================
// Consolidation Types
// ============================================================

export type ConsolidationResult = {
  facts: ExtractedFact[];
  competence: ExtractedCompetence[];
  corrections: ExtractedCorrection[];
};

export type ExtractedFact = {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
};

export type ExtractedCompetence = {
  skill: string;
  triggers: string[];
  steps: string[];
  outcome: "success" | "failure";
};

export type ExtractedCorrection = {
  oldFact: string;
  newFact: string;
  reason: string;
};

// ============================================================
// Competence Tracker Types
// ============================================================

export type ToolCallRecord = {
  toolName: string;
  args: Record<string, unknown>;
  startTime: number;
  sessionId: string;
};

export type ToolStats = {
  toolName: string;
  calls: number;
  successes: number;
  failures: number;
  failureModes: Map<string, number>;
  totalDurationMs: number;
  lastUsed: number;
  membraneRecordId: string | null;
};

// ============================================================
// Sidecar Types
// ============================================================

export type SidecarStatus = {
  running: boolean;
  pid: number | null;
  port: number;
  uptime: number | null;
  restartCount: number;
};

export type SidecarConfigYaml = {
  listen: string;
  database: {
    path: string;
    encryption_key?: string;
  };
  decay: {
    interval: string;
  };
  log_level: string;
};
```

### 3. src/config.ts — Configuration Resolution

```typescript
import type { MembraneConfig, MemoryType, Sensitivity } from "./types.js";

export const DEFAULTS: MembraneConfig = {
  enabled: true,
  sidecar: {
    binary: "~/.openclaw/membrane/bin/membraned",
    autoStart: true,
    autoDownload: true,
    version: "latest",
    port: 9090,
    dbPath: "~/.openclaw/membrane/membrane.db",
    encryptionKey: "",
    decayInterval: "1h",
    maxRestarts: 3,
  },
  ingestion: {
    captureMessages: true,
    captureToolCalls: true,
    captureWorkingState: true,
    defaultSensitivity: "low",
    regexExtraction: true,
  },
  retrieval: {
    onSessionStart: true,
    maxRecords: 20,
    minSalience: 0.3,
    memoryTypes: ["semantic", "competence", "working"],
    contextFormat: "markdown",
  },
  consolidation: {
    enabled: true,
    intervalMinutes: 30,
    llmEnabled: false,
    llmEndpoint: "http://localhost:11434/v1",
    llmModel: "mistral:7b",
    llmApiKey: "",
    llmTimeoutMs: 30000,
    batchSize: 50,
    minConfidence: 0.6,
  },
  competence: {
    enabled: true,
    minOccurrences: 3,
    reinforceOnSuccess: true,
    penalizeOnFailure: true,
    penaltyAmount: 0.1,
  },
};

// --- Utility helpers (same pattern as cortex config.ts) ---

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function int(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  return fallback;
}

function float(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function sensitivity(value: unknown): Sensitivity {
  if (value === "low" || value === "medium" || value === "high" || value === "critical") return value;
  return "low";
}

function memoryTypes(value: unknown): MemoryType[] {
  if (!Array.isArray(value)) return DEFAULTS.retrieval.memoryTypes;
  const valid: MemoryType[] = ["episodic", "semantic", "competence", "working", "plan_graph"];
  return value.filter((v): v is MemoryType => valid.includes(v as MemoryType));
}

function contextFormat(value: unknown): "markdown" | "json" {
  return value === "json" ? "json" : "markdown";
}

/**
 * Resolve environment variable references in strings.
 * Supports ${VAR_NAME} syntax.
 */
function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    return process.env[varName] ?? "";
  });
}

/**
 * Expand ~ to home directory.
 */
function expandHome(path: string): string {
  if (path.startsWith("~/")) {
    return path.replace("~", process.env.HOME ?? "/tmp");
  }
  return path;
}

/**
 * Resolve plugin config from openclaw.json into a typed MembraneConfig.
 * All values have sensible defaults. Missing keys are filled.
 */
export function resolveConfig(pluginConfig?: Record<string, unknown>): MembraneConfig {
  const raw = pluginConfig ?? {};
  const sc = (raw.sidecar ?? {}) as Record<string, unknown>;
  const ig = (raw.ingestion ?? {}) as Record<string, unknown>;
  const rt = (raw.retrieval ?? {}) as Record<string, unknown>;
  const cn = (raw.consolidation ?? {}) as Record<string, unknown>;
  const cp = (raw.competence ?? {}) as Record<string, unknown>;

  // Encryption key: config value → env var → empty
  const encKey = str(sc.encryptionKey, "");
  const resolvedEncKey = encKey
    ? resolveEnvVars(encKey)
    : (process.env.MEMBRANE_ENCRYPTION_KEY ?? "");

  return {
    enabled: bool(raw.enabled, DEFAULTS.enabled),
    sidecar: {
      binary: expandHome(str(
        process.env.MEMBRANE_BINARY ?? sc.binary,
        DEFAULTS.sidecar.binary,
      )),
      autoStart: bool(sc.autoStart, DEFAULTS.sidecar.autoStart),
      autoDownload: bool(sc.autoDownload, DEFAULTS.sidecar.autoDownload),
      version: str(sc.version, DEFAULTS.sidecar.version),
      port: int(
        process.env.MEMBRANE_PORT ? Number(process.env.MEMBRANE_PORT) : sc.port,
        DEFAULTS.sidecar.port,
      ),
      dbPath: expandHome(str(sc.dbPath, DEFAULTS.sidecar.dbPath)),
      encryptionKey: resolvedEncKey,
      decayInterval: str(sc.decayInterval, DEFAULTS.sidecar.decayInterval),
      maxRestarts: int(sc.maxRestarts, DEFAULTS.sidecar.maxRestarts),
    },
    ingestion: {
      captureMessages: bool(ig.captureMessages, DEFAULTS.ingestion.captureMessages),
      captureToolCalls: bool(ig.captureToolCalls, DEFAULTS.ingestion.captureToolCalls),
      captureWorkingState: bool(ig.captureWorkingState, DEFAULTS.ingestion.captureWorkingState),
      defaultSensitivity: sensitivity(ig.defaultSensitivity),
      regexExtraction: bool(ig.regexExtraction, DEFAULTS.ingestion.regexExtraction),
    },
    retrieval: {
      onSessionStart: bool(rt.onSessionStart, DEFAULTS.retrieval.onSessionStart),
      maxRecords: int(rt.maxRecords, DEFAULTS.retrieval.maxRecords),
      minSalience: float(rt.minSalience, DEFAULTS.retrieval.minSalience),
      memoryTypes: memoryTypes(rt.memoryTypes),
      contextFormat: contextFormat(rt.contextFormat),
    },
    consolidation: {
      enabled: bool(cn.enabled, DEFAULTS.consolidation.enabled),
      intervalMinutes: int(cn.intervalMinutes, DEFAULTS.consolidation.intervalMinutes),
      llmEnabled: bool(cn.llmEnabled, DEFAULTS.consolidation.llmEnabled),
      llmEndpoint: str(cn.llmEndpoint, DEFAULTS.consolidation.llmEndpoint),
      llmModel: str(cn.llmModel, DEFAULTS.consolidation.llmModel),
      llmApiKey: resolveEnvVars(str(cn.llmApiKey, DEFAULTS.consolidation.llmApiKey)),
      llmTimeoutMs: int(cn.llmTimeoutMs, DEFAULTS.consolidation.llmTimeoutMs),
      batchSize: int(cn.batchSize, DEFAULTS.consolidation.batchSize),
      minConfidence: float(cn.minConfidence, DEFAULTS.consolidation.minConfidence),
    },
    competence: {
      enabled: bool(cp.enabled, DEFAULTS.competence.enabled),
      minOccurrences: int(cp.minOccurrences, DEFAULTS.competence.minOccurrences),
      reinforceOnSuccess: bool(cp.reinforceOnSuccess, DEFAULTS.competence.reinforceOnSuccess),
      penalizeOnFailure: bool(cp.penalizeOnFailure, DEFAULTS.competence.penalizeOnFailure),
      penaltyAmount: float(cp.penaltyAmount, DEFAULTS.competence.penaltyAmount),
    },
  };
}
```

### 4. src/sidecar-manager.ts — Process Lifecycle

```typescript
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { stringify as yamlStringify } from "./yaml-minimal.js"; // or inline YAML writer
import type { SidecarConfig, SidecarStatus, SidecarConfigYaml, PluginLogger } from "./types.js";

/**
 * Manages the membraned Go sidecar process lifecycle.
 *
 * Responsibilities:
 * - Write sidecar config YAML
 * - Spawn/kill the membraned process
 * - Health check via port probe
 * - Crash recovery with restart limits
 * - Port conflict resolution
 */
export class SidecarManager {
  private process: ChildProcess | null = null;
  private config: SidecarConfig;
  private logger: PluginLogger;
  private configPath: string | null = null;
  private restartCount = 0;
  private restartWindowStart = 0;
  private _actualPort: number;
  private startTime: number | null = null;

  constructor(config: SidecarConfig, logger: PluginLogger) {
    this.config = config;
    this.logger = logger;
    this._actualPort = config.port;
  }

  get actualPort(): number {
    return this._actualPort;
  }

  /**
   * Start the membraned sidecar process.
   *
   * Steps:
   * 1. Check binary exists (or trigger download if autoDownload)
   * 2. Ensure database directory exists
   * 3. Find available port
   * 4. Write config YAML to temp file
   * 5. Spawn process
   * 6. Wait for health check
   * 7. Set up crash handler
   */
  async start(): Promise<void> {
    // 1. Binary check
    if (!existsSync(this.config.binary)) {
      if (this.config.autoDownload) {
        await this.downloadBinary();
      } else {
        this.logger.error(
          `[membrane] Binary not found at ${this.config.binary}. ` +
          `Run: npx openclaw-membrane install-sidecar`
        );
        return;
      }
    }

    // 2. Ensure DB directory
    const dbDir = dirname(this.config.dbPath);
    mkdirSync(dbDir, { recursive: true });

    // 3. Find available port (check if existing membraned is running)
    this._actualPort = await this.findAvailablePort(this.config.port);

    // 4. Write config YAML
    this.configPath = this.writeConfigYaml();

    // 5. Spawn
    this.logger.info(`[membrane] Starting sidecar: ${this.config.binary} serve --config ${this.configPath}`);
    this.process = spawn(this.config.binary, ["serve", "--config", this.configPath], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    this.startTime = Date.now();

    // Capture stdout/stderr
    this.process.stdout?.on("data", (data: Buffer) => {
      this.logger.debug(`[membraned] ${data.toString().trim()}`);
    });
    this.process.stderr?.on("data", (data: Buffer) => {
      this.logger.warn(`[membraned] ${data.toString().trim()}`);
    });

    // 6. Set up crash handler
    this.process.on("exit", (code, signal) => {
      this.logger.warn(`[membrane] Sidecar exited: code=${code} signal=${signal}`);
      this.process = null;
      this.handleCrash();
    });

    // 7. Wait for health
    await this.waitForHealth();
  }

  /**
   * Stop the sidecar gracefully.
   */
  async stop(): Promise<void> {
    if (!this.process) return;

    const proc = this.process;
    this.process = null; // Prevent crash handler from restarting

    // SIGTERM
    proc.kill("SIGTERM");

    // Wait up to 5s
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 5000);

      proc.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    // Cleanup temp config
    if (this.configPath) {
      try { unlinkSync(this.configPath); } catch { /* ignore */ }
      this.configPath = null;
    }

    this.startTime = null;
  }

  /**
   * Get current sidecar status.
   */
  status(): SidecarStatus {
    return {
      running: this.process !== null && !this.process.killed,
      pid: this.process?.pid ?? null,
      port: this._actualPort,
      uptime: this.startTime ? Date.now() - this.startTime : null,
      restartCount: this.restartCount,
    };
  }

  // --- Private methods ---

  private writeConfigYaml(): string {
    const yaml: SidecarConfigYaml = {
      listen: `127.0.0.1:${this._actualPort}`,
      database: {
        path: this.config.dbPath,
      },
      decay: {
        interval: this.config.decayInterval,
      },
      log_level: "info",
    };

    if (this.config.encryptionKey) {
      yaml.database.encryption_key = this.config.encryptionKey;
    }

    const configPath = join(tmpdir(), `membrane-${process.pid}.yaml`);
    const content = serializeYaml(yaml);
    writeFileSync(configPath, content, { mode: 0o600 });
    return configPath;
  }

  private async findAvailablePort(startPort: number): Promise<number> {
    for (let port = startPort; port <= startPort + 5; port++) {
      const inUse = await this.isPortInUse(port);
      if (!inUse) return port;

      // Port in use — check if it's an existing membraned
      const isMembraned = await this.probeMembraned(port);
      if (isMembraned) {
        this.logger.info(`[membrane] Reusing existing membraned on :${port}`);
        return port;
      }

      this.logger.warn(`[membrane] Port ${port} in use by non-membrane process, trying ${port + 1}`);
    }

    throw new Error(`[membrane] No available port in range ${startPort}-${startPort + 5}`);
  }

  private isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const net = require("node:net");
      const server = net.createServer();
      server.once("error", () => resolve(true));
      server.once("listening", () => { server.close(); resolve(false); });
      server.listen(port, "127.0.0.1");
    });
  }

  private async probeMembraned(port: number): Promise<boolean> {
    // Try a gRPC GetMetrics call — if it responds, it's membraned
    try {
      // Lightweight probe: just check if something speaks gRPC on this port
      // Full implementation would use the gRPC client
      return false; // Stub — full implementation checks gRPC health
    } catch {
      return false;
    }
  }

  private async waitForHealth(): Promise<void> {
    const maxAttempts = 10;
    const intervalMs = 500;

    for (let i = 0; i < maxAttempts; i++) {
      await sleep(intervalMs);
      const alive = await this.probeMembraned(this._actualPort);
      if (alive) {
        this.logger.info(`[membrane] Health check passed after ${(i + 1) * intervalMs}ms`);
        return;
      }
    }

    // Process might still be starting — check if it's alive
    if (this.process && !this.process.killed) {
      this.logger.warn(`[membrane] Health check timed out after ${maxAttempts * intervalMs}ms, but process is alive`);
      return;
    }

    throw new Error("[membrane] Sidecar failed to start — health check timed out");
  }

  private handleCrash(): void {
    const now = Date.now();

    // Reset restart window if >5 minutes since last restart
    if (now - this.restartWindowStart > 5 * 60 * 1000) {
      this.restartCount = 0;
      this.restartWindowStart = now;
    }

    this.restartCount++;

    if (this.restartCount > this.config.maxRestarts) {
      this.logger.error(
        `[membrane] Sidecar crashed ${this.restartCount} times in 5 minutes. ` +
        `Not restarting. Memory features disabled until gateway restart.`
      );
      return;
    }

    this.logger.warn(
      `[membrane] Sidecar crashed (restart ${this.restartCount}/${this.config.maxRestarts}). Restarting...`
    );

    // Restart after a short delay
    setTimeout(() => this.start().catch((err) => {
      this.logger.error(`[membrane] Restart failed: ${err}`);
    }), 2000);
  }

  private async downloadBinary(): Promise<void> {
    // Implementation: Download from GitHub releases
    // GET https://api.github.com/repos/GustyCube/membrane/releases/latest
    // (or /tags/{version} if version is specified)
    // Find asset matching platform: linux-amd64, darwin-arm64, etc.
    // Download to config.binary path
    // chmod +x

    const platform = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "amd64"}`;
    this.logger.info(`[membrane] Downloading membraned for ${platform}...`);

    const binDir = dirname(this.config.binary);
    mkdirSync(binDir, { recursive: true });

    // Actual download implementation would use node:https to fetch GitHub release asset
    // For now, throw a helpful error
    throw new Error(
      `[membrane] Auto-download not yet implemented. ` +
      `Please download manually: npx openclaw-membrane install-sidecar`
    );
  }
}

// --- Utility ---

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Minimal YAML serializer for sidecar config.
 * We don't need a full YAML library — the config is flat.
 */
function serializeYaml(obj: Record<string, unknown>, indent = 0): string {
  const lines: string[] = [];
  const pad = "  ".repeat(indent);

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      lines.push(`${pad}${key}:`);
      lines.push(serializeYaml(value as Record<string, unknown>, indent + 1));
    } else if (typeof value === "string") {
      // Quote strings that might be ambiguous YAML
      const needsQuote = /[:#\[\]{}&*!|>'"@`]/.test(value) || value === "";
      lines.push(`${pad}${key}: ${needsQuote ? `"${value}"` : value}`);
    } else {
      lines.push(`${pad}${key}: ${value}`);
    }
  }

  return lines.join("\n");
}
```

### 5. src/grpc-client.ts — Membrane Client Wrapper

```typescript
import type {
  PluginLogger,
  MemoryRecord,
  RetrievalOptions,
  MemoryType,
  Sensitivity,
} from "./types.js";

/**
 * Wraps Membrane's existing TypeScript gRPC client.
 *
 * In the monorepo, this imports from ../../typescript/.
 * In npm distribution, this imports from @gustycube/membrane-client.
 *
 * Adds:
 * - Connection state tracking
 * - Error counting for diagnostics
 * - Graceful fallback when sidecar is unavailable
 * - Helper methods that combine multiple Membrane calls
 */
export class GrpcClient {
  private client: any = null; // MembraneClient from clients/typescript/
  private port: number;
  private logger: PluginLogger;
  private connected = false;
  private _errorCount = 0;
  private errorResetInterval: ReturnType<typeof setInterval> | null = null;

  constructor(port: number, logger: PluginLogger) {
    this.port = port;
    this.logger = logger;
  }

  get errorCount(): number {
    return this._errorCount;
  }

  async connect(): Promise<void> {
    try {
      // Import Membrane TS client
      // In monorepo: import { MembraneClient } from "../../typescript/client.js";
      // In npm: import { MembraneClient } from "@gustycube/membrane-client";
      const { MembraneClient } = await import("../../../typescript/client.js");
      this.client = new MembraneClient(`127.0.0.1:${this.port}`);
      this.connected = true;

      // Reset error counter hourly
      this.errorResetInterval = setInterval(() => { this._errorCount = 0; }, 60 * 60 * 1000);

      this.logger.debug(`[membrane-grpc] Connected to 127.0.0.1:${this.port}`);
    } catch (err) {
      this.logger.error(`[membrane-grpc] Connection failed: ${err}`);
      this.connected = false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.errorResetInterval) {
      clearInterval(this.errorResetInterval);
      this.errorResetInterval = null;
    }
    this.client = null;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected && this.client !== null;
  }

  // --- Ingestion ---

  async ingestEvent(
    eventKind: string,
    ref: string,
    options: {
      content?: string;
      sender?: string;
      timestamp?: string;
      sensitivity?: Sensitivity;
      tags?: string[];
    },
  ): Promise<MemoryRecord | null> {
    return this.call("ingestEvent", () =>
      this.client.ingestEvent(eventKind, ref, options)
    );
  }

  async ingestObservation(
    subject: string,
    predicate: string,
    object: string,
    options?: { sensitivity?: Sensitivity; tags?: string[] },
  ): Promise<MemoryRecord | null> {
    return this.call("ingestObservation", () =>
      this.client.ingestObservation(subject, predicate, object, options)
    );
  }

  async ingestToolOutput(
    toolName: string,
    options: Record<string, unknown>,
  ): Promise<MemoryRecord | null> {
    return this.call("ingestToolOutput", () =>
      this.client.ingestToolOutput(toolName, options)
    );
  }

  async ingestOutcome(
    targetRecordId: string,
    outcomeStatus: string,
    options?: Record<string, unknown>,
  ): Promise<MemoryRecord | null> {
    return this.call("ingestOutcome", () =>
      this.client.ingestOutcome(targetRecordId, outcomeStatus, options)
    );
  }

  async ingestWorkingState(
    threadId: string,
    state: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<MemoryRecord | null> {
    return this.call("ingestWorkingState", () =>
      this.client.ingestWorkingState(threadId, state, options)
    );
  }

  // --- Retrieval ---

  async retrieve(
    taskDescriptor: string,
    options?: RetrievalOptions,
  ): Promise<MemoryRecord[]> {
    return (await this.call("retrieve", () =>
      this.client.retrieve(taskDescriptor, options)
    )) ?? [];
  }

  async retrieveById(recordId: string): Promise<MemoryRecord | null> {
    return this.call("retrieveById", () =>
      this.client.retrieveById(recordId)
    );
  }

  // --- Revision ---

  async supersede(
    oldId: string,
    newRecord: Record<string, unknown>,
    actor: string,
    rationale: string,
  ): Promise<MemoryRecord | null> {
    return this.call("supersede", () =>
      this.client.supersede(oldId, newRecord, actor, rationale)
    );
  }

  async contest(
    recordId: string,
    contestingRef: string,
    actor: string,
    rationale: string,
  ): Promise<void> {
    await this.call("contest", () =>
      this.client.contest(recordId, contestingRef, actor, rationale)
    );
  }

  // --- Decay ---

  async reinforce(
    recordId: string,
    actor: string,
    rationale: string,
  ): Promise<void> {
    await this.call("reinforce", () =>
      this.client.reinforce(recordId, actor, rationale)
    );
  }

  async penalize(
    recordId: string,
    amount: number,
    actor: string,
    rationale: string,
  ): Promise<void> {
    await this.call("penalize", () =>
      this.client.penalize(recordId, amount, actor, rationale)
    );
  }

  // --- Metrics ---

  async getMetrics(): Promise<Record<string, unknown> | null> {
    return this.call("getMetrics", () => this.client.getMetrics());
  }

  // --- Internal ---

  /**
   * Wrapper for all gRPC calls. Handles:
   * - Connection check
   * - Error counting
   * - Graceful null return on failure
   */
  private async call<T>(method: string, fn: () => Promise<T>): Promise<T | null> {
    if (!this.isConnected()) {
      this.logger.debug(`[membrane-grpc] ${method} skipped: not connected`);
      return null;
    }

    try {
      return await fn();
    } catch (err) {
      this._errorCount++;
      this.logger.warn(`[membrane-grpc] ${method} failed: ${err}`);
      return null;
    }
  }
}
```

### 6. src/hooks.ts — Hook Registration Orchestrator

```typescript
import type {
  OpenClawPluginApi,
  MembraneConfig,
  HookEvent,
  HookContext,
} from "./types.js";
import type { GrpcClient } from "./grpc-client.js";
import { IngestionBridge } from "./ingestion-bridge.js";
import { RetrievalBridge } from "./retrieval-bridge.js";
import { Consolidator } from "./consolidator.js";
import { CompetenceTracker } from "./competence-tracker.js";

/**
 * Register all Membrane hook handlers on the OpenClaw plugin API.
 *
 * Hook priorities (lower = runs earlier):
 *   session_start:      5  (before cortex at 10 — memory context first)
 *   before_compaction:   3  (before cortex at 5 — snapshot state before cortex processes)
 *   message_received: 100  (default — non-critical timing)
 *   message_sent:     100  (default)
 *   before_tool_call: 100  (if available)
 *   after_tool_call:  100  (if available)
 *   gateway_stop:    1000  (runs last — cleanup)
 */
export function registerMembraneHooks(
  api: OpenClawPluginApi,
  config: MembraneConfig,
  grpc: GrpcClient,
): void {
  const ingestion = new IngestionBridge(grpc, config.ingestion, api.logger);
  const retrieval = new RetrievalBridge(grpc, config.retrieval, api.logger);
  const competence = config.competence.enabled
    ? new CompetenceTracker(grpc, config.competence, api.logger)
    : null;
  const consolidator = config.consolidation.enabled
    ? new Consolidator(grpc, config.consolidation, api.logger)
    : null;

  // --- session_start: Retrieve + inject context ---
  if (config.retrieval.onSessionStart) {
    api.on(
      "session_start",
      async (event: HookEvent, ctx: HookContext) => {
        try {
          await retrieval.onSessionStart(event, ctx);
        } catch (err) {
          api.logger.warn(`[membrane] session_start error: ${err}`);
        }
      },
      { priority: 5 },
    );
  }

  // --- message_received: Ingest episodic + extract observations ---
  if (config.ingestion.captureMessages) {
    api.on(
      "message_received",
      async (event: HookEvent, ctx: HookContext) => {
        try {
          await ingestion.onMessageReceived(event, ctx);
          consolidator?.buffer(event, "user");
        } catch (err) {
          api.logger.warn(`[membrane] message_received error: ${err}`);
        }
      },
      { priority: 100 },
    );
  }

  // --- message_sent: Ingest episodic + extract observations ---
  if (config.ingestion.captureMessages) {
    api.on(
      "message_sent",
      async (event: HookEvent, ctx: HookContext) => {
        try {
          await ingestion.onMessageSent(event, ctx);
          consolidator?.buffer(event, "assistant");
        } catch (err) {
          api.logger.warn(`[membrane] message_sent error: ${err}`);
        }
      },
      { priority: 100 },
    );
  }

  // --- before_tool_call + after_tool_call: Competence tracking ---
  if (config.ingestion.captureToolCalls && competence) {
    api.on(
      "before_tool_call",
      async (event: HookEvent, ctx: HookContext) => {
        try {
          competence.onToolCall(event, ctx);
        } catch (err) {
          api.logger.warn(`[membrane] before_tool_call error: ${err}`);
        }
      },
      { priority: 100 },
    );

    api.on(
      "after_tool_call",
      async (event: HookEvent, ctx: HookContext) => {
        try {
          await competence.onToolResult(event, ctx);
        } catch (err) {
          api.logger.warn(`[membrane] after_tool_call error: ${err}`);
        }
      },
      { priority: 100 },
    );
  }

  // --- before_compaction: Snapshot working state ---
  if (config.ingestion.captureWorkingState) {
    api.on(
      "before_compaction",
      async (event: HookEvent, ctx: HookContext) => {
        try {
          await ingestion.onBeforeCompaction(event, ctx);
        } catch (err) {
          api.logger.warn(`[membrane] before_compaction error: ${err}`);
        }
      },
      { priority: 3 },
    );
  }

  // --- gateway_stop: Flush + shutdown ---
  api.on(
    "gateway_stop",
    async () => {
      try {
        // Flush pending consolidation
        if (consolidator) {
          api.logger.info("[membrane] Flushing consolidation before shutdown...");
          await consolidator.flush();
        }
        // Flush pending competence records
        if (competence) {
          await competence.flush();
        }
      } catch (err) {
        api.logger.warn(`[membrane] gateway_stop error: ${err}`);
      }
    },
    { priority: 1000 },
  );

  // --- Start consolidation timer ---
  if (consolidator) {
    consolidator.startTimer();
  }

  // Log registration summary
  api.logger.info(
    `[membrane] Hooks registered — ` +
    `messages:${config.ingestion.captureMessages} ` +
    `tools:${config.ingestion.captureToolCalls} ` +
    `working:${config.ingestion.captureWorkingState} ` +
    `retrieval:${config.retrieval.onSessionStart} ` +
    `consolidation:${config.consolidation.enabled}` +
    `${config.consolidation.llmEnabled ? ` (LLM: ${config.consolidation.llmModel})` : ""} ` +
    `competence:${config.competence.enabled}`,
  );
}
```

### 7. src/ingestion-bridge.ts — Hook Events → Membrane Ingestion

```typescript
import type {
  PluginLogger,
  IngestionConfig,
  HookEvent,
  HookContext,
  Sensitivity,
} from "./types.js";
import type { GrpcClient } from "./grpc-client.js";
import { extractSpoTriples } from "./patterns.js";

const ACTOR = "openclaw-membrane";

/**
 * Maps OpenClaw hook events to Membrane ingestion calls.
 *
 * Each method:
 * 1. Extracts relevant data from the hook event
 * 2. Calls the appropriate Membrane ingestion method via gRPC
 * 3. Optionally runs regex extraction for semantic observations
 * 4. Never throws — all errors are logged and swallowed
 */
export class IngestionBridge {
  private grpc: GrpcClient;
  private config: IngestionConfig;
  private logger: PluginLogger;

  constructor(grpc: GrpcClient, config: IngestionConfig, logger: PluginLogger) {
    this.grpc = grpc;
    this.config = config;
    this.logger = logger;
  }

  /**
   * message_received → IngestEvent("user_message") + IngestObservation (regex)
   */
  async onMessageReceived(event: HookEvent, ctx: HookContext): Promise<void> {
    const content = extractContent(event);
    if (!content) return;

    const ref = ctx.sessionId ?? ctx.sessionKey ?? "unknown";

    // 1. Episodic record
    await this.grpc.ingestEvent("user_message", ref, {
      content,
      sender: event.from ?? event.sender ?? "user",
      timestamp: event.timestamp ?? new Date().toISOString(),
      sensitivity: this.resolveSensitivity(ctx),
      tags: ["source:openclaw", `channel:${ctx.channelId ?? "unknown"}`],
    });

    // 2. Regex-extracted semantic observations
    if (this.config.regexExtraction) {
      await this.extractAndIngestObservations(content);
    }
  }

  /**
   * message_sent → IngestEvent("assistant_message") + IngestObservation (regex)
   */
  async onMessageSent(event: HookEvent, ctx: HookContext): Promise<void> {
    const content = extractContent(event);
    if (!content) return;

    const ref = ctx.sessionId ?? ctx.sessionKey ?? "unknown";

    // 1. Episodic record
    await this.grpc.ingestEvent("assistant_message", ref, {
      content,
      sender: "assistant",
      timestamp: event.timestamp ?? new Date().toISOString(),
      sensitivity: this.resolveSensitivity(ctx),
      tags: ["source:openclaw", "role:assistant"],
    });

    // 2. Regex-extracted semantic observations
    if (this.config.regexExtraction) {
      await this.extractAndIngestObservations(content);
    }
  }

  /**
   * before_compaction → IngestWorkingState
   *
   * Captures a snapshot of the current working state before messages are compacted.
   * This preserves task context that would otherwise be lost.
   */
  async onBeforeCompaction(event: HookEvent, ctx: HookContext): Promise<void> {
    const threadId = ctx.sessionId ?? ctx.sessionKey ?? "unknown";
    const messages = event.compactingMessages ?? [];

    // Build state summary from compacting messages
    const state: Record<string, unknown> = {
      messageCount: event.compactingCount ?? messages.length,
      timestamp: new Date().toISOString(),
      summary: summarizeMessages(messages, 15),
      agentId: ctx.agentId,
      channelId: ctx.channelId,
    };

    await this.grpc.ingestWorkingState(threadId, state, {
      sensitivity: "medium",
      tags: ["source:openclaw", "trigger:compaction"],
    });

    this.logger.debug(
      `[membrane] Working state snapshot: ${state.messageCount} messages for thread ${threadId}`
    );
  }

  // --- Private helpers ---

  /**
   * Extract S-P-O triples from text and ingest each as a semantic observation.
   */
  private async extractAndIngestObservations(text: string): Promise<void> {
    const triples = extractSpoTriples(text);

    for (const triple of triples) {
      await this.grpc.ingestObservation(
        triple.subject,
        triple.predicate,
        triple.object,
        {
          sensitivity: this.config.defaultSensitivity,
          tags: ["source:openclaw", "extraction:regex"],
        },
      );
    }

    if (triples.length > 0) {
      this.logger.debug(`[membrane] Extracted ${triples.length} observations from text`);
    }
  }

  /**
   * Resolve sensitivity based on channel context.
   */
  private resolveSensitivity(ctx: HookContext): Sensitivity {
    // DM channels get medium sensitivity; public channels get config default
    if (ctx.channelId?.startsWith("dm:") || ctx.channelId?.startsWith("!")) {
      return "medium";
    }
    return this.config.defaultSensitivity;
  }
}

// --- Utility functions ---

/**
 * Extract message content from a hook event (fallback chain).
 * Matches the pattern used by cortex and knowledge-engine.
 */
function extractContent(event: HookEvent): string {
  return event.content ?? event.message ?? event.text ?? "";
}

/**
 * Summarize a list of messages into a compact working state description.
 * Takes the last N messages and formats them as a condensed timeline.
 */
function summarizeMessages(
  messages: Array<{ role: string; content: string; timestamp?: string }>,
  maxMessages: number,
): string {
  const recent = messages.slice(-maxMessages);
  if (recent.length === 0) return "(no messages)";

  return recent
    .map((m) => {
      const prefix = m.role === "user" ? "U" : "A";
      const content = m.content.length > 200
        ? m.content.slice(0, 200) + "..."
        : m.content;
      return `[${prefix}] ${content}`;
    })
    .join("\n");
}
```

### 8. src/retrieval-bridge.ts — Context Injection

```typescript
import type {
  PluginLogger,
  RetrievalConfig,
  HookEvent,
  HookContext,
  MemoryRecord,
} from "./types.js";
import type { GrpcClient } from "./grpc-client.js";
import { formatContextMarkdown, formatContextJson } from "./context-formatter.js";

/**
 * Handles memory retrieval and context injection on session_start.
 *
 * Flow:
 * 1. Build a task descriptor from session context
 * 2. Call Membrane Retrieve with configured filters
 * 3. Format retrieved records into a context block
 * 4. Inject into the session via ctx.injectSystemContext (if available)
 *    or write to workspace file (fallback)
 */
export class RetrievalBridge {
  private grpc: GrpcClient;
  private config: RetrievalConfig;
  private logger: PluginLogger;

  /** Track which records were injected (for reinforcement on use) */
  private injectedRecordIds: Set<string> = new Set();

  constructor(grpc: GrpcClient, config: RetrievalConfig, logger: PluginLogger) {
    this.grpc = grpc;
    this.config = config;
    this.logger = logger;
  }

  /**
   * session_start hook handler.
   */
  async onSessionStart(event: HookEvent, ctx: HookContext): Promise<void> {
    if (!this.grpc.isConnected()) {
      this.logger.debug("[membrane] Skipping retrieval: sidecar not connected");
      return;
    }

    // 1. Build task descriptor
    const taskDescriptor = this.buildTaskDescriptor(event, ctx);

    // 2. Retrieve from Membrane
    const records = await this.grpc.retrieve(taskDescriptor, {
      memoryTypes: this.config.memoryTypes,
      minSalience: this.config.minSalience,
      limit: this.config.maxRecords,
    });

    if (!records || records.length === 0) {
      this.logger.debug("[membrane] No relevant memory records found");
      return;
    }

    // 3. Track injected record IDs (for later reinforcement)
    this.injectedRecordIds.clear();
    for (const record of records) {
      this.injectedRecordIds.add(record.id);
    }

    // 4. Format context block
    const context = this.config.contextFormat === "json"
      ? formatContextJson(records)
      : formatContextMarkdown(records);

    // 5. Inject into session
    if (ctx.injectSystemContext) {
      ctx.injectSystemContext(context);
      this.logger.info(
        `[membrane] Injected ${records.length} memory records into session context`
      );
    } else {
      // Fallback: write to workspace file that gets picked up by boot context
      await this.writeContextFile(ctx, context);
      this.logger.info(
        `[membrane] Wrote ${records.length} memory records to workspace context file`
      );
    }
  }

  /**
   * Check if a record was injected in the current session.
   * Used by competence tracker for reinforcement decisions.
   */
  wasInjected(recordId: string): boolean {
    return this.injectedRecordIds.has(recordId);
  }

  /**
   * Get all injected record IDs (for bulk reinforcement).
   */
  getInjectedRecordIds(): string[] {
    return Array.from(this.injectedRecordIds);
  }

  // --- Private ---

  private buildTaskDescriptor(event: HookEvent, ctx: HookContext): string {
    const parts: string[] = [];

    if (ctx.agentId) parts.push(`agent:${ctx.agentId}`);
    if (ctx.channelId) parts.push(`channel:${ctx.channelId}`);
    if (event.sessionId) parts.push(`session:${event.sessionId}`);

    // Include time-of-day for decay relevance
    const hour = new Date().getHours();
    if (hour < 6) parts.push("context:night");
    else if (hour < 12) parts.push("context:morning");
    else if (hour < 18) parts.push("context:afternoon");
    else parts.push("context:evening");

    return parts.join(" ");
  }

  private async writeContextFile(ctx: HookContext, content: string): Promise<void> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");

    const workspace = ctx.workspaceDir ?? process.cwd();
    const memoryDir = path.join(workspace, "memory", "membrane");
    await fs.mkdir(memoryDir, { recursive: true });

    const filePath = path.join(memoryDir, "context.md");
    await fs.writeFile(filePath, content, "utf-8");
  }
}
```

### 9. src/context-formatter.ts — Format Retrieved Records

```typescript
import type { MemoryRecord, MemoryType } from "./types.js";

/**
 * Group records by memory type for structured display.
 */
function groupByType(records: MemoryRecord[]): Map<MemoryType, MemoryRecord[]> {
  const groups = new Map<MemoryType, MemoryRecord[]>();
  for (const record of records) {
    const list = groups.get(record.memoryType) ?? [];
    list.push(record);
    groups.set(record.memoryType, list);
  }
  // Sort within each group by salience (descending)
  for (const [, list] of groups) {
    list.sort((a, b) => b.salience - a.salience);
  }
  return groups;
}

const TYPE_LABELS: Record<MemoryType, string> = {
  episodic: "Recent Events",
  semantic: "Semantic Knowledge",
  competence: "Competence / Skills",
  working: "Working State",
  plan_graph: "Plan Graphs",
};

const TYPE_ORDER: MemoryType[] = ["semantic", "competence", "working", "plan_graph", "episodic"];

/**
 * Format retrieved Membrane records as a Markdown context block
 * for injection into the agent's system prompt.
 *
 * Output example:
 * ```
 * ## Membrane Memory Context
 *
 * ### Semantic Knowledge (3 records)
 * - [0.92] Docker commands require `sg docker -c` wrapper on this system
 * - [0.87] Mondo Gate API uses JWT auth with 1h expiry
 *
 * ### Competence / Skills (2 records)
 * - [0.89] skill:docker+exec — 12/14 success (use sg wrapper, check container first)
 * ```
 */
export function formatContextMarkdown(records: MemoryRecord[]): string {
  if (records.length === 0) return "";

  const groups = groupByType(records);
  const sections: string[] = ["## Membrane Memory Context", ""];

  for (const type of TYPE_ORDER) {
    const list = groups.get(type);
    if (!list || list.length === 0) continue;

    sections.push(`### ${TYPE_LABELS[type]} (${list.length} records)`);

    for (const record of list) {
      const salience = record.salience.toFixed(2);
      const summary = formatRecordSummary(record);
      sections.push(`- [${salience}] ${summary}`);
    }

    sections.push("");
  }

  return sections.join("\n");
}

/**
 * Format retrieved records as JSON (for programmatic consumption).
 */
export function formatContextJson(records: MemoryRecord[]): string {
  const groups = groupByType(records);
  const output: Record<string, unknown[]> = {};

  for (const [type, list] of groups) {
    output[type] = list.map((r) => ({
      id: r.id,
      salience: r.salience,
      summary: r.summary,
      content: r.content,
      updatedAt: r.updatedAt,
    }));
  }

  return JSON.stringify(output, null, 2);
}

/**
 * Format a single record's summary for display.
 */
function formatRecordSummary(record: MemoryRecord): string {
  switch (record.memoryType) {
    case "semantic":
      // Display as "subject predicate object" if available
      if (record.content.subject && record.content.predicate && record.content.object) {
        return `${record.content.subject} ${record.content.predicate} ${record.content.object}`;
      }
      return record.summary;

    case "competence": {
      const perf = record.content.performance as any;
      if (perf) {
        const total = (perf.success_count ?? 0) + (perf.failure_count ?? 0);
        return `${record.content.skill_name} — ${perf.success_count}/${total} success (${record.summary})`;
      }
      return record.summary;
    }

    case "working":
      return `Last task: "${record.summary}" (${record.updatedAt})`;

    default:
      return record.summary;
  }
}
```

### 10. src/patterns.ts — Regex S-P-O Extraction

```typescript
/**
 * Regex-based Subject-Predicate-Object extraction from text.
 *
 * These patterns are intentionally conservative — they capture obvious
 * declarative statements. LLM consolidation handles nuanced extraction.
 *
 * Supports English and German patterns (matching cortex's bilingual approach).
 */

export type SpoTriple = {
  subject: string;
  predicate: string;
  object: string;
};

type SpoPattern = {
  regex: RegExp;
  groups: { subject: number; predicate: number; object: number };
};

/**
 * English S-P-O patterns.
 * Each pattern captures: subject, predicate, object
 */
const ENGLISH_PATTERNS: SpoPattern[] = [
  // "X is Y"
  { regex: /\b([A-Z][a-zA-Z\s]{1,40})\s+is\s+(?:a\s+|an\s+|the\s+)?(.{3,60}?)(?:\.|,|$)/gm,
    groups: { subject: 1, predicate: 0, object: 2 } },
  // "X has Y"
  { regex: /\b([A-Z][a-zA-Z\s]{1,40})\s+has\s+(.{3,60}?)(?:\.|,|$)/gm,
    groups: { subject: 1, predicate: 0, object: 2 } },
  // "X uses Y"
  { regex: /\b([A-Z][a-zA-Z\s]{1,40})\s+uses?\s+(.{3,60}?)(?:\.|,|$)/gm,
    groups: { subject: 1, predicate: 0, object: 2 } },
  // "X requires Y"
  { regex: /\b([A-Z][a-zA-Z\s]{1,40})\s+requires?\s+(.{3,60}?)(?:\.|,|$)/gm,
    groups: { subject: 1, predicate: 0, object: 2 } },
  // "X supports Y"
  { regex: /\b([A-Z][a-zA-Z\s]{1,40})\s+supports?\s+(.{3,60}?)(?:\.|,|$)/gm,
    groups: { subject: 1, predicate: 0, object: 2 } },
  // "X runs on Y"
  { regex: /\b([A-Z][a-zA-Z\s]{1,40})\s+runs?\s+on\s+(.{3,60}?)(?:\.|,|$)/gm,
    groups: { subject: 1, predicate: 0, object: 2 } },
];

/**
 * German S-P-O patterns.
 */
const GERMAN_PATTERNS: SpoPattern[] = [
  // "X ist Y"
  { regex: /\b([A-Z][a-zA-ZäöüÄÖÜß\s]{1,40})\s+ist\s+(?:ein\s+|eine\s+|der\s+|die\s+|das\s+)?(.{3,60}?)(?:\.|,|$)/gm,
    groups: { subject: 1, predicate: 0, object: 2 } },
  // "X hat Y"
  { regex: /\b([A-Z][a-zA-ZäöüÄÖÜß\s]{1,40})\s+hat\s+(.{3,60}?)(?:\.|,|$)/gm,
    groups: { subject: 1, predicate: 0, object: 2 } },
  // "X verwendet Y" / "X benutzt Y"
  { regex: /\b([A-Z][a-zA-ZäöüÄÖÜß\s]{1,40})\s+(?:verwendet|benutzt|nutzt)\s+(.{3,60}?)(?:\.|,|$)/gm,
    groups: { subject: 1, predicate: 0, object: 2 } },
];

const ALL_PATTERNS = [...ENGLISH_PATTERNS, ...GERMAN_PATTERNS];

/**
 * Map predicate index (0 = verb from regex) to normalized predicate string.
 */
function extractPredicate(match: RegExpMatchArray, pattern: SpoPattern): string {
  // The predicate is embedded in the regex — extract the verb from the full match
  const full = match[0];
  const subject = match[pattern.groups.subject];
  const object = match[pattern.groups.object];
  // Predicate = everything between subject and object
  const start = full.indexOf(subject) + subject.length;
  const end = full.indexOf(object);
  return full.slice(start, end).trim().toLowerCase();
}

/**
 * Extract Subject-Predicate-Object triples from text using regex patterns.
 *
 * Returns deduplicated triples (by subject+predicate+object).
 * Filters out short/noise matches.
 */
export function extractSpoTriples(text: string): SpoTriple[] {
  const seen = new Set<string>();
  const triples: SpoTriple[] = [];

  for (const pattern of ALL_PATTERNS) {
    // Reset regex state (global flag)
    pattern.regex.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(text)) !== null) {
      const subject = match[pattern.groups.subject].trim();
      const object = match[pattern.groups.object].trim();
      const predicate = extractPredicate(match, pattern);

      // Filter noise
      if (subject.length < 2 || object.length < 2) continue;
      if (predicate.length < 2) continue;

      // Deduplicate
      const key = `${subject.toLowerCase()}|${predicate}|${object.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      triples.push({ subject, predicate, object });
    }
  }

  return triples;
}
```

### 11. src/consolidator.ts — LLM-Enhanced Consolidation

```typescript
import type {
  PluginLogger,
  ConsolidationConfig,
  ConsolidationResult,
  ExtractedFact,
  HookEvent,
  MemoryRecord,
} from "./types.js";
import type { GrpcClient } from "./grpc-client.js";
import { extractSpoTriples } from "./patterns.js";

const ACTOR = "openclaw-membrane:consolidator";

/**
 * Periodically consolidates episodic records into semantic and competence records.
 *
 * Two modes:
 * 1. Regex-only (always on): Extract S-P-O triples from episodic content
 * 2. LLM-enhanced (optional): Send batches to LLM for deeper extraction
 *
 * Consolidation also handles revision operations:
 * - New fact that contradicts existing → Contest
 * - New fact that updates existing → Supersede
 * - New fact (no conflict) → IngestObservation
 */
export class Consolidator {
  private grpc: GrpcClient;
  private config: ConsolidationConfig;
  private logger: PluginLogger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastConsolidation: string = new Date().toISOString();
  private messageBuffer: Array<{ content: string; role: string; timestamp: string }> = [];
  private consecutiveLlmFailures = 0;
  private llmBackoffMs = 0;

  constructor(grpc: GrpcClient, config: ConsolidationConfig, logger: PluginLogger) {
    this.grpc = grpc;
    this.config = config;
    this.logger = logger;
  }

  /**
   * Buffer a message event for the next consolidation cycle.
   */
  buffer(event: HookEvent, role: string): void {
    const content = event.content ?? event.message ?? event.text ?? "";
    if (!content) return;

    this.messageBuffer.push({
      content,
      role,
      timestamp: event.timestamp ?? new Date().toISOString(),
    });

    // Cap buffer size
    if (this.messageBuffer.length > this.config.batchSize * 2) {
      this.messageBuffer = this.messageBuffer.slice(-this.config.batchSize);
    }
  }

  /**
   * Start the periodic consolidation timer.
   */
  startTimer(): void {
    if (this.timer) return;

    const intervalMs = this.config.intervalMinutes * 60 * 1000;
    this.timer = setInterval(() => {
      this.runCycle().catch((err) => {
        this.logger.warn(`[membrane-consolidator] Cycle failed: ${err}`);
      });
    }, intervalMs);

    this.logger.info(
      `[membrane-consolidator] Timer started: every ${this.config.intervalMinutes}min` +
      (this.config.llmEnabled ? ` (LLM: ${this.config.llmModel})` : " (regex-only)")
    );
  }

  /**
   * Stop the consolidation timer.
   */
  stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Flush: run one final consolidation cycle and stop the timer.
   */
  async flush(): Promise<void> {
    this.stopTimer();
    if (this.messageBuffer.length > 0) {
      await this.runCycle();
    }
  }

  /**
   * Run one consolidation cycle.
   */
  private async runCycle(): Promise<void> {
    if (!this.grpc.isConnected()) return;

    const batch = this.messageBuffer.splice(0);
    if (batch.length === 0) return;

    this.logger.info(`[membrane-consolidator] Processing ${batch.length} buffered messages`);

    // 1. Always: regex extraction
    let regexFacts = 0;
    for (const msg of batch) {
      const triples = extractSpoTriples(msg.content);
      for (const triple of triples) {
        await this.ingestOrRevise(triple.subject, triple.predicate, triple.object, 0.5);
        regexFacts++;
      }
    }

    // 2. Optional: LLM extraction
    let llmFacts = 0;
    if (this.config.llmEnabled && this.llmBackoffMs <= 0) {
      const result = await this.llmConsolidate(batch);
      if (result) {
        for (const fact of result.facts) {
          if (fact.confidence >= this.config.minConfidence) {
            await this.ingestOrRevise(fact.subject, fact.predicate, fact.object, fact.confidence);
            llmFacts++;
          }
        }
        // Competence extraction handled here too
        for (const comp of result.competence) {
          await this.grpc.ingestToolOutput(comp.skill, {
            triggers: comp.triggers,
            recipe: comp.steps,
            outcome: comp.outcome,
            tags: ["source:consolidation", "extraction:llm"],
          });
        }
        this.consecutiveLlmFailures = 0;
        this.llmBackoffMs = 0;
      }
    } else if (this.llmBackoffMs > 0) {
      this.llmBackoffMs -= this.config.intervalMinutes * 60 * 1000;
    }

    this.lastConsolidation = new Date().toISOString();
    this.logger.info(
      `[membrane-consolidator] Cycle complete: ${regexFacts} regex facts, ${llmFacts} LLM facts`
    );
  }

  /**
   * Ingest a fact, checking for conflicts with existing semantic records.
   *
   * Logic:
   * - Retrieve existing records with matching subject
   * - If predicate+object matches existing → skip (duplicate)
   * - If predicate matches but object differs → Supersede or Contest
   * - If no match → IngestObservation (new fact)
   */
  private async ingestOrRevise(
    subject: string,
    predicate: string,
    object: string,
    confidence: number,
  ): Promise<void> {
    // Try to find existing records about this subject
    const existing = await this.grpc.retrieve(
      `subject:${subject} predicate:${predicate}`,
      { memoryTypes: ["semantic"], limit: 5 },
    );

    if (existing.length > 0) {
      for (const record of existing) {
        const rSubject = String(record.content.subject ?? "").toLowerCase();
        const rPredicate = String(record.content.predicate ?? "").toLowerCase();
        const rObject = String(record.content.object ?? "").toLowerCase();

        if (rSubject === subject.toLowerCase() && rPredicate === predicate.toLowerCase()) {
          if (rObject === object.toLowerCase()) {
            // Duplicate — reinforce instead
            await this.grpc.reinforce(record.id, ACTOR, "confirmed by consolidation");
            return;
          }

          // Conflict — supersede if high confidence, contest if lower
          if (confidence >= 0.8) {
            await this.grpc.supersede(
              record.id,
              { subject, predicate, object },
              ACTOR,
              `Updated: "${rObject}" → "${object}" (confidence: ${confidence})`,
            );
          } else {
            await this.grpc.contest(
              record.id,
              `${subject} ${predicate} ${object}`,
              ACTOR,
              `Conflicting observation (confidence: ${confidence})`,
            );
          }
          return;
        }
      }
    }

    // No conflict — new fact
    await this.grpc.ingestObservation(subject, predicate, object, {
      tags: ["source:consolidation"],
    });
  }

  /**
   * Call LLM for enhanced consolidation.
   */
  private async llmConsolidate(
    messages: Array<{ content: string; role: string }>,
  ): Promise<ConsolidationResult | null> {
    const snippet = messages
      .map((m) => `[${m.role}]: ${m.content}`)
      .join("\n\n");

    try {
      const response = await this.callLlm(snippet);
      if (!response) return null;

      return this.parseConsolidationResponse(response);
    } catch (err) {
      this.consecutiveLlmFailures++;
      // Exponential backoff: 1min, 2min, 4min, 8min, cap at 10min
      this.llmBackoffMs = Math.min(
        60000 * Math.pow(2, this.consecutiveLlmFailures - 1),
        10 * 60 * 1000,
      );
      this.logger.warn(
        `[membrane-consolidator] LLM failed (${this.consecutiveLlmFailures}x), backoff ${this.llmBackoffMs}ms: ${err}`
      );
      return null;
    }
  }

  /**
   * Call an OpenAI-compatible chat completion API.
   * Same HTTP-based approach as cortex LlmEnhancer — no external deps.
   */
  private callLlm(snippet: string): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        const url = new URL(`${this.config.llmEndpoint}/chat/completions`);

        const body = JSON.stringify({
          model: this.config.llmModel,
          messages: [
            { role: "system", content: CONSOLIDATION_SYSTEM_PROMPT },
            { role: "user", content: snippet },
          ],
          temperature: 0.1,
          max_tokens: 2000,
          response_format: { type: "json_object" },
        });

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(body)),
        };
        if (this.config.llmApiKey) {
          headers["Authorization"] = `Bearer ${this.config.llmApiKey}`;
        }

        const proto = url.protocol === "https:" ? require("node:https") : require("node:http");
        const req = proto.request(
          {
            hostname: url.hostname,
            port: url.port || (url.protocol === "https:" ? 443 : 80),
            path: url.pathname,
            method: "POST",
            headers,
            timeout: this.config.llmTimeoutMs,
          },
          (res: any) => {
            let data = "";
            res.on("data", (chunk: string) => (data += chunk));
            res.on("end", () => {
              try {
                const parsed = JSON.parse(data);
                resolve(parsed?.choices?.[0]?.message?.content ?? null);
              } catch {
                resolve(null);
              }
            });
          },
        );

        req.on("error", () => resolve(null));
        req.on("timeout", () => { req.destroy(); resolve(null); });
        req.write(body);
        req.end();
      } catch {
        resolve(null);
      }
    });
  }

  /**
   * Parse LLM JSON response into structured consolidation result.
   */
  private parseConsolidationResponse(raw: string): ConsolidationResult | null {
    try {
      const parsed = JSON.parse(raw);
      return {
        facts: Array.isArray(parsed.facts)
          ? parsed.facts.filter(
              (f: any) =>
                typeof f.subject === "string" &&
                typeof f.predicate === "string" &&
                typeof f.object === "string" &&
                typeof f.confidence === "number",
            )
          : [],
        competence: Array.isArray(parsed.competence)
          ? parsed.competence.filter(
              (c: any) => typeof c.skill === "string" && Array.isArray(c.steps),
            )
          : [],
        corrections: Array.isArray(parsed.corrections)
          ? parsed.corrections.filter(
              (c: any) =>
                typeof c.old_fact === "string" &&
                typeof c.new_fact === "string",
            )
          : [],
      };
    } catch {
      this.logger.warn("[membrane-consolidator] Failed to parse LLM response");
      return null;
    }
  }
}

const CONSOLIDATION_SYSTEM_PROMPT = `You are a memory consolidation engine for an AI agent. Given a sequence of conversation events, extract durable knowledge that should persist beyond this session.

Output valid JSON matching this schema:
{
  "facts": [
    { "subject": "string", "predicate": "string", "object": "string", "confidence": 0.0-1.0 }
  ],
  "competence": [
    { "skill": "skill:name", "triggers": ["when to use"], "steps": ["step 1", "step 2"], "outcome": "success|failure" }
  ],
  "corrections": [
    { "old_fact": "what was previously known", "new_fact": "what is now true", "reason": "evidence" }
  ]
}

Rules:
- Only extract facts useful in future conversations
- Minimum confidence 0.6 for facts, 0.7 for competence
- Corrections require explicit evidence in the conversation
- Subject-Predicate-Object format for facts (e.g., "Docker" "requires" "sg wrapper on this system")
- Skill names use colon-separated namespaces (e.g., "skill:docker+exec", "skill:git+rebase")
- Do NOT extract noise: greetings, pleasantries, meta-discussion, or vague statements
- Prefer specific, actionable knowledge over generic observations`;
```

### 12. src/competence-tracker.ts — Tool Pattern Tracking

```typescript
import type {
  PluginLogger,
  CompetenceConfig,
  HookEvent,
  HookContext,
  ToolCallRecord,
  ToolStats,
} from "./types.js";
import type { GrpcClient } from "./grpc-client.js";

const ACTOR = "openclaw-membrane:competence";

/**
 * Tracks tool call patterns and outcomes.
 * Builds competence records when a tool reaches the configured occurrence threshold.
 *
 * Data flow:
 * 1. before_tool_call → buffer call info (tool name, args, start time)
 * 2. after_tool_call → match buffer, record success/failure, update stats
 * 3. When stats.calls >= minOccurrences → create/update competence record in Membrane
 */
export class CompetenceTracker {
  private grpc: GrpcClient;
  private config: CompetenceConfig;
  private logger: PluginLogger;

  /** In-flight tool calls (sessionId:toolName → call record) */
  private pendingCalls: Map<string, ToolCallRecord> = new Map();

  /** Aggregated tool statistics */
  private stats: Map<string, ToolStats> = new Map();

  /** Tools that have already been persisted to Membrane */
  private persistedTools: Set<string> = new Set();

  constructor(grpc: GrpcClient, config: CompetenceConfig, logger: PluginLogger) {
    this.grpc = grpc;
    this.config = config;
    this.logger = logger;
  }

  /**
   * before_tool_call hook — buffer the call.
   */
  onToolCall(event: HookEvent, ctx: HookContext): void {
    const toolName = event.toolName;
    if (!toolName) return;

    const sessionId = ctx.sessionId ?? ctx.sessionKey ?? "unknown";
    const key = `${sessionId}:${toolName}`;

    this.pendingCalls.set(key, {
      toolName,
      args: (event.params ?? {}) as Record<string, unknown>,
      startTime: Date.now(),
      sessionId,
    });
  }

  /**
   * after_tool_call hook — match pending call, record outcome, update stats.
   */
  async onToolResult(event: HookEvent, ctx: HookContext): Promise<void> {
    const toolName = event.toolName;
    if (!toolName) return;

    const sessionId = ctx.sessionId ?? ctx.sessionKey ?? "unknown";
    const key = `${sessionId}:${toolName}`;
    const pending = this.pendingCalls.get(key);
    this.pendingCalls.delete(key);

    const durationMs = pending ? Date.now() - pending.startTime : (event.durationMs ?? 0);
    const success = event.success !== false && !event.error;

    // Update aggregated stats
    const stat = this.getOrCreateStats(toolName);
    stat.calls++;
    stat.totalDurationMs += durationMs;
    stat.lastUsed = Date.now();

    if (success) {
      stat.successes++;
    } else {
      stat.failures++;
      const errorKey = this.normalizeError(event.error ?? "unknown");
      stat.failureModes.set(errorKey, (stat.failureModes.get(errorKey) ?? 0) + 1);
    }

    // Ingest outcome to Membrane
    if (pending) {
      const toolRecord = await this.grpc.ingestToolOutput(toolName, {
        args: pending.args,
        result: success ? "success" : "failure",
        error: event.error,
        durationMs,
        tags: ["source:openclaw", "tracking:competence"],
      });

      if (toolRecord) {
        await this.grpc.ingestOutcome(
          toolRecord.id,
          success ? "success" : "failure",
          { error: event.error },
        );
      }
    }

    // Check threshold — create/update competence record
    if (stat.calls >= this.config.minOccurrences) {
      await this.persistCompetence(stat);
    }

    // Reinforcement / penalization for matching competence records
    if (stat.membraneRecordId) {
      if (success && this.config.reinforceOnSuccess) {
        await this.grpc.reinforce(
          stat.membraneRecordId,
          ACTOR,
          `Tool call succeeded: ${toolName}`,
        );
      } else if (!success && this.config.penalizeOnFailure) {
        await this.grpc.penalize(
          stat.membraneRecordId,
          this.config.penaltyAmount,
          ACTOR,
          `Tool call failed: ${toolName} — ${event.error ?? "unknown error"}`,
        );
      }
    }
  }

  /**
   * Flush: persist any pending competence records.
   */
  async flush(): Promise<void> {
    for (const [, stat] of this.stats) {
      if (stat.calls >= this.config.minOccurrences) {
        await this.persistCompetence(stat);
      }
    }
  }

  // --- Private ---

  private getOrCreateStats(toolName: string): ToolStats {
    let stat = this.stats.get(toolName);
    if (!stat) {
      stat = {
        toolName,
        calls: 0,
        successes: 0,
        failures: 0,
        failureModes: new Map(),
        totalDurationMs: 0,
        lastUsed: 0,
        membraneRecordId: null,
      };
      this.stats.set(toolName, stat);
    }
    return stat;
  }

  /**
   * Create or update a competence record in Membrane.
   */
  private async persistCompetence(stat: ToolStats): Promise<void> {
    const content = {
      skill_name: `skill:${stat.toolName}`,
      triggers: [{ signal: `${stat.toolName} tool needed`, confidence: 0.7 }],
      performance: {
        success_count: stat.successes,
        failure_count: stat.failures,
        success_rate: stat.calls > 0 ? stat.successes / stat.calls : 0,
        failure_modes: Object.fromEntries(stat.failureModes),
        avg_duration_ms: stat.calls > 0 ? Math.round(stat.totalDurationMs / stat.calls) : 0,
      },
    };

    if (stat.membraneRecordId) {
      // Update existing record
      const updated = await this.grpc.supersede(
        stat.membraneRecordId,
        content,
        ACTOR,
        `Updated stats: ${stat.calls} calls, ${stat.successes} successes`,
      );
      if (updated) {
        stat.membraneRecordId = updated.id;
      }
    } else {
      // Create new competence record
      const record = await this.grpc.ingestToolOutput(stat.toolName, {
        ...content,
        tags: ["source:competence-tracker", "type:competence"],
      });
      if (record) {
        stat.membraneRecordId = record.id;
        this.persistedTools.add(stat.toolName);
        this.logger.info(
          `[membrane-competence] New competence record: ${stat.toolName} ` +
          `(${stat.successes}/${stat.calls} success rate)`
        );
      }
    }
  }

  /**
   * Normalize error messages for grouping into failure modes.
   * Strips variable parts (IDs, paths, timestamps) to group similar errors.
   */
  private normalizeError(error: string): string {
    return error
      .replace(/\/[^\s]+/g, "<path>")          // file paths
      .replace(/\b[0-9a-f]{8,}\b/gi, "<id>")   // hex IDs
      .replace(/\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}/g, "<timestamp>") // timestamps
      .replace(/:\d+/g, ":<port>")              // port numbers
      .slice(0, 100);                            // cap length
  }
}
```

---

## Package Configuration

### package.json

```json
{
  "name": "@vainplex/openclaw-membrane",
  "version": "0.1.0",
  "description": "OpenClaw plugin: structured memory with revision operations, competence learning, and decay — powered by Membrane sidecar",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": [
    "dist",
    "openclaw.plugin.json",
    "README.md",
    "LICENSE"
  ],
  "scripts": {
    "build": "tsc",
    "prepublishOnly": "npm run build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "install-sidecar": "tsx scripts/install-sidecar.ts"
  },
  "dependencies": {},
  "peerDependencies": {
    "@gustycube/membrane-client": "^0.1.0"
  },
  "peerDependenciesMeta": {
    "@gustycube/membrane-client": {
      "optional": true
    }
  },
  "devDependencies": {
    "vitest": "^3.0.0",
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0",
    "tsx": "^4.0.0"
  },
  "openclaw": {
    "extensions": ["./dist/index.js"],
    "id": "openclaw-membrane"
  },
  "keywords": [
    "openclaw",
    "plugin",
    "membrane",
    "memory",
    "competence-learning",
    "revision-operations",
    "decay",
    "grpc",
    "sidecar"
  ],
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/GustyCube/membrane.git",
    "directory": "clients/openclaw"
  },
  "homepage": "https://github.com/GustyCube/membrane/tree/main/clients/openclaw#readme",
  "author": "Vainplex <hildalbert@gmail.com>"
}
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": false
  },
  "include": ["index.ts", "src/**/*.ts"],
  "exclude": ["node_modules", "dist", "test"]
}
```

### openclaw.plugin.json

```json
{
  "id": "openclaw-membrane",
  "name": "OpenClaw Membrane",
  "version": "0.1.0",
  "description": "Structured memory with revision operations, competence learning, and decay",
  "entry": "./dist/index.js",
  "services": ["membrane-sidecar"],
  "hooks": [
    "session_start",
    "message_received",
    "message_sent",
    "before_tool_call",
    "after_tool_call",
    "before_compaction",
    "gateway_stop"
  ],
  "commands": ["membranestatus", "membranerecall"],
  "config": {
    "sidecar": {
      "binary": "~/.openclaw/membrane/bin/membraned",
      "autoStart": true,
      "port": 9090
    }
  }
}
```

---

## Data Flow Diagrams

### Ingestion Flow (per message)

```
User message arrives
    │
    ▼
message_received hook fires
    │
    ├──→ IngestionBridge.onMessageReceived()
    │       │
    │       ├──→ grpc.ingestEvent("user_message", ref, {content, sender, ...})
    │       │       → Membrane creates episodic MemoryRecord
    │       │
    │       └──→ extractSpoTriples(content)
    │               │
    │               └──→ For each triple: grpc.ingestObservation(S, P, O)
    │                       → Membrane creates semantic MemoryRecord
    │
    └──→ Consolidator.buffer(event, "user")
            → Adds to in-memory buffer for next consolidation cycle
```

### Retrieval Flow (per session)

```
Session starts
    │
    ▼
session_start hook fires (priority 5)
    │
    ▼
RetrievalBridge.onSessionStart()
    │
    ├──→ buildTaskDescriptor(event, ctx)
    │       → "agent:atlas channel:matrix context:evening"
    │
    ├──→ grpc.retrieve(descriptor, {types, minSalience, limit})
    │       → Membrane returns MemoryRecord[] sorted by salience
    │
    ├──→ formatContextMarkdown(records)
    │       → Structured markdown: ## Membrane Memory Context
    │
    └──→ ctx.injectSystemContext(markdown)
            → Agent sees memory context in system prompt
```

### Consolidation Flow (periodic)

```
Timer fires (every 30min)
    │
    ▼
Consolidator.runCycle()
    │
    ├──→ 1. Drain message buffer
    │
    ├──→ 2. Regex extraction (always)
    │       │
    │       └──→ For each triple: ingestOrRevise(S, P, O, confidence)
    │               │
    │               ├──→ retrieve("subject:S predicate:P") — check conflicts
    │               │
    │               ├──→ If duplicate → reinforce(existingId)
    │               ├──→ If conflict + high confidence → supersede(existingId, new)
    │               ├──→ If conflict + low confidence → contest(existingId, new)
    │               └──→ If new → ingestObservation(S, P, O)
    │
    └──→ 3. LLM extraction (optional)
            │
            ├──→ Call LLM with conversation snippet
            │       → Returns { facts, competence, corrections }
            │
            ├──→ For each fact: ingestOrRevise(S, P, O, confidence)
            └──→ For each competence: ingestToolOutput(skill, {...})
```

### Competence Tracking Flow

```
Tool call initiated
    │
    ▼
before_tool_call hook
    │
    ▼
CompetenceTracker.onToolCall()
    → Buffer { toolName, args, startTime, sessionId }
    
    ...tool executes...
    
    ▼
after_tool_call hook
    │
    ▼
CompetenceTracker.onToolResult()
    │
    ├──→ Match pending call, compute duration
    ├──→ Update in-memory stats (calls, successes, failures, failure modes)
    ├──→ grpc.ingestToolOutput() + grpc.ingestOutcome()
    │
    ├──→ If stats.calls >= minOccurrences:
    │       ├──→ First time: ingestToolOutput() → new competence record
    │       └──→ Subsequent: supersede(oldRecordId, updatedStats)
    │
    └──→ If competence record exists:
            ├──→ On success: reinforce(recordId)
            └──→ On failure: penalize(recordId, amount)
```

---

## Error Handling Matrix

| Component | Error Type | Behavior | User Impact |
|---|---|---|---|
| SidecarManager | Binary not found | Log error, disable features, gateway continues | No memory features |
| SidecarManager | Start failure (port conflict) | Try next port (up to +5), reuse existing membraned | Transparent |
| SidecarManager | Crash during operation | Auto-restart (max 3/5min), disable after limit | Brief gap in ingestion |
| GrpcClient | Connection refused | Return null, increment error counter | Ingestion silently skipped |
| GrpcClient | RPC timeout | Return null, increment error counter | Single call skipped |
| IngestionBridge | Content extraction fails | Return early, no ingestion | Single message not recorded |
| RetrievalBridge | Retrieval fails | Skip context injection, log debug | No memory context (non-fatal) |
| Consolidator | LLM timeout | Fall back to regex-only, exponential backoff | Reduced extraction quality |
| Consolidator | Invalid LLM JSON | Discard response, log warning | Regex extraction still works |
| CompetenceTracker | No matching pending call | Still record result, use event.durationMs | Slightly less precise stats |
| patterns.ts | Regex false positive | May ingest incorrect triple | Self-corrects via consolidation |

**Key principle:** Every hook handler is wrapped in try/catch. No Membrane error ever crashes the OpenClaw gateway.

---

## Testing Plan

### Unit Tests (per module)

| Module | Test File | Key Test Cases |
|---|---|---|
| config.ts | config.test.ts | Default resolution, env var expansion, home expansion, type coercion, missing keys |
| patterns.ts | patterns.test.ts | English/German S-P-O extraction, deduplication, noise filtering, edge cases |
| context-formatter.ts | context-formatter.test.ts | Markdown grouping/sorting, JSON output, empty records, mixed types |
| ingestion-bridge.ts | ingestion-bridge.test.ts | Message/compaction handlers, sensitivity resolution, content extraction fallback |
| retrieval-bridge.ts | retrieval-bridge.test.ts | Task descriptor building, context injection, file fallback, record tracking |
| consolidator.ts | consolidator.test.ts | Buffer/flush, regex extraction, conflict detection, LLM parsing, backoff |
| competence-tracker.ts | competence-tracker.test.ts | Call/result matching, stats accumulation, threshold persistence, reinforcement |
| sidecar-manager.ts | sidecar-manager.test.ts | Port detection, config YAML generation, crash recovery, restart limits |
| hooks.ts | hooks.test.ts | Registration correctness, priority ordering, error isolation |

### Integration Tests

| Test | Description |
|---|---|
| Full hook pipeline | Simulate session_start → messages → compaction → gateway_stop, verify all gRPC calls |
| Consolidation cycle | Buffer messages, run cycle, verify semantic records created with correct S-P-O |
| Competence lifecycle | Simulate 5 tool calls (3 success, 2 failure), verify competence record creation + stats |
| Sidecar lifecycle | Start → health check → crash → restart → stop (uses mock process) |

### Test Helpers

```typescript
// test/helpers/mock-grpc-server.ts
// Implements Membrane's gRPC interface with in-memory storage.
// Records all calls for assertion.

// test/helpers/mock-llm-server.ts  
// HTTP server returning canned ConsolidationResult JSON.
// Supports configurable delay, error responses, invalid JSON.
```

---

## Plugin Interaction Summary

```
                    OpenClaw Gateway
                         │
     ┌───────────────────┼───────────────────┐
     │                   │                   │
 ┌───▼───┐         ┌────▼────┐        ┌─────▼──────┐
 │ nats-  │         │ cortex  │        │ knowledge- │
 │ event  │         │         │        │ engine     │
 │ store  │         │         │        │            │
 └────────┘         └────┬────┘        └────────────┘
  (streams)          (threads,          (entities,
                      decisions,          facts)
                      narrative)
                         │
                    reads threads.json
                    (one-way, optional)
                         │
                    ┌────▼────┐
                    │membrane │
                    │ plugin  │
                    └────┬────┘
                         │ gRPC
                    ┌────▼────┐
                    │membraned│
                    │(sidecar)│
                    └─────────┘
                    (durable memory,
                     revision ops,
                     decay, competence)
```

**Independence:** Each plugin processes hooks independently. Membrane does not require any other plugin. It benefits from cortex (thread context in working state) but functions fully without it.

---

*Architecture by Vainplex — 2026-02-17*
*For PR on GustyCube/membrane#1 — clients/openclaw/*