import { describe, it, expect } from 'vitest';
import { mapEvent, mapSensitivity, type OpenClawEvent } from '../mapping.js';

describe('mapSensitivity', () => {
  it('returns hyper for credential events', () => {
    const event: OpenClawEvent = { type: 'credential_update', payload: {} };
    expect(mapSensitivity(event, 'low')).toBe('hyper');
  });

  it('uses context sensitivity when present', () => {
    const event: OpenClawEvent = { type: 'message_received', payload: {}, context: { sensitivity: 'high' } };
    expect(mapSensitivity(event, 'low')).toBe('high');
  });

  it('returns medium for DM channels', () => {
    const event: OpenClawEvent = { type: 'message_received', payload: {}, context: { channelType: 'dm' } };
    expect(mapSensitivity(event, 'low')).toBe('medium');
  });

  it('returns medium for private channels', () => {
    const event: OpenClawEvent = { type: 'message_received', payload: {}, context: { isPrivate: true } };
    expect(mapSensitivity(event, 'low')).toBe('medium');
  });

  it('returns medium for tool calls', () => {
    const event: OpenClawEvent = { type: 'after_tool_call', payload: {} };
    expect(mapSensitivity(event, 'low')).toBe('medium');
  });

  it('falls back to default config', () => {
    const event: OpenClawEvent = { type: 'message_received', payload: {} };
    expect(mapSensitivity(event, 'low')).toBe('low');
  });

  it('returns hyper for invalid sensitivity values', () => {
    const event: OpenClawEvent = { type: 'message_received', payload: {}, context: { sensitivity: 'INVALID' } };
    expect(mapSensitivity(event, 'low')).toBe('hyper');
  });
});

describe('mapEvent', () => {
  it('maps message_received to IngestEvent', () => {
    const event: OpenClawEvent = { type: 'message_received', payload: { content: 'Hello' } };
    const result = mapEvent(event, 'low');
    expect(result).not.toBeNull();
    expect(result!.method).toBe('IngestEvent');
    expect(result!.payload.event_kind).toBe('user_message');
    expect(result!.payload.summary).toBe('Hello');
  });

  it('maps message_sent to IngestEvent', () => {
    const event: OpenClawEvent = { type: 'message_sent', payload: { content: 'Reply' } };
    const result = mapEvent(event, 'low');
    expect(result).not.toBeNull();
    expect(result!.method).toBe('IngestEvent');
    expect(result!.payload.event_kind).toBe('assistant_message');
  });

  it('maps session_start to IngestEvent', () => {
    const event: OpenClawEvent = { type: 'session_start', payload: {} };
    const result = mapEvent(event, 'low');
    expect(result!.method).toBe('IngestEvent');
    expect(result!.payload.event_kind).toBe('session_init');
  });

  it('maps after_tool_call to IngestToolOutput', () => {
    const event: OpenClawEvent = { type: 'after_tool_call', payload: { toolName: 'exec', params: { cmd: 'ls' }, result: { ok: true } } };
    const result = mapEvent(event, 'medium');
    expect(result!.method).toBe('IngestToolOutput');
    expect(result!.payload.tool_name).toBe('exec');
  });

  it('maps fact_extracted to IngestObservation', () => {
    const event: OpenClawEvent = { type: 'fact_extracted', payload: { subject: 'Jane Doe', predicate: 'is', object: 'CTO' } };
    const result = mapEvent(event, 'low');
    expect(result!.method).toBe('IngestObservation');
    expect(result!.payload.subject).toBe('Jane Doe');
  });

  it('maps task_completed to IngestOutcome', () => {
    const event: OpenClawEvent = { type: 'task_completed', payload: { targetId: 'rec-1', success: true } };
    const result = mapEvent(event, 'low');
    expect(result!.method).toBe('IngestOutcome');
    expect(result!.payload.outcome_status).toBe('success');
  });

  it('returns null for unknown events', () => {
    const event: OpenClawEvent = { type: 'unknown_event', payload: {} };
    expect(mapEvent(event, 'low')).toBeNull();
  });

  it('handles missing content gracefully', () => {
    const event: OpenClawEvent = { type: 'message_received', payload: {} };
    const result = mapEvent(event, 'low');
    expect(result!.payload.summary).toBe('');
  });
});
