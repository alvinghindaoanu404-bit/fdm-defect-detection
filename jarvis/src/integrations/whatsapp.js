// WhatsApp, through the unofficial Baileys library: Jarvis links to your
// account as a "linked device" (like WhatsApp Web) by scanning a QR code.
//
// What it does:
//   * records incoming messages that arrive while Jarvis is running, so the
//     assistant can summarise them;
//   * lets you talk to Jarvis from your phone via the "Message yourself" chat;
//   * sends alerts and briefings to that same chat.
//
// What it deliberately does not do: message anyone but you, or mark your chats
// as read. WhatsApp does not offer an official API for personal accounts, so
// this is against their terms of service and carries a risk of the account
// being restricted. It is off unless WHATSAPP_ENABLED=true.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

export const BOT_PREFIX = '*Jarvis:* ';
const MAX_SELF_RUNS_PER_MINUTE = 10;

const quietLogger = {
  level: 'silent',
  child() {
    return quietLogger;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
};

/** Strip the device part: "4479...:12@s.whatsapp.net" -> "4479...@s.whatsapp.net". */
export function bareJid(jid) {
  if (!jid) return '';
  const [user, server] = String(jid).split('@');
  return `${user.split(':')[0]}@${server ?? ''}`;
}

/** Text of a WhatsApp message, or a short label for media. */
export function messageText(message) {
  let m = message;
  // Disappearing and view-once messages wrap the real content.
  for (let i = 0; i < 4 && m; i++) {
    const inner = m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message ?? m.documentWithCaptionMessage?.message;
    if (!inner) break;
    m = inner;
  }
  if (!m) return '';
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage) return m.imageMessage.caption ? `[photo] ${m.imageMessage.caption}` : '[photo]';
  if (m.videoMessage) return m.videoMessage.caption ? `[video] ${m.videoMessage.caption}` : '[video]';
  if (m.documentMessage) return `[document] ${m.documentMessage.caption || m.documentMessage.fileName || ''}`.trim();
  if (m.audioMessage) return m.audioMessage.ptt ? '[voice note]' : '[audio]';
  if (m.stickerMessage) return '[sticker]';
  if (m.locationMessage || m.liveLocationMessage) return '[location]';
  if (m.contactMessage || m.contactsArrayMessage) return '[contact card]';
  if (m.pollCreationMessage || m.pollCreationMessageV3) return `[poll] ${(m.pollCreationMessage ?? m.pollCreationMessageV3).name ?? ''}`.trim();
  return '';
}

export class WhatsAppService extends EventEmitter {
  /**
   * @param {object} cfg       config.whatsapp
   * @param {import('../store.js').Store} store
   * @param {object} [deps]    { loadBaileys } is injectable for tests
   */
  constructor(cfg, store, { loadBaileys = () => import('baileys'), authDir } = {}) {
    super();
    this.cfg = cfg;
    this.store = store;
    this.loadBaileys = loadBaileys;
    this.authDir = authDir ?? path.join(store.dir, 'whatsapp-auth');
    this.status = cfg.enabled ? 'starting' : 'disabled';
    this.detail = '';
    this.qr = null;
    this.sock = null;
    this.selfJids = new Set();
    this.sentIds = new Set();
    this.groupNames = new Map();
    this.selfRuns = [];
    this.queue = Promise.resolve();
    this.stopped = false;
    this.retryDelay = 2000;
  }

