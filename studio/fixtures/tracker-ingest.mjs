// Fixture-only polling: no real Linear endpoint or credentials.
import { createAdapter } from '../linear.mjs';
const adapter = await createAdapter({ inbox: '/project/ideas', state: '/handoff', apiKey: 'fixture-linear-key', team: 'fixture-team', label: 'studio', secret: 'fixture-webhook-secret', endpoint: 'http://fixture-upstream:8081/graphql' });
try { await adapter.poll(); } finally { await adapter.close(); }
