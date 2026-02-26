/**
 * @vainplex/openclaw-membrane — Membrane bridge plugin for OpenClaw
 * 
 * Provides:
 * - Event ingestion (write path) via gRPC IngestEvent
 * - `membrane_search` tool for episodic memory queries
 * - `before_agent_start` hook for auto-context injection
 */

import { MembraneClient } from './client.js';
import { ReliabilityManager } from './buffer.js';
import type { IngestMethod } from './buffer.js';
import { mapEvent, mapSensitivity, type OpenClawEvent } from './mapping.js';
import { parseMembraneRecords, selectMemories } from './parser.js';
import type {
  PluginApi,
  PluginConfig,
  PluginLogger,
  RetrieveRequest,
  RetrieveResponse,
  ToolResult,
  ParsedMemories,
} from './types.js';
import { DEFAULT_CONFIG } from './types.js';

// --- Config (exported for testing) ---

export function createConfig(rawConfig: Record<string, unknown>): PluginConfig {
  return {
    ...DEFAULT_CONFIG,
    ...validateConfig(rawConfig),
  };
}

export function validateConfig(raw: Record<string, unknown>): Partial<PluginConfig> {
  const result: Partial<PluginConfig> = {};
  if (typeof raw.grpc_endpoint === 'string') result.grpc_endpoint = raw.grpc_endpoint;
  if (typeof raw.buffer_size === 'number') result.buffer_size = raw.buffer_size;
  if (typeof raw.default_sensitivity === 'string') result.default_sensitivity = raw.default_sensitivity;
  if (typeof raw.retrieve_enabled === 'boolean') result.retrieve_enabled = raw.retrieve_enabled;
  if (typeof raw.retrieve_limit === 'number') result.retrieve_limit = raw.retrieve_limit;
  if (typeof raw.retrieve_min_salience === 'number') result.retrieve_min_salience = raw.retrieve_min_salience;
  if (typeof raw.retrieve_max_sensitivity === 'string') result.retrieve_max_sensitivity = raw.retrieve_max_sensitivity;
  if (typeof raw.retrieve_timeout_ms === 'number') result.retrieve_timeout_ms = raw.retrieve_timeout_ms;
  return result;
}

// --- Retrieve helper ---

async function retrieveMemories(
  client: MembraneClient,
  query: string,
  config: PluginConfig,
  fetchLimit: number
): Promise<RetrieveResponse | null> {
  const request: RetrieveRequest = {
    task_descriptor: query.substring(0, 500),
    trust: {
      max_sensitivity: config.retrieve_max_sensitivity,
      authenticated: true,
      actor_id: 'openclaw-main',
      scopes: [],
    },
    memory_types: [],
    min_salience: config.retrieve_min_salience,
    limit: fetchLimit,
  };

  const result = await Promise.race([
    client.call('Retrieve', request as unknown as Record<string, unknown>),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), config.retrieve_timeout_ms)
    ),
  ]);

  return result as RetrieveResponse | null;
}

// --- Tool handler ---

