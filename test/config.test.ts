import { describe, it, expect } from 'vitest';
import { createConfig, validateConfig } from '../index.js';

describe('validateConfig', () => {
  it('extracts valid string fields', () => {
    const result = validateConfig({ grpc_endpoint: 'localhost:9090' });
    expect(result.grpc_endpoint).toBe('localhost:9090');
  });

  it('extracts valid number fields', () => {
    const result = validateConfig({ buffer_size: 500, retrieve_limit: 10 });
    expect(result.buffer_size).toBe(500);
    expect(result.retrieve_limit).toBe(10);
  });

  it('extracts valid boolean fields', () => {
    const result = validateConfig({ retrieve_enabled: false });
    expect(result.retrieve_enabled).toBe(false);
  });

  it('ignores string "true" for boolean field', () => {
    const result = validateConfig({ retrieve_enabled: 'true' });
    expect(result.retrieve_enabled).toBeUndefined();
  });

  it('ignores wrong types', () => {
    const result = validateConfig({
      grpc_endpoint: 123,
      buffer_size: 'not-a-number',
      retrieve_enabled: 'yes',
    });
    expect(result.grpc_endpoint).toBeUndefined();
    expect(result.buffer_size).toBeUndefined();
    expect(result.retrieve_enabled).toBeUndefined();
  });

  it('ignores unknown keys', () => {
    const result = validateConfig({ unknown_key: 'value' });
    expect(Object.keys(result)).toHaveLength(0);
  });
});

describe('createConfig', () => {
  it('merges defaults with overrides', () => {
    const config = createConfig({ grpc_endpoint: 'custom:50051' });
    expect(config.grpc_endpoint).toBe('custom:50051');
    expect(config.buffer_size).toBe(1000); // default
    expect(config.retrieve_enabled).toBe(true); // default
  });

  it('returns all defaults when empty', () => {
    const config = createConfig({});
    expect(config.grpc_endpoint).toBe('localhost:50051');
    expect(config.buffer_size).toBe(1000);
    expect(config.default_sensitivity).toBe('low');
    expect(config.retrieve_enabled).toBe(true);
    expect(config.retrieve_limit).toBe(5);
    expect(config.retrieve_min_salience).toBe(0.1);
    expect(config.retrieve_max_sensitivity).toBe('medium');
    expect(config.retrieve_timeout_ms).toBe(2000);
  });
});
