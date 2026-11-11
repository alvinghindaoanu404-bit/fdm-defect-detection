// Wires configuration, integrations, the model provider and the agent
// together. Used by the CLI and by tests (which pass their own provider).
import { Agent } from './agent.js';
import { CalendarService } from './integrations/calendar.js';
import { EmailService } from './integrations/email.js';
import { WebService } from './integrations/web.js';
import { WhatsAppService } from './integrations/whatsapp.js';
import { AnthropicProvider } from './llm/anthropic.js';
import { LocalProvider } from './llm/local.js';
import { Store } from './store.js';
import { Watcher } from './watcher.js';

export function createProvider(cfg) {
  if (cfg.llm.provider === 'anthropic') {
    // Claude's own search/fetch tools need a current Opus/Sonnet-class model.
    const nativeWeb = cfg.web.search === 'anthropic' || (cfg.web.search === 'auto' && !/haiku/i.test(cfg.llm.anthropic.model));
    return new AnthropicProvider(cfg.llm.anthropic, { nativeWeb });
  }
  return new LocalProvider(cfg.llm.local);
}

export function createApp(cfg, overrides = {}) {
  const store = overrides.store ?? new Store(cfg.dataDir);
  const services = {
    cfg,
    store,
    email: cfg.email.enabled ? (overrides.email ?? new EmailService(cfg.email)) : null,
    calendar: cfg.calendar.enabled ? (overrides.calendar ?? new CalendarService(cfg.calendar, { timezone: cfg.user.timezone })) : null,
    whatsapp: cfg.whatsapp.enabled ? (overrides.whatsapp ?? new WhatsAppService(cfg.whatsapp, store)) : null,
    web: overrides.web ?? new WebService(cfg.web),
  };
  const provider = overrides.provider ?? createProvider(cfg);
  const agent = new Agent({ cfg, provider, services });
  const watcher = new Watcher({ cfg, store, services, agent });

  // Messages you send to yourself on WhatsApp are messages to Jarvis.
  services.whatsapp?.on('self-message', ({ text }) => {
    agent
      .handle('whatsapp', text)
      .then((reply) => services.whatsapp.sendToSelf(reply.text))
      .catch((err) => console.warn(`[whatsapp] could not answer: ${err.message}`));
  });

  return { cfg, store, services, provider, agent, watcher };
}
