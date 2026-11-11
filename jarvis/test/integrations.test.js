import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CalendarService } from '../src/integrations/calendar.js';
import { EmailService, buildReply, composeBody } from '../src/integrations/email.js';
import { WebService, parseDuckDuckGo } from '../src/integrations/web.js';
import { startImap, startSmtp } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---- calendar ---------------------------------------------------------------
test('calendar: expands recurring events, honours exclusions, skips cancelled and past', async () => {
  const cal = new CalendarService({ sources: [path.join(here, 'fixtures/calendar.ics')] }, { timezone: 'Europe/London' });
  const { events, errors } = await cal.upcoming({ from: new Date('2026-11-10T23:00:00Z'), days: 7 });
  assert.deepEqual(errors, []);
  assert.deepEqual(
    events.map((e) => `${cal.describe(e)} | ${e.title}`),
    [
      'Wed 11 Nov 09:30-09:45 | Team stand-up',
      'Wed 11 Nov 14:00-15:00 | Dentist',
      "Thu 12 Nov (all day) | Mum's birthday",
      // Friday the 13th is excluded by EXDATE
      'Mon 16 Nov 09:30-09:45 | Team stand-up',
    ],
  );
  assert.equal(events[1].location, '12 High Street');
});

test('calendar: times are shown in the configured time zone', async () => {
  const cal = new CalendarService({ sources: [path.join(here, 'fixtures/calendar.ics')] }, { timezone: 'America/New_York' });
  const { events } = await cal.upcoming({ from: new Date('2026-11-11T12:00:00Z'), days: 1 });
  assert.equal(cal.describe(events.find((e) => e.title === 'Dentist')), 'Wed 11 Nov 09:00-10:00');
});

test('calendar: a broken feed is reported, not fatal', async () => {
  const fetchImpl = async (url) => (String(url).includes('bad') ? new Response('<html>login</html>') : new Response('nope', { status: 404 }));
  const cal = new CalendarService({ sources: ['https://x.example/bad.ics', 'https://x.example/missing.ics', path.join(here, 'fixtures/calendar.ics')] }, { fetchImpl });
  const { events, errors } = await cal.upcoming({ from: new Date('2026-11-10T23:00:00Z'), days: 2 });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /not an iCalendar file/);
  assert.match(errors[1], /HTTP 404/);
  assert.ok(events.length > 0);
});

// ---- email (against in-process IMAP and SMTP servers) -------------------------
let imap;
let smtp;
let mail;
before(async () => {
  imap = await startImap();
  smtp = await startSmtp();
  mail = new EmailService({
    address: 'testuser@example.com',
    password: 'testpass',
    fromName: 'Sam',
    imap: { host: '127.0.0.1', port: imap.port, secure: false },
    smtp: { host: '127.0.0.1', port: smtp.port, secure: false },
  });
});
after(async () => {
  await imap.close();
  await smtp.close();
});

test('email: lists unread mail newest first with snippets and attachment names', async () => {
  const unread = await mail.list({ sinceDays: 3650 });
  assert.deepEqual(unread.map((m) => m.id), ['3', '2']);
  assert.equal(unread[0].from, 'Raj <raj@example.net>');
  assert.deepEqual(unread[0].attachments, ['q3-report.pdf']);
  assert.equal(unread[1].subject, 'Café offer', 'encoded subject is decoded');
  assert.equal(unread[1].snippet, 'CAFÉ DEALS Half price today only.', 'HTML and latin-1 are decoded, scripts dropped');
  const all = await mail.list({ unreadOnly: false, sinceDays: 3650 });
  assert.deepEqual(all.map((m) => [m.id, m.unread]), [['3', true], ['2', true], ['1', false]]);
});

test('email: reading a message does not mark it as read', async () => {
  const m = await mail.read('3');
  assert.equal(m.text, 'Please find the quarterly report attached.');
  assert.deepEqual(m.attachments, ['q3-report.pdf']);
  assert.equal(m.unread, true);
  assert.deepEqual((await mail.list({ sinceDays: 3650 })).map((x) => x.id), ['3', '2']);
});

test('email: search, missing ids and new-mail detection', async () => {
  assert.deepEqual((await mail.search({ query: 'lunch' })).map((m) => m.subject), ['Lunch on Friday?']);
  await assert.rejects(mail.read('99'), /No email with id 99/);
  await assert.rejects(mail.read('abc'), /not a valid email id/);
  assert.equal(await mail.latestUid(), 3);
  const fresh = await mail.newSince(2);
  assert.deepEqual(fresh.messages.map((m) => m.id), ['3']);
  assert.equal((await mail.newSince(3)).messages.length, 0, 'nothing newer than the newest');
});

test('email: a reply is threaded, quoted and delivered over SMTP', async () => {
  const original = await mail.read('1');
  const reply = buildReply(original, { replyAll: true, selfAddress: 'testuser@example.com' });
  assert.equal(reply.to, 'Anna Lind <anna@example.org>');
  assert.equal(reply.cc, 'Bo <bo@example.org>', 'reply-all keeps others, drops me');
  assert.equal(reply.subject, 'Re: Lunch on Friday?');

  const sent = await mail.send({ ...reply, text: 'Friday works.' });
  assert.deepEqual(sent.accepted, ['anna@example.org', 'bo@example.org']);
  const { raw, from } = smtp.received.at(-1);
  assert.equal(from, 'testuser@example.com');
  assert.match(raw, /^From: Sam <testuser@example\.com>/m);
  assert.match(raw, /^In-Reply-To: <m1@example\.org>/m);
  assert.match(raw, /^References: <m0@example\.org> <m1@example\.org>/m);
  assert.match(raw, /Friday works\.\r\n\r\nOn Mon, 09 Nov 2026 10:00:00 GMT, Anna Lind <anna@example\.org> wrote:\r\n> Hi Sam,/);
});

