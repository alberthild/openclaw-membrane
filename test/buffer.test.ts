import { describe, it, expect, vi } from 'vitest';
import { RingBuffer, ReliabilityManager, type QueueItem } from '../buffer.js';

describe('RingBuffer', () => {
  it('pushes and pops items FIFO', () => {
    const buf = new RingBuffer(3);
    buf.push({ method: 'IngestEvent', payload: { a: 1 }, retries: 0, timestamp: 1 });
    buf.push({ method: 'IngestEvent', payload: { a: 2 }, retries: 0, timestamp: 2 });
    expect(buf.length).toBe(2);
    const item = buf.pop();
    expect(item?.payload).toEqual({ a: 1 });
    expect(buf.length).toBe(1);
  });

  it('drops oldest when full', () => {
    const buf = new RingBuffer(2);
    buf.push({ method: 'IngestEvent', payload: { a: 1 }, retries: 0, timestamp: 1 });
    buf.push({ method: 'IngestEvent', payload: { a: 2 }, retries: 0, timestamp: 2 });
    buf.push({ method: 'IngestEvent', payload: { a: 3 }, retries: 0, timestamp: 3 });
    expect(buf.length).toBe(2);
    const item = buf.pop();
    expect(item?.payload).toEqual({ a: 2 }); // oldest (a:1) was dropped
  });

  it('returns null on empty pop', () => {
    const buf = new RingBuffer(5);
    expect(buf.pop()).toBeNull();
    expect(buf.length).toBe(0);
  });
});

describe('ReliabilityManager', () => {
  it('processes enqueued items', async () => {
    const processed: QueueItem[] = [];
    const mgr = new ReliabilityManager(10, async (item) => { processed.push(item); });
    mgr.enqueue('IngestEvent', { test: true });
    await new Promise(r => setTimeout(r, 50));
    expect(processed).toHaveLength(1);
    expect(processed[0].method).toBe('IngestEvent');
  });

  it('retries on failure', async () => {
    let callCount = 0;
    const mgr = new ReliabilityManager(10, async () => {
      callCount++;
      if (callCount === 1) throw new Error('First call fails');
    });
    mgr.enqueue('IngestEvent', { test: true });
    await new Promise(r => setTimeout(r, 500));
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it('flushes buffer', async () => {
    const processed: QueueItem[] = [];
    const mgr = new ReliabilityManager(10, async (item) => {
      await new Promise(r => setTimeout(r, 10));
      processed.push(item);
    });
    // Directly flush without normal processing
    mgr.enqueue('IngestEvent', { a: 1 });
    mgr.enqueue('IngestEvent', { a: 2 });
    await mgr.flush(5000);
    // At least some items should be processed
    expect(processed.length).toBeGreaterThan(0);
  });
});
