import { describe, it, expect } from 'vitest';
import { parseMembraneRecords, selectMemories } from '../parser.js';

function makeEpisodicRecord(entries: Array<{ event_kind: string; summary: string; t?: string }>) {
  return Buffer.from(JSON.stringify({
    id: 'test-id',
    type: 'episodic',
    created_at: '2026-02-23T14:00:00Z',
    payload: {
      kind: 'episodic',
      timeline: entries.map(e => ({ t: e.t || '2026-02-23T14:00:00Z', ...e })),
    },
  }));
}

function makeSemanticRecord(subject: string, predicate: string, object: string) {
  return Buffer.from(JSON.stringify({
    id: 'sem-id',
    type: 'semantic',
    created_at: '2026-02-23T14:00:00Z',
    payload: { kind: 'semantic', subject, predicate, object },
  }));
}

// NOTE: Test fixtures use generic names ("Jane Doe", "Acme Corp") per code review policy — no PII.

function makeCompetenceRecord(description: string) {
  return Buffer.from(JSON.stringify({
    id: 'comp-id',
    type: 'competence',
    created_at: '2026-02-23T14:00:00Z',
    payload: { kind: 'competence', description },
  }));
}

function makeWorkingRecord(state: string) {
  return Buffer.from(JSON.stringify({
    id: 'work-id',
    type: 'working',
    created_at: '2026-02-23T14:00:00Z',
    payload: { kind: 'working', state },
  }));
}

describe('parseMembraneRecords', () => {
  it('parses episodic user_message into conversational', () => {
    const records = [makeEpisodicRecord([{ event_kind: 'user_message', summary: 'Hello world test' }])];
    const result = parseMembraneRecords(records);
    expect(result.conversational).toHaveLength(1);
    expect(result.conversational[0]).toContain('[user_message');
    expect(result.conversational[0]).toContain('Hello world test');
  });

  it('parses episodic assistant_message into conversational', () => {
    const records = [makeEpisodicRecord([{ event_kind: 'assistant_message', summary: 'I can help with that' }])];
    const result = parseMembraneRecords(records);
    expect(result.conversational).toHaveLength(1);
    expect(result.tool).toHaveLength(0);
  });

  it('puts tool_call into tool category', () => {
    const records = [makeEpisodicRecord([
      { event_kind: 'tool_call', summary: 'This is a detailed tool call with sufficient length for filtering' },
    ])];
    const result = parseMembraneRecords(records);
    expect(result.conversational).toHaveLength(0);
    expect(result.tool).toHaveLength(1);
  });

  it('filters short tool_call summaries', () => {
    const records = [makeEpisodicRecord([
      { event_kind: 'tool_call', summary: 'tool_call: exec' },
    ])];
    const result = parseMembraneRecords(records);
    expect(result.tool).toHaveLength(0);
  });

  it('filters very short summaries', () => {
    const records = [makeEpisodicRecord([
      { event_kind: 'user_message', summary: 'Hi' },
    ])];
    const result = parseMembraneRecords(records);
    expect(result.conversational).toHaveLength(0);
  });

  it('parses semantic records', () => {
    const records = [makeSemanticRecord('Jane Doe', 'works_as', 'engineer')];
    const result = parseMembraneRecords(records);
    expect(result.conversational).toHaveLength(1);
    expect(result.conversational[0]).toContain('[fact');
    expect(result.conversational[0]).toContain('Jane Doe works_as engineer');
  });

  it('parses competence records', () => {
    const records = [makeCompetenceRecord('Can deploy Docker containers efficiently')];
    const result = parseMembraneRecords(records);
    expect(result.conversational).toHaveLength(1);
    expect(result.conversational[0]).toContain('[competence');
  });

  it('parses working records', () => {
    const records = [makeWorkingRecord('Currently fixing NATS auth')];
    const result = parseMembraneRecords(records);
    expect(result.conversational).toHaveLength(1);
    expect(result.conversational[0]).toContain('[working');
  });

  it('handles invalid JSON gracefully', () => {
    const records = [Buffer.from('not-json')];
    const result = parseMembraneRecords(records);
    expect(result.conversational).toHaveLength(0);
    expect(result.tool).toHaveLength(0);
  });

  it('handles empty timeline', () => {
    const records = [makeEpisodicRecord([])];
    const result = parseMembraneRecords(records);
    expect(result.conversational).toHaveLength(0);
  });

  it('truncates long summaries', () => {
    const longSummary = 'A'.repeat(1000);
    const records = [makeEpisodicRecord([{ event_kind: 'user_message', summary: longSummary }])];
    const result = parseMembraneRecords(records);
    expect(result.conversational[0].length).toBeLessThan(600);
  });
});

describe('selectMemories', () => {
  it('prioritizes conversational over tool', () => {
    const parsed = {
      conversational: ['conv1', 'conv2', 'conv3'],
      tool: ['tool1', 'tool2'],
    };
    const result = selectMemories(parsed, 3);
    expect(result).toEqual(['conv1', 'conv2', 'conv3']);
  });

  it('fills remaining with tool memories', () => {
    const parsed = {
      conversational: ['conv1'],
      tool: ['tool1', 'tool2'],
    };
    const result = selectMemories(parsed, 3);
    expect(result).toEqual(['conv1', 'tool1', 'tool2']);
  });

  it('respects limit', () => {
    const parsed = {
      conversational: ['c1', 'c2', 'c3', 'c4', 'c5'],
      tool: ['t1'],
    };
    const result = selectMemories(parsed, 2);
    expect(result).toHaveLength(2);
  });

  it('handles empty memories', () => {
    const result = selectMemories({ conversational: [], tool: [] }, 5);
    expect(result).toHaveLength(0);
  });
});