test('email: reply helpers handle awkward names and bare messages', () => {
  const r = buildReply({ from: [{ name: 'Doe, John', address: 'j@x.org' }], subject: 'RE: hi', text: '' });
  assert.equal(r.to, '"Doe, John" <j@x.org>');
  assert.equal(r.subject, 'RE: hi');
  assert.equal(r.quote, '');
  assert.equal(composeBody({ text: ' Hello ', quote: '' }), 'Hello\n');
  assert.throws(() => buildReply({ from: [] }), /no sender address/);
});

test('email: login check passes with good credentials and fails with bad ones', async () => {
  await mail.check();
  const bad = new EmailService({ address: 'testuser@example.com', password: 'wrong', imap: { host: '127.0.0.1', port: imap.port, secure: false }, smtp: { host: '127.0.0.1', port: smtp.port, secure: false } });
  await assert.rejects(bad.check());
});

// ---- web ----------------------------------------------------------------------
const DDG_HTML = `
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fa%3Fx%3D1&amp;rut=abc">First &amp; <b>best</b></a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fa">Snippet <b>one</b> here</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="https://example.net/b">Second</a>
  <a class="result__snippet" href="https://example.net/b">Snippet two</a>
</div>`;

test('web: DuckDuckGo result pages are parsed and unwrapped', () => {
  assert.deepEqual(parseDuckDuckGo(DDG_HTML), [
    { title: 'First & best', url: 'https://example.org/a?x=1', snippet: 'Snippet one here' },
    { title: 'Second', url: 'https://example.net/b', snippet: 'Snippet two' },
  ]);
  assert.deepEqual(parseDuckDuckGo('<html>captcha</html>'), []);
});

test('web: search uses the configured engine', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), init });
    return String(url).includes('brave')
      ? Response.json({ web: { results: [{ title: 'B <strong>hit</strong>', url: 'https://b.example', description: 'desc' }] } })
      : new Response(DDG_HTML);
  };
  const ddg = new WebService({ search: 'auto', braveKey: '' }, { fetchImpl });
  assert.equal(ddg.searchBackend, 'duckduckgo');
  assert.equal((await ddg.search('cats')).length, 2);
  assert.equal(seen[0].init.body, 'q=cats');

  const brave = new WebService({ search: 'auto', braveKey: 'KEY' }, { fetchImpl });
  assert.equal(brave.searchBackend, 'brave');
  assert.deepEqual(await brave.search('cats'), [{ title: 'B hit', url: 'https://b.example', snippet: 'desc' }]);
  assert.equal(seen[1].init.headers['x-subscription-token'], 'KEY');

  assert.equal(new WebService({ search: 'off' }).searchBackend, '');
  assert.equal(new WebService({ search: 'anthropic' }).searchBackend, '');
  const blocked = new WebService({ search: 'duckduckgo' }, { fetchImpl: async () => new Response('<html>captcha</html>') });
  await assert.rejects(blocked.search('x'), /no parseable results/);
});

test('web: pages are fetched and reduced to readable text', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><head><title>Test &amp; page</title><style>p{}</style></head><body><nav>menu</nav><main><h1>Hello</h1><p>World <a href="/x">link</a></p></main><script>evil()</script></body></html>');
    } else if (req.url === '/redirect') {
      res.writeHead(302, { location: '/page' });
      res.end();
    } else if (req.url === '/pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end('%PDF');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const web = new WebService({ allowPrivateHosts: true });
    const page = await web.read(`${base}/redirect`);
    assert.equal(page.title, 'Test & page');
    assert.equal(page.url, `${base}/page`);
    assert.match(page.text, /HELLO\s+World link/);
    assert.doesNotMatch(page.text, /menu|evil/);
    await assert.rejects(web.read(`${base}/pdf`), /Cannot read this kind of content/);
    await assert.rejects(web.read(`${base}/missing`), /HTTP 404/);

    // Default policy: nothing on this machine or the local network.
    const strict = new WebService({ allowPrivateHosts: false });
    await assert.rejects(strict.read(`${base}/page`), /points at this computer or the local network/);
    await assert.rejects(strict.read('http://192.168.1.1/'), /local network/);
    await assert.rejects(strict.read('http://[::1]/'), /local network/);
    await assert.rejects(strict.read('file:///etc/passwd'), /Only http and https/);
    const rebind = new WebService({ allowPrivateHosts: false }, { lookup: async () => [{ address: '10.0.0.5' }] });
    await assert.rejects(rebind.read('https://innocent.example/'), /local network/);
    // A public page that redirects inward is stopped at the redirect.
    const hop = new WebService({ allowPrivateHosts: false }, {
      lookup: async () => [{ address: '93.184.216.34' }],
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8787/api/drafts' } }),
    });
    await assert.rejects(hop.read('https://public.example/'), /local network/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
