/**
 * Shared record parser — used by both membrane_search tool and before_agent_start hook.
 * Extracts and categorizes memories from Membrane gRPC Retrieve responses.
 * 
 * Handles all 4 memory types: episodic, semantic, competence, working.
 * Prioritizes user/assistant messages over tool calls.
 */

import type { MembraneRecord, ParsedMemories, PluginLogger } from './types.js';

const MIN_SUMMARY_LENGTH = 5;
const MIN_TOOL_SUMMARY_LENGTH = 30;
const MAX_SUMMARY_LENGTH = 500;

/**
 * Parse raw Membrane Retrieve records into categorized, formatted memory strings.
 */
export function parseMembraneRecords(
  rawRecords: Uint8Array[],
  logger?: PluginLogger
): ParsedMemories {
  const conversational: string[] = [];
  const tool: string[] = [];

  for (const raw of rawRecords) {
    try {
      const record: MembraneRecord = JSON.parse(Buffer.from(raw).toString());
      const tsShort = formatTimestamp(record.created_at);
      parsePayload(record, tsShort, conversational, tool);
    } catch (err) {
      logger?.debug(`[membrane] Failed to parse record: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { conversational, tool };
}

/**
 * Select final memories: prioritize conversational, fill remaining with tool memories.
 */
export function selectMemories(parsed: ParsedMemories, limit: number): string[] {
  const result = parsed.conversational.slice(0, limit);
  if (result.length < limit) {
    result.push(...parsed.tool.slice(0, limit - result.length));
  }
  return result;
}

// --- Internal helpers ---

function formatTimestamp(ts: string): string {
  if (!ts) return '';
  return ts.substring(0, 16).replace('T', ' ');
}

function parsePayload(
  record: MembraneRecord,
  tsShort: string,
  conversational: string[],
  tool: string[]
): void {
  const payload = record.payload;

  switch (payload.kind) {
    case 'episodic':
      parseEpisodic(payload.timeline, tsShort, conversational, tool);
      break;
    case 'semantic':
      parseSemantic(payload, tsShort, conversational);
      break;
    case 'competence':
      parseCompetence(payload, tsShort, conversational);
      break;
    case 'working':
      parseWorking(payload, tsShort, conversational);
      break;
  }
}

function parseEpisodic(
  timeline: Array<{ t: string; event_kind: string; summary: string }>,
  tsShort: string,
  conversational: string[],
  tool: string[]
): void {
  if (!timeline?.length) return;

  for (const entry of timeline) {
    const summary = entry.summary || '';
    const kind = entry.event_kind || 'event';

    if (summary.length < MIN_SUMMARY_LENGTH) continue;
    if (kind === 'tool_call' && summary.length < MIN_TOOL_SUMMARY_LENGTH) continue;

    const line = `[${kind} ${tsShort}] ${summary.substring(0, MAX_SUMMARY_LENGTH)}`;

    if (kind === 'user_message' || kind === 'assistant_message' || kind === 'system_event') {
      conversational.push(line);
    } else {
      tool.push(line);
    }
  }
}

function parseSemantic(
  payload: { subject: string; predicate: string; object: string | Record<string, unknown> },
  tsShort: string,
  conversational: string[]
): void {
  const { subject, predicate, object } = payload;
  if (!subject && !predicate) return;
  const objStr = typeof object === 'string' ? object : JSON.stringify(object);
  conversational.push(`[fact ${tsShort}] ${subject} ${predicate} ${objStr}`.substring(0, MAX_SUMMARY_LENGTH));
}

function parseCompetence(
  payload: { description?: string; pattern?: string },
  tsShort: string,
  conversational: string[]
): void {
  const desc = payload.description || payload.pattern || '';
  if (desc) {
    conversational.push(`[competence ${tsShort}] ${desc.substring(0, MAX_SUMMARY_LENGTH)}`);
  }
}

function parseWorking(
  payload: { context_summary?: string; state?: string },
  tsShort: string,
  conversational: string[]
): void {
  const summary = payload.context_summary || payload.state || '';
  if (summary) {
    conversational.push(`[working ${tsShort}] ${summary.substring(0, MAX_SUMMARY_LENGTH)}`);
  }
}
