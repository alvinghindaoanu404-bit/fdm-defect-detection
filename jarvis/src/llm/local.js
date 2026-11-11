// A model running on this computer, reached through the OpenAI-compatible
// chat-completions endpoint that Ollama, LM Studio and llama.cpp's server all
// expose. Nothing leaves the machine. This file deliberately does not use the
// Anthropic SDK: it talks to a different kind of server.
const MAX_STEPS = 10;
const REQUEST_TIMEOUT_MS = 10 * 60_000; // local models can be slow

function stripThinking(text) {
  // Reasoning models (qwen, deepseek, ...) may inline their scratchpad.
  return String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^[\s\S]*?<\/think>/, '')
    .trim();
}

function size(message) {
  return JSON.stringify(message).length;
}

/**
 * Keep the conversation inside a character budget by dropping the oldest
 * complete exchanges. An exchange starts at a user message, so tool calls are
 * never separated from their results.
 */
export function trimHistory(messages, budgetChars) {
  let total = messages.reduce((n, m) => n + size(m), 0);
  const out = [...messages];
  while (total > budgetChars) {
    const next = out.findIndex((m, i) => i > 0 && m.role === 'user');
    if (next === -1) break; // only the current exchange is left
    for (const m of out.splice(0, next)) total -= size(m);
  }
  return out;
}

export class LocalProvider {
  name = 'local';
  nativeWeb = false;
  maxToolResultChars = 6000;

  constructor(cfg, { fetchImpl = fetch } = {}) {
    this.cfg = cfg;
    this.model = cfg.model;
    this.fetch = fetchImpl;
  }

  async #complete(system, messages, tools) {
    const body = {
      model: this.model,
      messages: [{ role: 'system', content: system }, ...messages],
      stream: false,
      ...(tools.length
        ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) }
        : {}),
    };
    let res;
    try {
      res = await this.fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const e = new Error(`Could not reach the local model server at ${this.cfg.baseUrl}. Is Ollama (or LM Studio) running?`);
      e.cause = err;
      throw e;
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 400);
      throw new Error(`The local model server answered HTTP ${res.status}: ${detail || 'no details'}`);
    }
    const data = await res.json();
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error('The local model server returned an empty reply.');
    return message;
  }

  async run({ system, history = [], userText, tools, executeTool, onEvent = () => {} }) {
    if (!this.model) {
      throw new Error('No brain is configured. Set ANTHROPIC_API_KEY (Claude) or LOCAL_LLM_MODEL (a model on this computer) in your .env file.');
    }
    let messages = trimHistory([...history, { role: 'user', content: userText }], this.cfg.contextChars);
    let finalText = '';

    for (let step = 0; ; step++) {
      if (step >= MAX_STEPS) {
        finalText = `(I stopped after ${MAX_STEPS} steps without finishing. Ask me to continue if you want me to keep going.)`;
        break;
      }
      const reply = await this.#complete(system, messages, tools);
      const calls = Array.isArray(reply.tool_calls) ? reply.tool_calls : [];
      const text = stripThinking(reply.content);

      // Store only the fields the API accepts back.
      messages.push({ role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}) });

      if (calls.length === 0) {
        finalText = text;
        if (text) onEvent({ type: 'text', delta: text });
        break;
      }

      for (const call of calls) {
        let input = call.function?.arguments ?? {};
        let result;
        if (typeof input === 'string') {
          try {
            input = input.trim() ? JSON.parse(input) : {};
          } catch {
            result = { content: 'Tool arguments were not valid JSON. Call the tool again with a JSON object.', isError: true };
          }
        }
        result ??= await executeTool(call.function?.name ?? '', input);
        messages.push({ role: 'tool', tool_call_id: call.id, content: result.content });
      }
      messages = trimHistory(messages, this.cfg.contextChars);
    }

    return { text: finalText || '(No reply.)', history: messages };
  }

  describeError(err) {
    return err.message;
  }

  /** Used by `jarvis doctor`: is the server up, and does it have the model? */
  async check() {
    const res = await this.fetch(`${this.cfg.baseUrl}/models`, {
      headers: { authorization: `Bearer ${this.cfg.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${this.cfg.baseUrl}/models`);
    const data = await res.json();
    const ids = (data.data ?? []).map((m) => m.id);
    if (ids.length && !ids.includes(this.model)) {
      throw new Error(`Model "${this.model}" is not available. The server has: ${ids.slice(0, 8).join(', ')}`);
    }
  }
}
