// Configuration: everything comes from environment variables (normally a
// `.env` file next to package.json). See .env.example for the full list.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Load `.env` if present. Variables already set in the environment win. */
export function loadEnvFile(file = path.join(ROOT, '.env')) {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

// Mail servers we can work out from the address alone. All of these need an
// "app password", not the normal account password.
const MAIL_PRESETS = {
  'gmail.com': { imap: 'imap.gmail.com', smtp: 'smtp.gmail.com' },
  'googlemail.com': { imap: 'imap.gmail.com', smtp: 'smtp.gmail.com' },
  'icloud.com': { imap: 'imap.mail.me.com', smtp: 'smtp.mail.me.com', smtpPort: 587 },
  'me.com': { imap: 'imap.mail.me.com', smtp: 'smtp.mail.me.com', smtpPort: 587 },
  'yahoo.com': { imap: 'imap.mail.yahoo.com', smtp: 'smtp.mail.yahoo.com' },
  'fastmail.com': { imap: 'imap.fastmail.com', smtp: 'smtp.fastmail.com' },
};

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function list(value) {
  return String(value ?? '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function oneOf(value, allowed, fallback) {
  const v = String(value ?? '').trim().toLowerCase();
  return allowed.includes(v) ? v : fallback;
}

export function loadConfig(env = process.env) {
  const problems = [];

  // --- Brain -------------------------------------------------------------
  const hasAnthropicCreds = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  const requested = oneOf(env.JARVIS_LLM, ['auto', 'anthropic', 'local'], 'auto');
  const provider = requested === 'auto' ? (hasAnthropicCreds ? 'anthropic' : 'local') : requested;

  const llm = {
    provider,
    anthropic: {
      model: env.JARVIS_MODEL?.trim() || 'claude-opus-5-5',
      effort: env.ANTHROPIC_EFFORT === undefined ? 'medium' : env.ANTHROPIC_EFFORT.trim(),
      fallbacks: bool(env.ANTHROPIC_FALLBACKS, true),
    },
    local: {
      baseUrl: (env.LOCAL_LLM_URL?.trim() || 'http://127.0.0.1:11434/v1').replace(/\/+$/, ''),
      model: env.LOCAL_LLM_MODEL?.trim() || '',
      apiKey: env.LOCAL_LLM_API_KEY?.trim() || 'local',
      contextChars: int(env.LOCAL_LLM_CONTEXT_CHARS, 24000),
    },
  };
  if (provider === 'local' && !llm.local.model) {
    problems.push(
      requested === 'auto'
        ? 'No brain is configured yet. Set ANTHROPIC_API_KEY (Claude) or LOCAL_LLM_MODEL (a model on this computer) in .env.'
        : 'JARVIS_LLM=local needs LOCAL_LLM_MODEL (the name of a tool-calling model, e.g. one pulled with Ollama).',
    );
  }

  // --- Email -------------------------------------------------------------
  const address = env.EMAIL_ADDRESS?.trim() || '';
  const domain = address.split('@')[1]?.toLowerCase() ?? '';
  const preset = MAIL_PRESETS[domain] ?? {};
  const smtpPort = int(env.EMAIL_SMTP_PORT, preset.smtpPort ?? 465);
  const email = {
    enabled: Boolean(address && env.EMAIL_PASSWORD),
    address,
    password: env.EMAIL_PASSWORD ?? '',
    fromName: env.EMAIL_FROM_NAME?.trim() || env.JARVIS_USER_NAME?.trim() || '',
    imap: {
      host: env.EMAIL_IMAP_HOST?.trim() || preset.imap || '',
      port: int(env.EMAIL_IMAP_PORT, 993),
      secure: bool(env.EMAIL_IMAP_SECURE, true),
    },
    smtp: {
      host: env.EMAIL_SMTP_HOST?.trim() || preset.smtp || '',
      port: smtpPort,
      secure: bool(env.EMAIL_SMTP_SECURE, smtpPort === 465),
    },
    // 'approve': the assistant can only draft; you press Send.
    // 'auto': the assistant may send on its own. Read the README first.
    sendMode: oneOf(env.EMAIL_SEND_MODE, ['approve', 'auto'], 'approve'),
  };
  if (address && !env.EMAIL_PASSWORD) problems.push('EMAIL_ADDRESS is set but EMAIL_PASSWORD is empty.');
  if (email.enabled && (!email.imap.host || !email.smtp.host)) {
    problems.push(`No mail servers known for "${domain}". Set EMAIL_IMAP_HOST and EMAIL_SMTP_HOST.`);
    email.enabled = false;
  }

  // --- Calendar ----------------------------------------------------------
  const sources = list(env.CALENDAR_ICS_URLS).map((s) => s.replace(/^webcal:\/\//i, 'https://'));
  const calendar = { enabled: sources.length > 0, sources };

  // --- WhatsApp ----------------------------------------------------------
  const whatsapp = {
    enabled: bool(env.WHATSAPP_ENABLED, false),
    // Talk to Jarvis by messaging yourself ("Message yourself" chat).
    selfChat: bool(env.WHATSAPP_CHAT_WITH_SELF, true),
    // Push email/calendar alerts and the daily briefing to that same chat.
    notify: bool(env.WHATSAPP_NOTIFY, true),
  };

  // --- Web ---------------------------------------------------------------
  const web = {
    search: oneOf(env.WEB_SEARCH, ['auto', 'anthropic', 'duckduckgo', 'brave', 'off'], 'auto'),
    braveKey: env.BRAVE_API_KEY?.trim() || '',
    allowPrivateHosts: bool(env.WEB_ALLOW_PRIVATE_HOSTS, false),
  };
  if (web.search === 'brave' && !web.braveKey) problems.push('WEB_SEARCH=brave needs BRAVE_API_KEY.');
  if (web.search === 'anthropic' && provider !== 'anthropic') {
    problems.push('WEB_SEARCH=anthropic only works with the Claude brain; falling back to DuckDuckGo.');
    web.search = 'duckduckgo';
  }

  // --- Server ------------------------------------------------------------
  const host = env.JARVIS_HOST?.trim() || '127.0.0.1';
  const server = {
    host,
    port: int(env.JARVIS_PORT, 8787),
    token: env.JARVIS_TOKEN?.trim() || '',
    loopbackOnly: LOOPBACK.has(host),
  };
  if (!server.loopbackOnly && server.token.length < 16) {
    problems.push(
      'JARVIS_HOST exposes Jarvis to your network, so JARVIS_TOKEN must be set to a long random string (16+ characters).',
    );
  }

  // --- Proactive checks ---------------------------------------------------
  const briefTime = env.DAILY_BRIEF_TIME?.trim() || '';
  if (briefTime && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(briefTime)) {
    problems.push(`DAILY_BRIEF_TIME must look like 07:30, got "${briefTime}".`);
  }
  const watcher = {
    enabled: bool(env.WATCHER_ENABLED, true),
    intervalMinutes: Math.max(1, int(env.WATCH_INTERVAL_MINUTES, 5)),
    eventLeadMinutes: Math.max(1, int(env.EVENT_REMINDER_MINUTES, 30)),
    briefTime: /^([01]?\d|2[0-3]):[0-5]\d$/.test(briefTime) ? briefTime.padStart(5, '0') : '',
  };

  const timezone = env.JARVIS_TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
  } catch {
    problems.push(`JARVIS_TIMEZONE "${timezone}" is not a valid IANA time zone (e.g. Europe/London).`);
  }

  return {
    dataDir: path.resolve(ROOT, env.JARVIS_DATA_DIR?.trim() || 'data'),
    user: { name: env.JARVIS_USER_NAME?.trim() || 'the user', timezone },
    llm,
    email,
    calendar,
    whatsapp,
    web,
    server,
    watcher,
    problems,
  };
}
