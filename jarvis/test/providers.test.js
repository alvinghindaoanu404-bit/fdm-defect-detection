import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicProvider, echoable, pendingToolUses } from '../src/llm/anthropic.js';
import { LocalProvider, trimHistory } from '../src/llm/local.js';

const TOOLS = [{ name: 'list_emails', description: 'List emails', parameters: { type: 'object', properties: { limit: { type: 'integer' } }, required: [] } }];

// ---- Claude provider, with a scripted stand-in for the SDK client ---------------
function fakeClient(responses) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        stream(params) {
          requests.push(structuredClone(params));
          const next = responses.shift();
          const handlers = {};
          return {
            on(event, fn) {
              handlers[event] = fn;
              return this;
            },
            async finalMessage() {
              if (next instanceof Error) throw next;
              for (const block of next.content) {
                if (block.type === 'text') handlers.text?.(block.text);
                handlers.contentBlock?.(block);
              }
              return next;
            },
          };
        },
      },
    },
  };
}

const cfg = { model: 'claude-opus-5-5', effort: 'medium', fallbacks: true };
const thinking = { type: 'thinking', thinking: '', signature: 'sig' };

test('claude: runs the tool loop and sends results back in one user message', async () => {
  const client = fakeClient([
    { stop_reason: 'tool_use', content: [thinking, { type: 'tool_use', id: 't1', name: 'list_emails', input: { limit: 3 } }, { type: 'tool_use', id: 't2', name: 'list_emails', input: {} }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'You have two emails.' }] },
  ]);
  const provider = new AnthropicProvider(cfg, { client, nativeWeb: true });
  const events = [];
  const executed = [];
  const result = await provider.run({
    system: 'SYSTEM',
    history: [],
    userText: 'any mail?',
    tools: TOOLS,
    executeTool: async (name, input) => {
      executed.push([name, input]);
      return { content: `result ${executed.length}`, isError: executed.length === 2 };
    },
    onEvent: (e) => events.push(e),
  });

  assert.equal(result.text, 'You have two emails.');
  assert.deepEqual(executed, [['list_emails', { limit: 3 }], ['list_emails', {}]]);
  assert.deepEqual(events, [{ type: 'text', delta: 'You have two emails.' }]);

  const [first, second] = client.requests;
  assert.equal(first.model, 'claude-opus-5-5');
  assert.equal(first.system, 'SYSTEM');
  assert.deepEqual(first.output_config, { effort: 'medium' });
  assert.deepEqual(first.cache_control, { type: 'ephemeral' });
  assert.equal(first.fallbacks, 'default');
  assert.deepEqual(first.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(first.thinking, undefined, 'thinking is left to the model default (adaptive)');
  assert.equal(first.temperature, undefined);
  assert.deepEqual(first.tools[0], { name: 'list_emails', description: 'List emails', input_schema: TOOLS[0].parameters, eager_input_streaming: true });
  assert.deepEqual(first.tools.slice(1).map((t) => t.type), ['web_search_20260209', 'web_fetch_20260209']);

  // Second request: the assistant turn is echoed untouched (thinking included),
  // followed by ONE user message carrying both tool results.
  assert.equal(second.messages.length, 3);
  assert.deepEqual(second.messages[1].content[0], thinking);
  assert.deepEqual(second.messages[2], {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'result 1' },
      { type: 'tool_result', tool_use_id: 't2', content: 'result 2', is_error: true },
    ],
  });
  assert.equal(result.history.length, 4);
});

test('claude: a refusal leaves the conversation as it was', async () => {
  const client = fakeClient([{ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'policy' }, content: [] }]);
  const provider = new AnthropicProvider(cfg, { client });
  const history = [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }];
  const result = await provider.run({ system: 's', history, userText: 'bad', tools: [], executeTool: async () => assert.fail('no tools') });
  assert.match(result.text, /can't help with that request \(policy\)/);
  assert.equal(result.history, history);
  assert.equal(client.requests[0].tools, undefined, 'no tools array when there are no tools');
});

test('claude: a paused server-tool turn is resumed', async () => {
  const paused = [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'x' } }];
  const client = fakeClient([
    { stop_reason: 'pause_turn', content: paused },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Found it.' }] },
  ]);
  const provider = new AnthropicProvider(cfg, { client, nativeWeb: true });
  const events = [];
  const result = await provider.run({ system: 's', userText: 'search', tools: [], executeTool: async () => assert.fail(), onEvent: (e) => events.push(e) });
  assert.equal(result.text, 'Found it.');
  assert.deepEqual(client.requests[1].messages.at(-1), { role: 'assistant', content: paused });
  assert.deepEqual(events[0], { type: 'tool', name: 'web_search', status: 'done' });
});

