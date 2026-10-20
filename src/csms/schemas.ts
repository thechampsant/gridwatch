import { z } from 'zod';

// Vendor CSMS contract (gridwatch-csms-stubs.md), validated at the edge.
// Envelopes are validated loosely: one bad event must never sink a page.
// Each event is then validated strictly on its own.

// ISO-8601 with an explicit offset (the vendor sends the charger's local
// offset) or Z. Anything else is ambiguous and rejected.
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
export const isoWithOffset = z
  .string()
  .regex(ISO_WITH_OFFSET, 'must be ISO-8601 with a UTC offset')
  .refine((s) => !Number.isNaN(Date.parse(s)), 'is not a real date');

export const PollPage = z.object({
  site_id: z.string().min(1),
  server_time: isoWithOffset,
  next_cursor: z.string().min(1).nullish(),
  events: z.array(z.unknown()),
});
export type PollPage = z.infer<typeof PollPage>;

export const WebhookBatch = z.object({
  delivery_id: z.string().min(1),
  events: z.array(z.unknown()),
});
export type WebhookBatch = z.infer<typeof WebhookBatch>;

// OCPP 1.6 connector statuses, plus OCPP 2.0.1's "Occupied".
export const CONNECTOR_STATUSES = [
  'Available',
  'Preparing',
  'Charging',
  'SuspendedEVSE',
  'SuspendedEV',
  'Finishing',
  'Reserved',
  'Unavailable',
  'Faulted',
  'Occupied',
] as const;

const ids = {
  charger_id: z.string().min(1),
  connector_id: z.string().min(1),
  ts: isoWithOffset,
};

const wh = z.number().int().nonnegative();

export const StatusEvent = z.object({
  type: z.literal('status'),
  ...ids,
  status: z.enum(CONNECTOR_STATUSES),
});

export const MeterValueEvent = z.object({
  type: z.literal('meter_value'),
  ...ids,
  energy_register_wh: wh,
  power_w: z.number().nonnegative().nullish(),
});

export const FaultEvent = z.object({
  type: z.literal('fault'),
  ...ids,
  code: z.string().min(1),
  severity: z.enum(['info', 'warning', 'critical']),
});

export const SessionStartEvent = z.object({
  type: z.literal('session'),
  event: z.literal('session.start'),
  ...ids,
  session_id: z.string().min(1),
  start_meter_wh: wh,
});

export const SessionStopEvent = z.object({
  type: z.literal('session'),
  event: z.literal('session.stop'),
  ...ids,
  session_id: z.string().min(1),
  start_meter_wh: wh,
  stop_meter_wh: wh,
});

export const KNOWN_TYPES = ['status', 'meter_value', 'fault', 'session'] as const;
