// Tiny JSON-file store. Personal-scale data (a few drafts, a few hundred
// notifications/messages) does not need a database, and plain files are easy
// to inspect or delete.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_NOTIFICATIONS = 300;
const MAX_WHATSAPP_MESSAGES = 800;

export class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.cache = new Map();
  }

  read(name, fallback) {
    if (this.cache.has(name)) return this.cache.get(name);
    let value = fallback;
    try {
      value = JSON.parse(fs.readFileSync(path.join(this.dir, `${name}.json`), 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[store] ${name}.json unreadable, starting fresh: ${err.message}`);
    }
    this.cache.set(name, value);
    return value;
  }

  write(name, value) {
    this.cache.set(name, value);
    const file = path.join(this.dir, `${name}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  // --- key/value state ---------------------------------------------------
  getState(key, fallback) {
    const state = this.read('state', {});
    return key in state ? state[key] : fallback;
  }

  setState(key, value) {
    const state = this.read('state', {});
    state[key] = value;
    this.write('state', state);
  }

  // --- email drafts awaiting approval ------------------------------------
  listDrafts() {
    return this.read('drafts', []).filter((d) => d.status === 'pending');
  }

  getDraft(id) {
    return this.read('drafts', []).find((d) => d.id === String(id).toLowerCase() && d.status === 'pending');
  }

  addDraft(draft) {
    const drafts = this.read('drafts', []);
    let id;
    do id = crypto.randomBytes(3).toString('hex').slice(0, 4);
    while (drafts.some((d) => d.id === id));
    const saved = { id, status: 'pending', createdAt: new Date().toISOString(), ...draft };
    drafts.push(saved);
    // Keep the file from growing forever: drop old, already-handled drafts.
    const handled = drafts.filter((d) => d.status !== 'pending');
    const trimmed = handled.length > 50 ? drafts.filter((d) => d.status === 'pending' || handled.indexOf(d) >= handled.length - 50) : drafts;
    this.write('drafts', trimmed);
    return saved;
  }

  updateDraft(id, patch) {
    const drafts = this.read('drafts', []);
    const draft = drafts.find((d) => d.id === String(id).toLowerCase());
    if (!draft) return null;
    Object.assign(draft, patch);
    this.write('drafts', drafts);
    return draft;
  }

  // --- notifications -----------------------------------------------------
  /** Adds a notification. `key` de-duplicates (same key is only stored once). */
  addNotification({ kind, title, body = '', key = null }) {
    const items = this.read('notifications', []);
    if (key && items.some((n) => n.key === key)) return null;
    const seq = this.getState('notificationSeq', 0) + 1;
    this.setState('notificationSeq', seq);
    const item = { id: seq, kind, title, body, key, at: new Date().toISOString(), read: false };
    items.push(item);
    this.write('notifications', items.slice(-MAX_NOTIFICATIONS));
    return item;
  }

  listNotifications({ sinceId = 0, unreadOnly = false, limit = 50 } = {}) {
    return this.read('notifications', [])
      .filter((n) => n.id > sinceId && (!unreadOnly || !n.read))
      .slice(-limit);
  }

  markNotificationsRead(upToId = Infinity) {
    const items = this.read('notifications', []);
    let changed = false;
    for (const n of items) {
      if (!n.read && n.id <= upToId) {
        n.read = true;
        changed = true;
      }
    }
    if (changed) this.write('notifications', items);
  }

  // --- WhatsApp messages seen while Jarvis was running --------------------
  addWhatsAppMessage(message) {
    const items = this.read('whatsapp-messages', []);
    if (items.some((m) => m.id === message.id)) return false;
    items.push(message);
    this.write('whatsapp-messages', items.slice(-MAX_WHATSAPP_MESSAGES));
    return true;
  }

  listWhatsAppMessages({ sinceMs = 0, chat = '', limit = 60 } = {}) {
    const needle = chat.trim().toLowerCase();
    return this.read('whatsapp-messages', [])
      .filter((m) => m.timestamp >= sinceMs)
      .filter((m) => !needle || m.chat.toLowerCase().includes(needle) || m.sender.toLowerCase().includes(needle))
      .slice(-limit);
  }
}