test('claude: if built-in web tools are rejected, it carries on without them', async () => {
  const rejected = Anthropic.APIError.generate(400, { error: { message: 'web search is not enabled' } }, 'web search is not enabled', new Headers());
  const client = fakeClient([rejected, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hello.' }] }]);
  const provider = new AnthropicProvider(cfg, { client, nativeWeb: true });
  const events = [];
  const result = await provider.run({ system: 's', userText: 'hi', tools: TOOLS, executeTool: async () => assert.fail(), onEvent: (e) => events.push(e) });
  assert.equal(result.text, 'Hello.');
  assert.equal(client.requests[0].tools.length, 3);
  assert.equal(client.requests[1].tools.length, 1);
  assert.equal(provider.nativeWeb, false);
  assert.equal(events[0].type, 'notice');
});

test('claude: other API errors are not retried; unparseable tool input is, up to a limit', async () => {
  const auth = Anthropic.APIError.generate(401, { error: { message: 'bad key' } }, 'bad key', new Headers());
  const provider = new AnthropicProvider(cfg, { client: fakeClient([auth]) });
  await assert.rejects(provider.run({ system: 's', userText: 'hi', tools: [], executeTool: async () => {} }), (err) => err instanceof Anthropic.AuthenticationError);
  assert.match(provider.describeError(auth), /ANTHROPIC_API_KEY/);

  const flaky = fakeClient([new Error('bad json'), { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }]);
  const events = [];
  const ok = await new AnthropicProvider(cfg, { client: flaky }).run({ system: 's', userText: 'hi', tools: [], executeTool: async () => {}, onEvent: (e) => events.push(e) });
  assert.equal(ok.text, 'ok');
  assert.deepEqual(events[0], { type: 'reset' });

  const broken = fakeClient([new Error('1'), new Error('2'), new Error('3'), new Error('4')]);
  await assert.rejects(new AnthropicProvider(cfg, { client: broken }).run({ system: 's', userText: 'hi', tools: [], executeTool: async () => {} }), /3/);
  assert.equal(broken.requests.length, 3);
});

test('claude: truncated tool calls are never executed; long loops stop', async () => {
  const cut = fakeClient([{ stop_reason: 'max_tokens', content: [{ type: 'tool_use', id: 't', name: 'list_emails', input: {} }] }]);
  await assert.rejects(new AnthropicProvider(cfg, { client: cut }).run({ system: 's', userText: 'x', tools: TOOLS, executeTool: async () => assert.fail('must not run') }), /ran out of output space/);

  const forever = fakeClient(Array.from({ length: 30 }, (_, i) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t${i}`, name: 'list_emails', input: {} }] })));
  const result = await new AnthropicProvider(cfg, { client: forever }).run({ system: 's', userText: 'x', tools: TOOLS, executeTool: async () => ({ content: 'r', isError: false }) });
  assert.match(result.text, /stopped after 14 steps/);
  assert.equal(forever.requests.length, 14);
});

test('claude: after a mid-turn fallback, only safe blocks are echoed and only post-fallback tools run', () => {
  const content = [
    { type: 'thinking', thinking: '', signature: 'a' },
    { type: 'text', text: 'partial' },
    { type: 'tool_use', id: 'old', name: 'list_emails', input: {} },
    { type: 'server_tool_use', id: 'paired', name: 'web_search', input: {} },
    { type: 'web_search_tool_result', tool_use_id: 'paired', content: [] },
    { type: 'server_tool_use', id: 'orphan', name: 'web_search', input: {} },
    { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } },
    { type: 'thinking', thinking: '', signature: 'b' },
    { type: 'tool_use', id: 'new', name: 'list_emails', input: {} },
  ];
  assert.deepEqual(echoable(content).map((b) => b.id ?? b.tool_use_id ?? b.signature ?? b.type), ['text', 'paired', 'paired', 'fallback', 'b', 'new']);
  assert.deepEqual(pendingToolUses(content).map((b) => b.id), ['new']);
  const plain = [{ type: 'thinking', thinking: '', signature: 'a' }, { type: 'tool_use', id: 'x', name: 'n', input: {} }];
  assert.equal(echoable(plain), plain, 'without a fallback nothing is altered');
});

// ---- local provider, against a fake OpenAI-compatible server --------------------
async function fakeLocalServer(replies) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'tiny-model' }] }));
    }
    requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    const next = replies.shift();
    if (!next) {
      res.writeHead(500);
      return res.end('model crashed');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: next }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((r) => server.close(r)) };
}

test('local model: tool calls round-trip through the OpenAI-compatible API', async () => {
  const srv = await fakeLocalServer([
    { role: 'assistant', content: '<think>plan</think>', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_emails', arguments: '{"limit": 2}' } }, { id: 'c2', type: 'function', function: { name: 'list_emails', arguments: '{oops' } }] },
    { role: 'assistant', content: '<think>hmm</think>Two emails, nothing urgent.' },
  ]);
  try {
    const provider = new LocalProvider({ baseUrl: srv.baseUrl, model: 'tiny-model', apiKey: 'local', contextChars: 24000 });
    const executed = [];
    const events = [];
    const result = await provider.run({
      system: 'SYSTEM',
      userText: 'any mail?',
      tools: TOOLS,
      executeTool: async (name, input) => {
        executed.push([name, input]);
        return { content: '[{"id":"1"}]', isError: false };
      },
      onEvent: (e) => events.push(e),
    });
    assert.equal(result.text, 'Two emails, nothing urgent.', 'reasoning scratchpad is stripped');
    assert.deepEqual(events, [{ type: 'text', delta: 'Two emails, nothing urgent.' }]);
    assert.deepEqual(executed, [['list_emails', { limit: 2 }]], 'the call with broken JSON is not executed');

    const [first, second] = srv.requests;
    assert.equal(first.url, '/v1/chat/completions');
    assert.equal(first.auth, 'Bearer local');
    assert.deepEqual(first.body.messages, [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'any mail?' }]);
    assert.deepEqual(first.body.tools, [{ type: 'function', function: { name: 'list_emails', description: 'List emails', parameters: TOOLS[0].parameters } }]);
    assert.equal(first.body.stream, false);
    assert.deepEqual(second.body.messages.slice(3), [
      { role: 'tool', tool_call_id: 'c1', content: '[{"id":"1"}]' },
      { role: 'tool', tool_call_id: 'c2', content: 'Tool arguments were not valid JSON. Call the tool again with a JSON object.' },
    ]);
    assert.equal(result.history.at(-1).content, 'Two emails, nothing urgent.');
    await provider.check();
    await assert.rejects(new LocalProvider({ baseUrl: srv.baseUrl, model: 'other', apiKey: 'x' }).check(), /"other" is not available/);
  } finally {
    await srv.close();
  }
});

test('local model: failures produce actionable messages', async () => {
  const srv = await fakeLocalServer([]);
  try {
    const up = new LocalProvider({ baseUrl: srv.baseUrl, model: 'tiny-model', apiKey: 'x', contextChars: 24000 });
    await assert.rejects(up.run({ system: 's', userText: 'hi', tools: [], executeTool: async () => {} }), /HTTP 500: model crashed/);
  } finally {
    await srv.close();
  }
  const down = new LocalProvider({ baseUrl: 'http://127.0.0.1:1/v1', model: 'm', apiKey: 'x', contextChars: 24000 });
  await assert.rejects(down.run({ system: 's', userText: 'hi', tools: [], executeTool: async () => {} }), /Is Ollama \(or LM Studio\) running\?/);
  const unset = new LocalProvider({ baseUrl: 'http://127.0.0.1:1/v1', model: '', apiKey: 'x', contextChars: 24000 });
  await assert.rejects(unset.run({ system: 's', userText: 'hi', tools: [], executeTool: async () => {} }), /No brain is configured/);
});

test('local model: old exchanges are dropped whole to fit the context budget', () => {
  const big = 'x'.repeat(500);
  const messages = [
    { role: 'user', content: `one ${big}` },
    { role: 'assistant', content: '', tool_calls: [{ id: 'a' }] },
    { role: 'tool', tool_call_id: 'a', content: big },
    { role: 'assistant', content: 'done one' },
    { role: 'user', content: 'two' },
    { role: 'assistant', content: 'done two' },
    { role: 'user', content: 'three' },
  ];
  const trimmed = trimHistory(messages, 400);
  assert.deepEqual(trimmed.map((m) => m.content), ['two', 'done two', 'three']);
  assert.equal(trimHistory(messages, 1_000_000).length, 7);
  assert.equal(trimHistory([{ role: 'user', content: big }], 10).length, 1, 'never drops the current message');
});
