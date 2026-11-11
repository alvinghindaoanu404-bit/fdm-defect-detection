import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { validateInput } from '../src/tools/validate.js';
import { tmpDir } from './helpers.js';

const schema = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 25 },
    unread_only: { type: 'boolean' },
    mode: { type: 'string', enum: ['a', 'b'] },
  },
  required: ['query'],
};

test('validateInput accepts good input and drops unknown keys', () => {
  const r = validateInput(schema, { query: 'x', limit: 5, extra: 'ignored' });
  assert.deepEqual(r, { ok: true, value: { query: 'x', limit: 5 } });
});

test('validateInput coerces the sloppy types local models produce', () => {
  const r = validateInput(schema, { query: 'x', limit: '7', unread_only: 'true' });
  assert.deepEqual(r.value, { query: 'x', limit: 7, unread_only: true });
});

test('validateInput clamps numbers to the allowed range', () => {
  assert.equal(validateInput(schema, { query: 'x', limit: 500 }).value.limit, 25);
  assert.equal(validateInput(schema, { query: 'x', limit: 0 }).value.limit, 1);
});

test('validateInput rejects missing, empty and mistyped fields', () => {
  assert.match(validateInput(schema, {}).error, /"query" is required/);
  assert.match(validateInput(schema, { query: '  ' }).error, /must not be empty/);
  assert.match(validateInput(schema, { query: 'x', limit: 'many' }).error, /"limit" must be a integer/);
  assert.match(validateInput(schema, { query: 'x', mode: 'c' }).error, /one of: a, b/);
  assert.equal(validateInput(schema, 'nope').ok, false);
  assert.equal(validateInput(schema, null).ok, false);
});

test('config: brain is picked from what is available', () => {
  assert.equal(loadConfig({ ANTHROPIC_API_KEY: 'k' }).llm.provider, 'anthropic');
  assert.equal(loadConfig({ ANTHROPIC_API_KEY: 'k' }).llm.anthropic.model, 'claude-opus-5-5');
  const local = loadConfig({ LOCAL_LLM_MODEL: 'some-model' });
  assert.equal(local.llm.provider, 'local');
  assert.deepEqual(local.problems, []);
  assert.match(loadConfig({}).problems.join(' '), /No brain is configured yet/);
  assert.match(loadConfig({ JARVIS_LLM: 'local' }).problems.join(' '), /JARVIS_LLM=local needs LOCAL_LLM_MODEL/);
  assert.equal(loadConfig({ ANTHROPIC_API_KEY: 'k', JARVIS_LLM: 'local', LOCAL_LLM_MODEL: 'm' }).llm.provider, 'local');
});

test('config: mail servers are inferred for known providers, sending needs approval by default', () => {
  const cfg = loadConfig({ EMAIL_ADDRESS: 'me@gmail.com', EMAIL_PASSWORD: 'app-password' });
  assert.equal(cfg.email.enabled, true);
  assert.equal(cfg.email.imap.host, 'imap.gmail.com');
  assert.deepEqual(cfg.email.smtp, { host: 'smtp.gmail.com', port: 465, secure: true });
  assert.equal(cfg.email.sendMode, 'approve');
  const icloud = loadConfig({ EMAIL_ADDRESS: 'me@icloud.com', EMAIL_PASSWORD: 'x' });
  assert.deepEqual(icloud.email.smtp, { host: 'smtp.mail.me.com', port: 587, secure: false });
  const unknown = loadConfig({ EMAIL_ADDRESS: 'me@corp.example', EMAIL_PASSWORD: 'x' });
  assert.equal(unknown.email.enabled, false);
  assert.match(unknown.problems.join(' '), /EMAIL_IMAP_HOST/);
});

test('config: exposing the server to the network requires a token', () => {
  assert.equal(loadConfig({}).server.loopbackOnly, true);
  assert.match(loadConfig({ JARVIS_HOST: '0.0.0.0' }).problems.join(' '), /JARVIS_TOKEN/);
  assert.deepEqual(loadConfig({ JARVIS_HOST: '0.0.0.0', JARVIS_TOKEN: 'a-long-random-token-123', LOCAL_LLM_MODEL: 'm' }).problems, []);
});

test('config: calendar links, WhatsApp default and bad values', () => {
  const cfg = loadConfig({ CALENDAR_ICS_URLS: 'webcal://example.com/a.ics, https://example.com/b.ics', DAILY_BRIEF_TIME: '7:30', LOCAL_LLM_MODEL: 'm' });
  assert.deepEqual(cfg.calendar.sources, ['https://example.com/a.ics', 'https://example.com/b.ics']);
  assert.equal(cfg.watcher.briefTime, '07:30');
  assert.equal(cfg.whatsapp.enabled, false);
  assert.match(loadConfig({ DAILY_BRIEF_TIME: 'morning' }).problems.join(' '), /DAILY_BRIEF_TIME/);
  assert.match(loadConfig({ JARVIS_TIMEZONE: 'Mars/Olympus' }).problems.join(' '), /JARVIS_TIMEZONE/);
});

test('store: drafts, notifications and WhatsApp messages persist across restarts', () => {
  const dir = tmpDir();
  const a = new Store(dir);
  const draft = a.addDraft({ to: 'x@example.org', subject: 'Hi', text: 'Hello' });
  assert.match(draft.id, /^[0-9a-f]{4}$/);
  assert.ok(a.addNotification({ kind: 'email', title: 'New', key: 'k1' }));
  assert.equal(a.addNotification({ kind: 'email', title: 'New again', key: 'k1' }), null, 'same key is stored once');
  assert.equal(a.addWhatsAppMessage({ id: 'w1', chat: 'Mum', sender: 'Mum', text: 'call me', timestamp: Date.now() }), true);
  assert.equal(a.addWhatsAppMessage({ id: 'w1', chat: 'Mum', sender: 'Mum', text: 'call me', timestamp: Date.now() }), false);

  const b = new Store(dir);
  assert.equal(b.getDraft(draft.id.toUpperCase()).subject, 'Hi');
  assert.equal(b.listNotifications().length, 1);
  assert.equal(b.listNotifications({ unreadOnly: true }).length, 1);
  b.markNotificationsRead();
  assert.equal(b.listNotifications({ unreadOnly: true }).length, 0);
  assert.equal(b.listWhatsAppMessages({ chat: 'mum' }).length, 1);
  assert.equal(b.listWhatsAppMessages({ chat: 'dad' }).length, 0);
  b.updateDraft(draft.id, { status: 'sent' });
  assert.equal(new Store(dir).listDrafts().length, 0);
});
