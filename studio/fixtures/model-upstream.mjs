// Fixture-only Responses stream. The credential is a dummy Docker secret.
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
const key = (await readFile('/run/secrets/fixture_key', 'utf8')).trim();
let reviews = 0;
createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/graphql') {
    if (req.headers.authorization !== 'fixture-linear-key') { res.writeHead(403).end(); return; }
    for await (const _chunk of req) { /* consume request */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { team: { issues: { nodes: [{ id: '12345678-1234-1234-1234-123456789012', identifier: 'GAME-1', title: 'Fixture idea', description: 'Plan a harmless idea.', url: 'https://linear.app/fixture/issue/GAME-1', state: { type: 'unstarted' }, labels: { nodes: [{ name: 'studio' }] } }], pageInfo: { hasNextPage: false, endCursor: null } } } } }));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/v1/responses' || req.headers.authorization !== `Bearer ${key}`) { res.writeHead(403).end(); return; }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  await writeFile('/tmp/fixture-request.json', Buffer.concat(chunks));
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const context = JSON.stringify(body.input);
  const returnedTool = context.includes('function_call_output');
  let text = 'FIXTURE_OK';
  let write;
  if (context.includes('Act as producer.')) {
    if (!returnedTool) write = { path: 'plans/fixture.md', content: '# Fixture plan\nAcceptance: fixture test passes.\n' };
    else text = 'Plan ready.\nCEZ:VERDICT ready';
  } else if (context.includes('Act as gameplay engineer')) {
    if (!returnedTool) write = { path: 'studio/fixture-generated.test.mjs', content: "import { test } from 'node:test'; import { readFileSync } from 'node:fs'; import assert from 'node:assert/strict'; test('fixture feature', () => assert.equal(readFileSync('game/fixture-status.txt', 'utf8'), 'works'));\n" };
    else text = 'Implementation complete.';
  } else if (context.includes('Act as narrative/puzzle designer') || context.includes('Act as 2D art/UI integrator')) {
    text = 'No changes required for this fixture.';
  } else if (context.includes('Fix the failing check')) {
    if (!returnedTool) write = { path: 'game/fixture-status.txt', content: 'works' };
    else text = 'Fix complete.';
  } else if (context.includes('Act as QA.')) {
    text = 'Fixture QA passed.\nCEZ:VERDICT pass';
  } else if (context.includes('Independently review')) {
    reviews++;
    text = reviews === 1 ? 'Fixture requests a revision.\nCEZ:VERDICT changes' : 'Fixture review approved.\nCEZ:VERDICT approve';
  }
  const item = write
    ? { id: 'fc_fixture', type: 'function_call', status: 'completed', call_id: 'call_fixture', name: 'write', arguments: JSON.stringify(write) }
    : { id: 'msg_fixture', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
  const response = { id: 'resp_fixture', object: 'response', created_at: 1700000000, status: 'completed', model: 'fixture-model', output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('response.created', { response: { ...response, status: 'in_progress', output: [] } });
  if (write) {
    event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', arguments: '' } });
    event('response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: item.arguments });
    event('response.function_call_arguments.done', { item_id: item.id, output_index: 0, arguments: item.arguments });
  } else {
    event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    event('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text });
    event('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text });
    event('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
  }
  event('response.output_item.done', { output_index: 0, item });
  event('response.completed', { response });
  res.end();
}).listen(8081, '0.0.0.0');
