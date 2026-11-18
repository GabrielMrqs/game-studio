// Fixture-only upstream: never forwards to a real provider.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createGateway } from '../model-gateway.mjs';
const key = (await readFile('/run/secrets/fixture_key', 'utf8')).trim();
const stateFile = process.env.FIXTURE_STATE || '/tmp/quota.sqlite';
const gateway = await createGateway({ key, model: 'fixture-model', maxRequests: 50, maxOutputTokens: 64, stateFile, initialize: !existsSync(stateFile), upstream: 'http://fixture-upstream:8081/v1/responses' });
if (process.env.FIXTURE_SOCKET) gateway.server.listen(process.env.FIXTURE_SOCKET);
else gateway.server.listen(8080, '0.0.0.0');
process.on('SIGTERM', async () => { await gateway.close(); process.exit(0); });