  #setStatus(status, detail = '') {
    this.status = status;
    this.detail = detail;
    this.emit('status', status);
  }

  async start() {
    if (!this.cfg.enabled) return;
    this.stopped = false;
    let baileys;
    try {
      baileys = await this.loadBaileys();
    } catch (err) {
      this.#setStatus('unavailable', `The WhatsApp library is not installed (${err.code ?? err.message}). Run "npm install" again.`);
      return;
    }
    await this.#connect(baileys);
  }

  async #connect(baileys) {
    const makeWASocket = baileys.default ?? baileys.makeWASocket;
    const { useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = baileys;

    fs.mkdirSync(this.authDir, { recursive: true, mode: 0o700 });
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

    // WhatsApp rejects connections that announce an outdated web version.
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      version = undefined;
    }

    const sock = makeWASocket({
      auth: state,
      ...(version ? { version } : {}),
      logger: quietLogger,
      browser: Browsers?.macOS ? Browsers.macOS('Desktop') : undefined,
      // Keep phone notifications working: do not appear "online" on this device.
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        this.qr = qr;
        this.#setStatus('qr', 'Scan the QR code with WhatsApp > Linked devices > Link a device.');
        this.emit('qr', qr);
      }
      if (connection === 'open') {
        this.qr = null;
        this.retryDelay = 2000;
        this.selfJids = new Set([bareJid(sock.user?.id), bareJid(sock.user?.lid)].filter((j) => j && j !== '@'));
        this.#setStatus('connected');
      } else if (connection === 'close') {
        this.sock = null;
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason?.loggedOut) {
          // The device was unlinked from the phone: forget the session so the
          // next start shows a fresh QR code.
          fs.rmSync(this.authDir, { recursive: true, force: true });
          this.#setStatus('logged_out', 'This device was unlinked. Restart Jarvis to link again.');
          return;
        }
        if (this.stopped) return;
        this.#setStatus('reconnecting', `Connection closed (${code ?? 'unknown'}).`);
        const delay = this.retryDelay;
        this.retryDelay = Math.min(this.retryDelay * 2, 60_000);
        this.retryTimer = setTimeout(() => {
          this.#connect(baileys).catch((err) => this.#setStatus('reconnecting', err.message));
        }, delay);
        this.retryTimer.unref?.();
      }
    });

    sock.ev.on('messages.upsert', (event) => {
      // 'notify' = live messages. 'append' is history and our own echoes.
      if (event.type !== 'notify') return;
      // One at a time, so messages are stored in the order they arrived even
      // when one of them needs a group-name lookup.
      this.queue = this.queue.then(async () => {
        for (const msg of event.messages ?? []) {
          await this.#onMessage(msg).catch((err) => console.warn(`[whatsapp] could not process a message: ${err.message}`));
        }
      });
    });
  }

  #isSelfChat(key) {
    return this.selfJids.has(bareJid(key.remoteJid)) || this.selfJids.has(bareJid(key.remoteJidAlt));
  }

  async #chatName(key, pushName) {
    const jid = key.remoteJid ?? '';
    if (jid.endsWith('@g.us')) {
      if (!this.groupNames.has(jid)) {
        try {
          const meta = await this.sock?.groupMetadata(jid);
          this.groupNames.set(jid, meta?.subject || 'Group');
        } catch {
          this.groupNames.set(jid, 'Group');
        }
      }
      return this.groupNames.get(jid);
    }
    if (pushName) return pushName;
    // Prefer a phone number over WhatsApp's anonymous "@lid" identifiers.
    const pn = [key.remoteJidAlt, jid].find((j) => j?.endsWith('@s.whatsapp.net'));
    return pn ? `+${bareJid(pn).split('@')[0]}` : 'Unknown contact';
  }

  async #onMessage(msg) {
    const key = msg.key ?? {};
    const jid = key.remoteJid ?? '';
    if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return;

    const text = messageText(msg.message).trim();
    if (!text) return; // reactions, receipts, protocol messages

    if (key.fromMe) {
      // Something I sent. Only the "Message yourself" chat is a command channel.
      if (!this.cfg.selfChat || !this.#isSelfChat(key)) return;
      if (this.sentIds.has(key.id) || text.startsWith(BOT_PREFIX.trim())) return; // Jarvis's own output
      const now = Date.now();
      this.selfRuns = this.selfRuns.filter((t) => now - t < 60_000);
      if (this.selfRuns.length >= MAX_SELF_RUNS_PER_MINUTE) {
        console.warn('[whatsapp] too many self-chat messages in a minute; ignoring to avoid a loop');
        return;
      }
      this.selfRuns.push(now);
      this.emit('self-message', { text, id: key.id });
      return;
    }

    const isGroup = jid.endsWith('@g.us');
    const record = {
      id: key.id,
      chat: await this.#chatName(key, isGroup ? '' : msg.pushName),
      sender: msg.pushName || (isGroup ? 'Someone' : ''),
      isGroup,
      text: text.slice(0, 2000),
      timestamp: Number(msg.messageTimestamp ?? 0) * 1000 || Date.now(),
    };
    if (this.store.addWhatsAppMessage(record)) this.emit('message', record);
  }

  /** Send a message to your own "Message yourself" chat. The only send path. */
  async sendToSelf(text) {
    if (this.status !== 'connected' || !this.sock) return false;
    const target = [...this.selfJids].find((j) => j.endsWith('@s.whatsapp.net')) ?? [...this.selfJids][0];
    if (!target) return false;
    const body = `${BOT_PREFIX}${text}`.slice(0, 60_000);
    const sent = await this.sock.sendMessage(target, { text: body });
    if (sent?.key?.id) {
      this.sentIds.add(sent.key.id);
      if (this.sentIds.size > 500) this.sentIds.delete(this.sentIds.values().next().value);
    }
    return true;
  }

  recent({ sinceHours = 24, chat = '', limit = 60 } = {}) {
    return this.store.listWhatsAppMessages({ sinceMs: Date.now() - sinceHours * 3_600_000, chat, limit });
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    try {
      this.sock?.end?.(undefined);
    } catch {
      // already closed
    }
    this.sock = null;
  }
}
