import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { BOT_PREFIX, WhatsAppService, bareJid, messageText } from '../src/integrations/whatsapp.js';
import { Store } from '../src/store.js';
import { tmpDir } from './helpers.js';

const ME = '447700900123@s.whatsapp.net';
const ME_LID = '99887766@lid';

/** A stand-in for the Baileys module that lets the test drive socket events. */
function fakeBaileys() {
  const sockets = [];
  const mod = {
    sockets,
    DisconnectReason: { loggedOut: 401 },
    Browsers: { macOS: (name) => ['Mac OS', name, '14'] },
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
    useMultiFileAuthState: async () => ({ state: { creds: {}, keys: {} }, saveCreds: () => {} }),
    default(options) {
      const sock = {
        options,
        ev: new EventEmitter(),
        user: { id: '447700900123:7@s.whatsapp.net', lid: '99887766:7@lid' },
        sent: [],
        async sendMessage(jid, content) {
          const id = `SENT${this.sent.length + 1}`;
          this.sent.push({ jid, content, id });
          return { key: { id, fromMe: true, remoteJid: jid } };
        },
        async groupMetadata(jid) {
          return { id: jid, subject: 'Family' };
        },
        end() {
          this.ended = true;
        },
      };
      sockets.push(sock);
      return sock;
    },
  };
  return mod;
}

async function connected() {
  const baileys = fakeBaileys();
  const store = new Store(tmpDir());
  const wa = new WhatsAppService({ enabled: true, selfChat: true, notify: true }, store, { loadBaileys: async () => baileys });
  await wa.start();
  const sock = baileys.sockets[0];
  sock.ev.emit('connection.update', { connection: 'open' });
  const deliver = async (messages, type = 'notify') => {
    sock.ev.emit('messages.upsert', { type, messages });
    await wa.queue;
  };
  return { wa, sock, store, baileys, deliver };
}

const incoming = (id, remoteJid, text, extra = {}) => ({ key: { id, remoteJid, fromMe: false, ...extra.key }, message: { conversation: text }, pushName: extra.pushName ?? 'Mum', messageTimestamp: 1_800_000_000 });

test('whatsapp: helpers', () => {
  assert.equal(bareJid('447700900123:7@s.whatsapp.net'), ME);
  assert.equal(bareJid(undefined), '');
  assert.equal(messageText({ conversation: 'hi' }), 'hi');
  assert.equal(messageText({ extendedTextMessage: { text: 'link text' } }), 'link text');
  assert.equal(messageText({ ephemeralMessage: { message: { imageMessage: { caption: 'look' } } } }), '[photo] look');
  assert.equal(messageText({ audioMessage: { ptt: true } }), '[voice note]');
  assert.equal(messageText({ reactionMessage: {} }), '');
  assert.equal(messageText(null), '');
});

test('whatsapp: links quietly and does not hijack phone notifications', async () => {
  const { wa, sock } = await connected();
  assert.equal(wa.status, 'connected');
  assert.equal(sock.options.markOnlineOnConnect, false);
  assert.equal(sock.options.syncFullHistory, false);
  assert.deepEqual([...wa.selfJids].sort(), [ME, ME_LID].sort());
});

test('whatsapp: a QR code is surfaced until the phone links', async () => {
  const baileys = fakeBaileys();
  const wa = new WhatsAppService({ enabled: true, selfChat: true }, new Store(tmpDir()), { loadBaileys: async () => baileys });
  const seen = [];
  wa.on('qr', (qr) => seen.push(qr));
  await wa.start();
  baileys.sockets[0].ev.emit('connection.update', { qr: 'QR-DATA' });
  assert.equal(wa.status, 'qr');
  assert.equal(wa.qr, 'QR-DATA');
  assert.deepEqual(seen, ['QR-DATA']);
  baileys.sockets[0].ev.emit('connection.update', { connection: 'open' });
  assert.equal(wa.qr, null);
});

test('whatsapp: incoming messages are stored once, with sensible chat names', async () => {
  const { wa, store, deliver } = await connected();
  const events = [];
  wa.on('message', (m) => events.push(m));
  await deliver([
    incoming('A1', '447700900555@s.whatsapp.net', 'Call me when you can'),
    incoming('A2', '123456789-1111@g.us', 'Dinner at 7?', { pushName: 'Dad', key: { participant: '447700900666@s.whatsapp.net' } }),
    incoming('A3', '5550001@lid', 'new number', { pushName: '', key: { remoteJidAlt: '447700900777@s.whatsapp.net' } }),
    incoming('A1', '447700900555@s.whatsapp.net', 'Call me when you can'), // duplicate delivery
    { key: { id: 'S1', remoteJid: 'status@broadcast', fromMe: false }, message: { conversation: 'status update' } },
    { key: { id: 'R1', remoteJid: '447700900555@s.whatsapp.net', fromMe: false }, message: { reactionMessage: {} } },
  ]);
  await deliver([incoming('H1', '447700900555@s.whatsapp.net', 'old history')], 'append');

  const stored = store.listWhatsAppMessages();
  assert.deepEqual(stored.map((m) => [m.chat, m.sender, m.isGroup, m.text]), [
    ['Mum', 'Mum', false, 'Call me when you can'],
    ['Family', 'Dad', true, 'Dinner at 7?'],
    ['+447700900777', '', false, 'new number'],
  ]);
  assert.equal(events.length, 3);
  assert.equal(wa.recent({ chat: 'fam' }).length, 1);
});

