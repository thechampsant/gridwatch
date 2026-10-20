import type { z } from 'zod';
import {
  FaultEvent,
  KNOWN_TYPES,
  MeterValueEvent,
  SessionStartEvent,
  SessionStopEvent,
  StatusEvent,
} from '../csms/schemas.js';

// Internal event model. Every timestamp is a UTC instant; the vendor's original
// string (with the charger's local offset) is kept for audit and display.
interface Base {
  chargerId: string;
  connectorId: string;
  ts: Date;
  tsRaw: string;
}

export type NormalizedEvent =
  | (Base & { kind: 'status'; status: string })
  | (Base & { kind: 'meter'; energyWh: number; powerW: number | null })
  | (Base & { kind: 'fault'; code: string; severity: 'info' | 'warning' | 'critical' })
  | (Base & { kind: 'session_start'; sessionId: string; startMeterWh: number })
  | (Base & { kind: 'session_stop'; sessionId: string; startMeterWh: number; stopMeterWh: number });

// Whatever could be read from a rejected event, so the ingestion log can still
// say which charger it was about.
export interface PartialEvent {
  type?: string;
  chargerId?: string;
  connectorId?: string;
  tsRaw?: string;
  ts?: Date;
}

export type NormalizeResult =
  | { ok: true; event: NormalizedEvent }
  | { ok: false; reason: string; detail: string; partial: PartialEvent };

function describeIssues(err: z.ZodError): string {
  return err.issues
    .map((i) => {
      const field = i.path.length ? i.path.join('.') : 'event';
      return `${field}: ${i.message}`;
    })
    .join('; ');
}

function partialOf(raw: unknown): PartialEvent {
  if (typeof raw !== 'object' || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const p: PartialEvent = {};
  if (typeof r.type === 'string') p.type = r.type === 'session' && typeof r.event === 'string' ? r.event : r.type;
  if (typeof r.charger_id === 'string') p.chargerId = r.charger_id;
  if (typeof r.connector_id === 'string') p.connectorId = r.connector_id;
  if (typeof r.ts === 'string') {
    p.tsRaw = r.ts;
    const d = new Date(r.ts);
    if (!Number.isNaN(d.getTime())) p.ts = d;
  }
  return p;
}

function reject(raw: unknown, reason: string, detail: string): NormalizeResult {
  return { ok: false, reason, detail, partial: partialOf(raw) };
}

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> | z.ZodError {
  const r = schema.safeParse(raw);
  return r.success ? r.data : r.error;
}

export function normalizeEvent(raw: unknown): NormalizeResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return reject(raw, 'malformed_event', 'event is not a JSON object');
  }
  const type = (raw as Record<string, unknown>).type;
  if (typeof type !== 'string' || !(KNOWN_TYPES as readonly string[]).includes(type)) {
    return reject(raw, 'unknown_event_type', `unsupported type ${JSON.stringify(type)}`);
  }

  if (type === 'status') {
    const e = parse(StatusEvent, raw);
    if (e instanceof Error) return reject(raw, 'malformed_event', describeIssues(e));
    return { ok: true, event: { kind: 'status', ...base(e), status: e.status } };
  }
  if (type === 'meter_value') {
    const e = parse(MeterValueEvent, raw);
    if (e instanceof Error) return reject(raw, 'malformed_event', describeIssues(e));
    return {
      ok: true,
      event: { kind: 'meter', ...base(e), energyWh: e.energy_register_wh, powerW: e.power_w ?? null },
    };
  }
  if (type === 'fault') {
    const e = parse(FaultEvent, raw);
    if (e instanceof Error) return reject(raw, 'malformed_event', describeIssues(e));
    return { ok: true, event: { kind: 'fault', ...base(e), code: e.code, severity: e.severity } };
  }
  // type === 'session'
  const sub = (raw as Record<string, unknown>).event;
  if (sub === 'session.start') {
    const e = parse(SessionStartEvent, raw);
    if (e instanceof Error) return reject(raw, 'malformed_event', describeIssues(e));
    return {
      ok: true,
      event: { kind: 'session_start', ...base(e), sessionId: e.session_id, startMeterWh: e.start_meter_wh },
    };
  }
  if (sub === 'session.stop') {
    const e = parse(SessionStopEvent, raw);
    if (e instanceof Error) return reject(raw, 'malformed_event', describeIssues(e));
    return {
      ok: true,
      event: {
        kind: 'session_stop',
        ...base(e),
        sessionId: e.session_id,
        startMeterWh: e.start_meter_wh,
        stopMeterWh: e.stop_meter_wh,
      },
    };
  }
  return reject(raw, 'unknown_event_type', `unsupported session event ${JSON.stringify(sub)}`);
}

function base(e: { charger_id: string; connector_id: string; ts: string }): Base {
  return { chargerId: e.charger_id, connectorId: e.connector_id, ts: new Date(e.ts), tsRaw: e.ts };
}

// "14:32:11 +05:30": the time as the charger reported it, for display.
export function localTimeLabel(tsRaw: string | undefined): string | null {
  if (!tsRaw) return null;
  const m = /T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(tsRaw);
  return m ? `${m[1]} ${m[2] === 'Z' ? 'Z' : m[2]}` : tsRaw;
}

export function summarize(e: NormalizedEvent): string {
  switch (e.kind) {
    case 'status':
      return `status → ${e.status}`;
    case 'meter': {
      const kw = e.powerW === null ? '' : ` · ${(e.powerW / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 })} kW`;
      return `meter · ${e.energyWh.toLocaleString('en-US')} Wh${kw}`;
    }
    case 'fault':
      return `fault · ${e.code} (${e.severity})`;
    case 'session_start':
      return `session.start · ${e.sessionId}`;
    case 'session_stop':
      return `session.stop · ${e.sessionId}`;
  }
}

export function eventTypeOf(e: NormalizedEvent): string {
  switch (e.kind) {
    case 'meter':
      return 'meter_value';
    case 'session_start':
      return 'session.start';
    case 'session_stop':
      return 'session.stop';
    default:
      return e.kind;
  }
}
