import { issueToken } from '../api/auth.js';
import { config } from '../config.js';

// Usage: node dist/bin/mint-token.js acme-charge | stadtwerke-ev | platform_admin
const who = process.argv[2];
if (!who) {
  console.error('usage: mint-token <operator_id | platform_admin>');
  process.exit(2);
}
const token =
  who === 'platform_admin'
    ? await issueToken(config.jwtSecret(), { sub: 'cli-admin', role: 'platform_admin' })
    : await issueToken(config.jwtSecret(), { sub: `cli-${who}`, role: 'operator', operator_id: who });
console.log(token);