test('whatsapp: only messages I send to myself reach Jarvis, and its own replies never loop', async () => {
  const { wa, sock, store, deliver } = await connected();
  const commands = [];
  wa.on('self-message', (m) => commands.push(m.text));

  await deliver([{ key: { id: 'M1', remoteJid: ME, fromMe: true }, message: { conversation: 'brief me' } }]);
  // Newer WhatsApp accounts address the self-chat by an anonymous "lid".
  await deliver([{ key: { id: 'M2', remoteJid: ME_LID, fromMe: true }, message: { conversation: 'any mail?' } }]);
  // Something I sent to another person is not a command.
  await deliver([{ key: { id: 'M3', remoteJid: '447700900555@s.whatsapp.net', fromMe: true }, message: { conversation: 'on my way' } }]);
  assert.deepEqual(commands, ['brief me', 'any mail?']);

  assert.equal(await wa.sendToSelf('You have two emails.'), true);
  assert.deepEqual(sock.sent[0], { jid: ME, content: { text: `${BOT_PREFIX}You have two emails.` }, id: 'SENT1' });
  // The reply echoes back from WhatsApp: by id, and (e.g. after a restart) by prefix.
  await deliver([{ key: { id: 'SENT1', remoteJid: ME, fromMe: true }, message: { conversation: `${BOT_PREFIX}You have two emails.` } }]);
  await deliver([{ key: { id: 'UNKNOWN', remoteJid: ME, fromMe: true }, message: { conversation: `${BOT_PREFIX}older reply` } }]);
  assert.equal(commands.length, 2, 'no loop');
  assert.equal(store.listWhatsAppMessages().length, 0, 'my own messages are not stored as incoming');

  // Circuit breaker: a burst cannot trigger unlimited (billable) model runs.
  for (let i = 0; i < 30; i++) await deliver([{ key: { id: `B${i}`, remoteJid: ME, fromMe: true }, message: { conversation: `spam ${i}` } }]);
  assert.equal(commands.length, 10);
});

test('whatsapp: self-chat can be switched off; sending needs a connection', async () => {
  const baileys = fakeBaileys();
  const wa = new WhatsAppService({ enabled: true, selfChat: false }, new Store(tmpDir()), { loadBaileys: async () => baileys });
  let commands = 0;
  wa.on('self-message', () => commands++);
  await wa.start();
  assert.equal(await wa.sendToSelf('too early'), false);
  baileys.sockets[0].ev.emit('connection.update', { connection: 'open' });
  baileys.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: 'M1', remoteJid: ME, fromMe: true }, message: { conversation: 'hello' } }] });
  await wa.queue;
  assert.equal(commands, 0);
});

test('whatsapp: being unlinked forgets the session; a dropped connection reconnects', async () => {
  const { wa, sock, baileys } = await connected();
  fs.writeFileSync(path.join(wa.authDir, 'creds.json'), '{}');
  wa.retryDelay = 5;
  sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
  assert.equal(wa.status, 'reconnecting');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(baileys.sockets.length, 2, 'reconnected');

  baileys.sockets[1].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  assert.equal(wa.status, 'logged_out');
  assert.equal(fs.existsSync(wa.authDir), false);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(baileys.sockets.length, 2, 'no reconnect after being unlinked');
  await wa.stop();
});

test('whatsapp: disabled or missing library is reported, not fatal', async () => {
  const off = new WhatsAppService({ enabled: false }, new Store(tmpDir()));
  await off.start();
  assert.equal(off.status, 'disabled');
  const missing = new WhatsAppService({ enabled: true }, new Store(tmpDir()), { loadBaileys: async () => { throw Object.assign(new Error('nope'), { code: 'ERR_MODULE_NOT_FOUND' }); } });
  await missing.start();
  assert.equal(missing.status, 'unavailable');
  assert.match(missing.detail, /npm install/);
});

test('whatsapp: the real library loads and exposes the functions we rely on', async () => {
  const baileys = await import('baileys');
  assert.equal(typeof (baileys.default ?? baileys.makeWASocket), 'function');
  for (const name of ['useMultiFileAuthState', 'fetchLatestBaileysVersion']) assert.equal(typeof baileys[name], 'function', name);
  assert.equal(typeof baileys.DisconnectReason.loggedOut, 'number');
  assert.equal(typeof baileys.Browsers.macOS, 'function');
});
