/**
 * Reliability buffer for Membrane gRPC calls.
 * Ring buffer with retry logic and exponential backoff.
 */

import type { PluginLogger } from './types.js';

export type IngestMethod = 'IngestEvent' | 'IngestToolOutput' | 'IngestObservation' | 'IngestOutcome';

export interface QueueItem {
  method: IngestMethod;
  payload: Record<string, unknown>;
  retries: number;
  timestamp: number;
}

export class RingBuffer {
  private buffer: (QueueItem | null)[];
  private head = 0;
  private tail = 0;
  private size: number;
  private count = 0;

  constructor(size: number) {
    this.size = size;
    this.buffer = new Array(size).fill(null);
  }

  push(item: QueueItem): boolean {
    if (this.count === this.size) {
      this.tail = (this.tail + 1) % this.size;
      this.count--;
    }
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.size;
    this.count++;
    return true;
  }

  pop(): QueueItem | null {
    if (this.count === 0) return null;
    const item = this.buffer[this.tail];
    this.buffer[this.tail] = null;
    this.tail = (this.tail + 1) % this.size;
    this.count--;
    return item;
  }

  get length(): number {
    return this.count;
  }
}

export class ReliabilityManager {
  private buffer: RingBuffer;
  private processing = false;
  private retryDelay = 100;
  private maxRetryDelay = 30000;
  private maxRetries = 10;

  constructor(
    size: number,
    private processor: (item: QueueItem) => Promise<void>,
    private logger?: PluginLogger
  ) {
    const safeSize = Math.max(size || 0, 1000);
    this.buffer = new RingBuffer(safeSize);
  }

  enqueue(method: IngestMethod, payload: Record<string, unknown>): void {
    this.buffer.push({
      method,
      payload,
      retries: 0,
      timestamp: Date.now()
    });
    this.process();
  }

  private async process(): Promise<void> {
    if (this.processing || this.buffer.length === 0) return;
    this.processing = true;

    while (this.buffer.length > 0) {
      const item = this.buffer.pop();
      if (!item) break;

      try {
        await this.processor(item);
        this.retryDelay = 100;
      } catch (err) {
        this.logger?.warn(`[membrane] Error processing ${item.method}: ${err instanceof Error ? err.message : String(err)}`);
        item.retries++;
        if (item.retries > this.maxRetries) {
          this.logger?.warn(`[membrane] Dropping ${item.method} after ${this.maxRetries} retries`);
          continue;
        }
        const delay = Math.min(this.retryDelay * Math.pow(2, item.retries), this.maxRetryDelay);
        this.buffer.push(item);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    this.processing = false;
  }

  async flush(timeoutMs: number): Promise<void> {
    const start = Date.now();
    let dropped = 0;
    while (this.buffer.length > 0 && (Date.now() - start) < timeoutMs) {
      const item = this.buffer.pop();
      if (item) {
        try {
          await this.processor(item);
        } catch (err) {
          dropped++;
          this.logger?.warn(`[membrane] Flush failed for ${item.method}, dropped (${dropped} total)`);
        }
      }
    }
    if (this.buffer.length > 0) {
      this.logger?.warn(`[membrane] Flush timeout: ${this.buffer.length} items still in buffer`);
    }
  }
}
