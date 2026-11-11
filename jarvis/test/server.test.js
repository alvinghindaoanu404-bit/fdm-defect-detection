import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { createServer } from '../src/server.js';
import { ScriptedProvider, testConfig } from './helpers.js';

async function startServer(env = {}, script = () => [{ text: 'Hello ' }, { text: 'there.' }]) {
  const cfg = testConfig({ EMAIL_ADDRESS: 'sam@gmail.com', EMAIL_PASSWORD: 'x', LOCAL_LLM_MODEL: 'm', ...env });
  const email = {
    sent: [],
    async read() {
      return { id: '7', from: [{ name: 'Anna', address: 'anna@example.org' }], subject: 'Lunch', text: 'Free on Friday?', messageId: '<m1@example.org>', references: [] };
    },
    async send(draft) {
      this.sent.push(draft);
      return { accepted: [draft.to] };
    },
  };
  const app = createApp(cfg, { provider: new ScriptedProvider(script), email });
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, { method = 'GET', body, headers = {} } = {}) =>
    fetch(base + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { ...app, email, base, call, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

/** Raw request, so the Host header can be forged the way a rebinding attack would. */
function rawGet(port, path, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

test('server: serves the app with a strict content security policy', async () => {
  const s = await startServer();
  try {
    const page = await s.call('/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Jarvis<\/title>/);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    for (const asset of ['/app.js', '/style.css', '/manifest.webmanifest', '/icon.svg']) assert.equal((await s.call(asset)).status, 200, asset);
    assert.equal((await s.call('/../.env')).status, 404);
    assert.equal((await s.call('/package.json')).status, 404);
    assert.equal((await s.call('/api/nope')).status, 404);
  } finally {
    await s.close();
  }
});

test('server: chat streams events and ends with the full reply', async () => {
  const s = await startServer({}, () => [{ tool: 'draft_reply', input: { email_id: '7', body: 'Yes.' } }, { text: 'Drafted ' }, { text: 'a reply.' }]);
  try {
    const res = await s.call('/api/chat', { method: 'POST', body: { message: 'reply yes', session: 'abc' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /ndjson/);
    const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(events.map((e) => e.type), ['tool', 'tool', 'text', 'text', 'done']);
    assert.deepEqual(events[0], { type: 'tool', name: 'draft_reply', label: 'Drafting a reply', status: 'start' });
    assert.deepEqual(events.at(-1), { type: 'done', text: 'Drafted a reply.', error: false });

    assert.equal((await s.call('/api/chat', { method: 'POST', body: { message: '  ' } })).status, 400);
    const ask = await s.call('/api/ask', { method: 'POST', body: { message: 'hi' } });
    assert.deepEqual(await ask.json(), { text: 'Drafted a reply.' });
  } finally {
    await s.close();
  }
});

test('server: drafts can be listed, edited, sent and discarded', async () => {
  const s = await startServer({}, () => [{ tool: 'draft_reply', input: { email_id: '7', body: 'Yes.' } }, { text: 'ok' }]);
  try {
    await s.call('/api/ask', { method: 'POST', body: { message: 'reply' } });
    await s.call('/api/ask', { method: 'POST', body: { message: 'reply again' } });
    const { drafts } = await (await s.call('/api/drafts')).json();
    assert.equal(drafts.length, 2);
    assert.deepEqual(Object.keys(drafts[0]).sort(), ['cc', 'createdAt', 'id', 'kind', 'subject', 'text', 'to']);
    assert.equal((await (await s.call('/api/status')).json()).pendingDrafts, 2);

    const [a, b] = drafts;
    assert.equal((await s.call(`/api/drafts/${a.id}`, { method: 'PUT', body: { text: 'Yes, see you then.' } })).status, 200);
    assert.equal((await s.call(`/api/drafts/${a.id}`, { method: 'PUT', body: { text: '  ' } })).status, 400);
    const sent = await s.call(`/api/drafts/${a.id}/send`, { method: 'POST', body: {} });
    assert.deepEqual(await sent.json(), { ok: true, to: 'Anna <anna@example.org>', subject: 'Re: Lunch' });
    assert.equal(s.email.sent[0].text, 'Yes, see you then.', 'the edited text is what goes out');
    assert.match(s.email.sent[0].quote, /> Free on Friday\?/);
    assert.equal((await s.call(`/api/drafts/${a.id}/send`, { method: 'POST', body: {} })).status, 400, 'no double send');

    assert.equal((await s.call(`/api/drafts/${b.id}/discard`, { method: 'POST', body: {} })).status, 200);
    assert.equal((await (await s.call('/api/drafts')).json()).drafts.length, 0);
    assert.equal(s.email.sent.length, 1);
  } finally {
    await s.close();
  }
});

test('server: notifications can be read and marked', async () => {
  const s = await startServer();
  try {
    s.store.addNotification({ kind: 'email', title: 'New email from Anna', body: 'Lunch' });
    s.store.addNotification({ kind: 'calendar', title: 'In 20 min: Dentist' });
    const first = await (await s.call('/api/notifications?since=0')).json();
    assert.deepEqual(first.notifications.map((n) => [n.title, n.read]), [['New email from Anna', false], ['In 20 min: Dentist', false]]);
    const later = await (await s.call(`/api/notifications?since=${first.notifications[0].id}`)).json();
    assert.equal(later.notifications.length, 1);
    await s.call('/api/notifications/read', { method: 'POST', body: {} });
    assert.equal(s.store.listNotifications({ unreadOnly: true }).length, 0);
    const qr = await (await s.call('/api/whatsapp/qr')).json();
    assert.deepEqual(qr, { status: 'disabled', detail: '', qr: null });
  } finally {
    await s.close();
  }
});

test('server: other websites cannot drive the API', async () => {
  const s = await startServer({}, () => [{ tool: 'draft_reply', input: { email_id: '7', body: 'Yes.' } }, { text: 'ok' }]);
  try {
    await s.call('/api/ask', { method: 'POST', body: { message: 'reply' } });
    const [{ id }] = s.store.listDrafts();
    // A form on a malicious page can only post these content types.
    const form = await fetch(`${s.base}/api/drafts/${id}/send`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(form.status, 415);
    const crossSite = await s.call(`/api/drafts/${id}/send`, { method: 'POST', body: {}, headers: { origin: 'https://evil.example' } });
    assert.equal(crossSite.status, 403);
    // DNS rebinding: the request reaches 127.0.0.1 under an attacker's hostname.
    assert.equal(await rawGet(s.port, '/api/status', 'evil.example'), 403);
    assert.equal(await rawGet(s.port, '/api/status', `localhost:${s.port}`), 200);
    assert.equal(s.email.sent.length, 0);
    const huge = await s.call('/api/chat', { method: 'POST', body: { message: 'x'.repeat(300_000) } });
    assert.equal(huge.status, 413);
  } finally {
    await s.close();
  }
});

test('server: with a token set, every API call needs it', async () => {
  const s = await startServer({ JARVIS_TOKEN: 'correct-horse-battery-staple' });
  try {
    assert.equal((await s.call('/')).status, 200, 'the page itself holds no data');
    assert.equal((await s.call('/api/status')).status, 401);
    assert.equal((await s.call('/api/status', { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await s.call('/api/chat', { method: 'POST', body: { message: 'hi' } })).status, 401);
    assert.equal((await s.call('/api/status', { headers: { authorization: 'Bearer correct-horse-battery-staple' } })).status, 200);
    assert.equal((await s.call('/api/status?token=correct-horse-battery-staple')).status, 200, 'query token, for Siri Shortcuts');
  } finally {
    await s.close();
  }
});
