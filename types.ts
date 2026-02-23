/**
 * Type definitions for openclaw-membrane plugin.
 * Eliminates `any` throughout the codebase.
 */

// --- OpenClaw Plugin API (subset we use) ---

export interface PluginLogger {
  info(msg: string): void;
  warn(msg: string): void;
  debug(msg: string): void;
  error(msg: string): void;
}

export interface PluginApi {
  pluginConfig: Record<string, unknown>;
  logger: PluginLogger;
  on(event: string, handler: (...args: unknown[]) => unknown | Promise<unknown>): void;
  registerTool(tool: ToolDefinition): void;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
  };
  execute(toolCallId: string, params: Record<string, unknown>): Promise<ToolResult>;
}

export interface ToolResult {
  content: Array<{ type: string; text: string }>;
}

// --- Plugin Config ---

export interface PluginConfig {
  grpc_endpoint: string;
  buffer_size: number;
  default_sensitivity: string;
  retrieve_enabled: boolean;
  retrieve_limit: number;
  retrieve_min_salience: number;
  retrieve_max_sensitivity: string;
  retrieve_timeout_ms: number;
}

export const DEFAULT_CONFIG: PluginConfig = {
  grpc_endpoint: 'localhost:50051',
  buffer_size: 1000,
  default_sensitivity: 'low',
  retrieve_enabled: true,
  retrieve_limit: 5,
  retrieve_min_salience: 0.1,
  retrieve_max_sensitivity: 'medium',
  retrieve_timeout_ms: 2000,
};

// --- Membrane Record Types ---

export interface TimelineEntry {
  t: string;
  event_kind: string;
  ref?: string;
  summary: string;
}

export interface EpisodicPayload {
  kind: 'episodic';
  timeline: TimelineEntry[];
}

export interface SemanticPayload {
  kind: 'semantic';
  subject: string;
  predicate: string;
  object: string | Record<string, unknown>;
}

export interface CompetencePayload {
  kind: 'competence';
  description?: string;
  pattern?: string;
}

export interface WorkingPayload {
  kind: 'working';
  context_summary?: string;
  state?: string;
}

export type MembranePayload = EpisodicPayload | SemanticPayload | CompetencePayload | WorkingPayload;

export interface MembraneRecord {
  id: string;
  type: string;
  sensitivity: string;
  confidence: number;
  salience: number;
  scope: string;
  tags: string[];
  created_at: string;
  payload: MembranePayload;
}

export interface RetrieveResponse {
  records: Uint8Array[];
}

// --- Parsed Memory Result ---

export interface ParsedMemories {
  conversational: string[];
  tool: string[];
}

// --- gRPC Retrieve Request ---

export interface RetrieveRequest {
  task_descriptor: string;
  trust: {
    max_sensitivity: string;
    authenticated: boolean;
    actor_id: string;
    scopes: string[];
  };
  memory_types: string[];
  min_salience: number;
  limit: number;
}
