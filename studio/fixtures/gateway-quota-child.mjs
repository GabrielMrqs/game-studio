import { createGateway } from '../model-gateway.mjs';

const gateway = await createGateway({ key: 'fixture', model: 'fixture-model', maxRequests: 3, maxOutputTokens: 64, stateFile: process.env.FIXTURE_QUOTA, upstream: process.env.FIXTURE_UPSTREAM });
gateway.server.listen(0, '127.0.0.1', () => process.send(gateway.server.address().port));
process.on('message', async () => { await gateway.close(); process.disconnect(); });
