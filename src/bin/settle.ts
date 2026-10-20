import { runSettlement } from '../billing/settlement.js';
import { config } from '../config.js';
import { createPool } from '../db/pool.js';

// Usage: node dist/bin/settle.js --date 2026-06-09 [--operator acme-charge] [--force]
// Without --operator, settles every operator for its own local business day.
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const date = arg('date');
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('usage: settle --date YYYY-MM-DD [--operator ID] [--force]');
  process.exit(2);
}
const pool = createPool(config.databaseUrl(), 2);
const operators = arg('operator')
  ? [arg('operator')!]
  : (await pool.query<{ operator_id: string }>('SELECT operator_id FROM operators ORDER BY 1')).rows.map((r) => r.operator_id);

for (const op of operators) {
  const r = await runSettlement(pool, op, date, {
    now: new Date(),
    graceSec: Number(process.env.SETTLEMENT_GRACE_SEC ?? 7200),
    force: process.argv.includes('--force'),
  });
  console.log(JSON.stringify({ operator: op, ...r }));
}
await pool.end();
