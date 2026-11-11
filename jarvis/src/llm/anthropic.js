// Claude as the brain, through the official Anthropic SDK.
//
// A manual tool loop (rather than the SDK's tool runner) because we need to
// own a few things: an approval-friendly tool executor shared with the local
// provider, server-side web tools, and refusal/fallback handling.
import Anthropic from '@anthropic-ai/sdk';

const MAX_STEPS = 14;
const MAX_TOKENS = 32_000;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * Prepare an assistant turn for sending back to the API.
 *
 * Normally the content is echoed untouched (thinking blocks included). The one
 * exception is a turn where a server-side fallback happened part-way through:
 * blocks produced by the declined attempt, before the final `fallback` marker,
 * must be dropped except for text and completed server-tool pairs.
 */
export function echoable(content) {
  const boundary = content.findLastIndex((b) => b.type === 'fallback');
  if (boundary === -1) return content;
  const resultIds = new Set(content.filter((b) => b.tool_use_id).map((b) => b.tool_use_id));
  return content.filter((block, i) => {
    if (i >= boundary) return true;
    if (block.type === 'text') return true;
    if (block.type === 'server_tool_use') return resultIds.has(block.id);
    return Boolean(block.tool_use_id); // server-tool results stay with their paired call
  });
}

/** Client tool calls we should actually run: only those after the last fallback marker. */
export function pendingToolUses(content) {
  const boundary = content.findLastIndex((b) => b.type === 'fallback');
  return content.filter((b, i) => i > boundary && b.type === 'tool_use');
}

export class AnthropicProvider {
  name = 'anthropic';
  maxToolResultChars = 24_000;

  constructor(cfg, { client, nativeWeb = false } = {}) {
    this.cfg = cfg;
    this.model = cfg.model;
    // Reads ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / an `ant auth login` profile.
    this.client = client ?? new Anthropic();
    this.nativeWeb = nativeWeb;
    this.nativeWebVerified = false;
  }

  #params(system, tools, messages, useNativeWeb) {
    const apiTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
      // Stream tool input as it is generated; inputs are validated by the
      // shared executor before any tool runs.
      eager_input_streaming: true,
    }));
    if (useNativeWeb) {
      apiTools.push(
        { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
        { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 },
      );
    }
    return {
      model: this.model,
      max_tokens: MAX_TOKENS,
      // The system prompt and tool list never change within a run, so they
      // (and the growing conversation) are served from the prompt cache.
      cache_control: { type: 'ephemeral' },
      system,
      messages,
      ...(apiTools.length ? { tools: apiTools } : {}),
      ...(this.cfg.effort ? { output_config: { effort: this.cfg.effort } } : {}),
      // If a safety classifier declines a request, let the API retry it on
      // Anthropic's recommended fallback model instead of failing the turn.
      ...(this.cfg.fallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {}),
    };
  }

  async run({ system, history = [], userText, tools, executeTool, onEvent = () => {} }) {
    const messages = [...history, { role: 'user', content: userText }];
    let useNativeWeb = this.nativeWeb;
    let jsonRetries = 0;
    let finalText = '';

    for (let step = 0; ; step++) {
      if (step >= MAX_STEPS) {
        finalText = `${finalText}\n\n(I stopped after ${MAX_STEPS} steps without finishing. Ask me to continue if you want me to keep going.)`.trim();
        break;
      }

      const stream = this.client.beta.messages.stream(this.#params(system, tools, messages, useNativeWeb));
      stream.on('text', (delta) => onEvent({ type: 'text', delta }));
      // Server-side tools (web search/fetch) run at Anthropic; surface them too.
      stream.on('contentBlock', (block) => {
        if (block.type === 'server_tool_use') onEvent({ type: 'tool', name: block.name, status: 'done' });
      });

      let message;
      try {
        message = await stream.finalMessage();
        jsonRetries = 0;
        if (useNativeWeb) this.nativeWebVerified = true;
      } catch (err) {
        if (err instanceof Anthropic.BadRequestError && useNativeWeb && !this.nativeWebVerified) {
          // Most likely web search is not enabled for this API organization.
          // Carry on without it rather than failing every request.
          useNativeWeb = false;
          this.nativeWeb = false;
          onEvent({ type: 'notice', text: `Claude's built-in web tools were rejected (${err.message}). Continuing without web access; set WEB_SEARCH=duckduckgo to search from this computer instead.` });
          step--;
          continue;
        }
        // With eager input streaming a tool input can fail to parse; that is the
        // only failure worth re-issuing. API errors go to the caller.
        if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
        onEvent({ type: 'reset' });
        step--;
        continue;
      }

      const text = message.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');

      if (message.stop_reason === 'refusal') {
        // Do not keep a declined exchange in the conversation.
        const why = message.stop_details?.explanation ? ` (${message.stop_details.explanation})` : '';
        return { text: text || `I can't help with that request${why}.`, history };
      }

      if (message.stop_reason === 'pause_turn') {
        // A long server-side tool turn paused; send it back so it continues.
        messages.push({ role: 'assistant', content: echoable(message.content) });
        continue;
      }

      const toolUses = pendingToolUses(message.content);
      if (toolUses.length === 0) {
        messages.push({ role: 'assistant', content: echoable(message.content) });
        finalText = text;
        if (message.stop_reason === 'max_tokens') finalText += '\n\n(My answer was cut off for length.)';
        if (message.stop_reason === 'model_context_window_exceeded') {
          finalText += '\n\n(This conversation has become too long. Type /new to start a fresh one.)';
        }
        break;
      }

      if (message.stop_reason === 'max_tokens') {
        // A tool input cut off mid-way can still parse as a valid partial
        // object; never run tools on it.
        throw new Error('The model ran out of output space while calling a tool. Please try again.');
      }

      messages.push({ role: 'assistant', content: echoable(message.content) });

      // All results for one assistant turn go back in a single user message.
      const results = [];
      for (const use of toolUses) {
        const result = await executeTool(use.name, use.input);
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        });
      }
      messages.push({ role: 'user', content: results });
    }

    return { text: finalText || '(No reply.)', history: messages };
  }

  /** Turn an SDK error into something a non-developer can act on. */
  describeError(err) {
    if (err instanceof Anthropic.AuthenticationError) return 'Claude rejected the API key. Check ANTHROPIC_API_KEY in your .env file.';
    if (err instanceof Anthropic.PermissionDeniedError) return `Claude refused access: ${err.message}`;
    if (err instanceof Anthropic.NotFoundError) return `Claude does not know the model "${this.model}". Check JARVIS_MODEL.`;
    if (err instanceof Anthropic.RateLimitError) return 'Claude is rate-limiting this API key. Wait a moment and try again.';
    if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Claude API. Check your internet connection.';
    if (err instanceof Anthropic.APIError) return `Claude API error ${err.status ?? ''}: ${err.message}`;
    return err.message;
  }
}