async function handleSearch(
  client: MembraneClient,
  config: PluginConfig,
  logger: PluginLogger,
  params: Record<string, unknown>
): Promise<ToolResult> {
  const query = typeof params.query === 'string' ? params.query : '';
  const limit = Math.min(typeof params.limit === 'number' ? params.limit : 5, 20);

  if (!query || query.length < 3) {
    return { content: [{ type: 'text', text: 'Query too short. Please provide a more specific search.' }] };
  }

  try {
    const result = await retrieveMemories(client, query, config, Math.max(limit * 10, 50));
    if (!result?.records?.length) {
      return { content: [{ type: 'text', text: 'No relevant memories found in Membrane.' }] };
    }

    const parsed = parseMembraneRecords(result.records, logger);
    const memories = selectMemories(parsed, limit);

    if (memories.length === 0) {
      return { content: [{ type: 'text', text: 'No relevant memories found in Membrane.' }] };
    }

    return {
      content: [{
        type: 'text',
        text: `Found ${memories.length} memories in Membrane (${result.records.length} records scanned):\n\n${memories.join('\n\n')}`,
      }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Membrane search failed: ${msg}` }] };
  }
}

// --- Context hook handler ---

async function handleContextInjection(
  client: MembraneClient,
  config: PluginConfig,
  logger: PluginLogger,
  prompt: string
): Promise<{ prependContext: string } | undefined> {
  if (!prompt || prompt.length < 5) return undefined;

  try {
    const fetchLimit = Math.max(config.retrieve_limit * 10, 50);
    const result = await retrieveMemories(client, prompt, config, fetchLimit);
    if (!result?.records?.length) return undefined;

    const parsed = parseMembraneRecords(result.records, logger);
    const memories = selectMemories(parsed, config.retrieve_limit);
    if (memories.length === 0) return undefined;

    const context = [
      '<membrane-context>',
      'Episodic memory from Membrane (conversation history, tool outputs, observations).',
      'Treat as supplementary context — verify before stating as fact.',
      ...memories.map((m, i) => `${i + 1}. ${m}`),
      '</membrane-context>',
    ].join('\n');

    logger.info(`[membrane] Injecting ${memories.length} memories (${parsed.conversational.length} conversational + ${parsed.tool.length} tool) into context`);
    return { prependContext: context };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug(`[membrane] Retrieve skipped: ${msg}`);
    return undefined;
  }
}

// --- Event handler ---

function handleEvent(
  event: { type: string; payload?: Record<string, unknown>; data?: Record<string, unknown>; context?: Record<string, unknown> },
  config: PluginConfig,
  reliability: ReliabilityManager,
  logger: PluginLogger
): void {
  const normalizedEvent: OpenClawEvent = {
    type: event.type,
    payload: (event.payload || event.data || {}) as Record<string, unknown>,
    context: event.context as OpenClawEvent['context'],
  };

  const sensitivity = mapSensitivity(normalizedEvent, config.default_sensitivity);
  const mapped = mapEvent(normalizedEvent, sensitivity);

  if (mapped) {
    logger.info(`[membrane] Received event: ${event.type}`);
    reliability.enqueue(mapped.method as IngestMethod, mapped.payload as Record<string, unknown>);
  }
}

// --- Shutdown handler ---

async function handleShutdown(
  client: MembraneClient,
  reliability: ReliabilityManager,
  logger: PluginLogger
): Promise<void> {
  logger.info('[membrane] Shutting down, flushing buffer...');
  await reliability.flush(5000);
  client.close();
}

// --- Tool schema ---

const SEARCH_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Search query — what are you looking for? Be specific.' },
    limit: { type: 'number', description: 'Maximum results to return (default: 5, max: 20)' },
  },
  required: ['query'],
};

// --- Plugin ---

const plugin = {
  id: 'openclaw-membrane',
  name: '@vainplex/openclaw-membrane',
  version: '0.3.2',

  register(api: PluginApi) {
    const config = createConfig(api.pluginConfig);
    const logger = api.logger;

    const client = new MembraneClient(config.grpc_endpoint);
    const reliability = new ReliabilityManager(
      config.buffer_size,
      async (item) => { await client.call(item.method, item.payload); },
      logger
    );

    logger.info(`[membrane] Registered bridge to ${config.grpc_endpoint}`);

    // Write path: subscribe to specific OpenClaw hooks
    // OpenClaw fires named hooks, not a generic 'event' hook
    const hookHandler = (type: string) => (event: unknown, ctx?: unknown) => {
      const e = event as Record<string, unknown>;
      const c = ctx as Record<string, unknown> | undefined;
      handleEvent(
        { type, payload: e, context: c },
        config, reliability, logger
      );
    };

    api.on('message_received', hookHandler('message_received'));
    api.on('message_sent', hookHandler('message_sent'));
    api.on('message_sending', hookHandler('message_sending'));
    // after_tool_call removed — tool calls are operational logs, not memories.
    // They flood Membrane (~95% of volume) and drown out actual conversations.
    // Tool data is already captured in NATS event store.
    api.on('session_start', hookHandler('session_start'));

    // Search tool: gRPC Retrieve (boosts salience via rehearsal)
    api.registerTool({
      name: 'membrane_search',
      description: 'Search episodic memory (Membrane) for conversation history, tool outputs, and observations. Use when you need historical context about past conversations, decisions, or events. Returns the most relevant memories matching the query.',
      parameters: SEARCH_TOOL_SCHEMA,
      execute: (_toolCallId: string, params: Record<string, unknown>) =>
        handleSearch(client, config, logger, params),
    });

    // Context hook: auto-inject Membrane memories before agent starts
    if (config.retrieve_enabled) {
      api.on('before_agent_start', (event: unknown) => {
        const e = event as { prompt?: string; message?: string };
        return handleContextInjection(client, config, logger, e.prompt || e.message || '');
      });
    }

    // Shutdown: flush buffer, close client
    api.on('stop', () => handleShutdown(client, reliability, logger));
  },
};

export default plugin;
