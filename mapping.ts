/**
 * Event mapping: OpenClaw events → Membrane gRPC payloads.
 * Each event type has its own mapping function.
 */

export interface OpenClawEvent {
  type: string;
  payload: Record<string, unknown>;
  context?: {
    channelType?: string;
    isPrivate?: boolean;
    sensitivity?: string;
  };
}

export const VALID_SENSITIVITIES = ['public', 'low', 'medium', 'high', 'hyper'] as const;
export type Sensitivity = typeof VALID_SENSITIVITIES[number];

interface MappedEvent {
  method: string;
  payload: Record<string, unknown>;
}

// --- Sensitivity ---

export function mapSensitivity(event: OpenClawEvent, defaultConfig: string): string {
  const isCredentialOrAuth = event.type.includes('credential') || event.type.includes('auth');

  let sensitivity: string;
  if (isCredentialOrAuth) {
    sensitivity = 'hyper';
  } else if (event.context?.sensitivity) {
    sensitivity = event.context.sensitivity;
  } else if (event.context?.isPrivate || event.context?.channelType === 'dm') {
    sensitivity = 'medium';
  } else if (event.type === 'after_tool_call') {
    sensitivity = 'medium';
  } else {
    sensitivity = defaultConfig || 'low';
  }

  if (!VALID_SENSITIVITIES.includes(sensitivity as Sensitivity)) {
    return 'hyper'; // Secure fallback
  }

  return sensitivity;
}

// --- Individual mappers ---

function mapMessageReceived(payload: Record<string, unknown>, timestamp: string, sensitivity: string): MappedEvent {
  return {
    method: 'IngestEvent',
    payload: {
      source: 'openclaw',
      event_kind: 'user_message',
      summary: typeof payload.content === 'string' ? payload.content : '',
      timestamp,
      sensitivity,
    },
  };
}

function mapMessageSent(payload: Record<string, unknown>, timestamp: string, sensitivity: string): MappedEvent {
  return {
    method: 'IngestEvent',
    payload: {
      source: 'openclaw',
      event_kind: 'assistant_message',
      summary: typeof payload.content === 'string' ? payload.content : '',
      timestamp,
      sensitivity,
    },
  };
}

function mapSessionStart(timestamp: string, sensitivity: string): MappedEvent {
  return {
    method: 'IngestEvent',
    payload: {
      source: 'openclaw',
      event_kind: 'session_init',
      summary: 'New session started',
      timestamp,
      sensitivity,
    },
  };
}

function mapToolCall(payload: Record<string, unknown>, timestamp: string, sensitivity: string): MappedEvent {
  return {
    method: 'IngestToolOutput',
    payload: {
      source: 'openclaw',
      tool_name: payload.toolName,
      args: Buffer.from(JSON.stringify(payload.params || {})),
      result: Buffer.from(JSON.stringify(payload.result || {})),
      timestamp,
      sensitivity,
    },
  };
}

function mapFactExtracted(payload: Record<string, unknown>, timestamp: string, sensitivity: string): MappedEvent {
  return {
    method: 'IngestObservation',
    payload: {
      source: 'openclaw',
      subject: payload.subject,
      predicate: payload.predicate,
      object: Buffer.from(JSON.stringify(payload.object || {})),
      timestamp,
      sensitivity,
    },
  };
}

function mapTaskCompleted(payload: Record<string, unknown>, timestamp: string): MappedEvent {
  return {
    method: 'IngestOutcome',
    payload: {
      source: 'openclaw',
      target_record_id: payload.targetId,
      outcome_status: payload.success ? 'success' : 'failure',
      timestamp,
    },
  };
}

// --- Main dispatcher ---

export function mapEvent(event: OpenClawEvent, sensitivity: string): MappedEvent | null {
  const timestamp = new Date().toISOString();

  switch (event.type) {
    case 'message_received':
      return mapMessageReceived(event.payload, timestamp, sensitivity);
    case 'message_sent':
      return mapMessageSent(event.payload, timestamp, sensitivity);
    case 'session_start':
      return mapSessionStart(timestamp, sensitivity);
    case 'after_tool_call':
      return mapToolCall(event.payload, timestamp, sensitivity);
    case 'fact_extracted':
      return mapFactExtracted(event.payload, timestamp, sensitivity);
    case 'task_completed':
      return mapTaskCompleted(event.payload, timestamp);
    default:
      return null;
  }
}
