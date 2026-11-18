import { createServer } from 'node:http';
export function createIsolationModel(key, onToolResponse = () => {}) {
let requests = 0, observedTool = false, authorized = true, toolCalls = 0, toolResults = 0;
let command = 'node /fixture/isolation-agent.cjs';
let expectedToolFailure = false;
let expectedToolMarker = 'ISOLATION_TOOL_OK';
const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'POST' || req.url !== '/v1/responses') throw new Error('unexpected fixture request');
    if (req.headers.authorization !== `Bearer ${key}`) { authorized = false; throw new Error('gateway credential not injected'); }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    requests++;
    const input = JSON.stringify(body.input);
    const returnedTool = input.includes('function_call_output');
    if (returnedTool) { observedTool = input.includes(expectedToolMarker); if (observedTool) toolResults++; }
    if (returnedTool && !observedTool && expectedToolFailure) { res.writeHead(500).end('Fixture rejected duplicate tool failure'); return; }
    if (returnedTool && !observedTool) throw new Error('agent tool did not pass isolation checks');
    const callTool = !returnedTool && body.tools?.some((tool) => tool.name === 'shell');
    const text = returnedTool ? 'ISOLATION_FIXTURE_COMPLETE' : 'Isolation fixture';
    const item = callTool
      ? { id: 'fc_fixture', type: 'function_call', status: 'completed', call_id: 'call_fixture', name: 'shell', arguments: JSON.stringify({ command, description: 'Run disposable fixture checks' }) }
      : { id: 'msg_fixture', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
    const response = { id: `resp_fixture_${requests}`, object: 'response', created_at: 1700000000, status: 'completed', model: 'fixture-model', output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event('response.created', { response: { ...response, status: 'in_progress', output: [] } });
    if (callTool) {
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
    if (callTool) { toolCalls++; onToolResponse(); }
  } catch (error) {
    console.error(`Fixture model error: ${error.message}`);
    res.writeHead(500).end();
  }
});
return { server, stats: () => ({ requests, observedTool, authorized, toolCalls, toolResults }), setCommand: (value) => { command = value; }, setExpectedToolMarker: (value) => { expectedToolMarker = value; }, expectToolFailure: () => { expectedToolFailure = true; } };
}
