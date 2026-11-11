// Email over IMAP (read) and SMTP (send). Works with any provider that still
// offers IMAP with an app password: Gmail, iCloud, Yahoo, Fastmail, most
// self-hosted mail. Reading never changes the read/unread state of a message.
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { htmlToText } from 'html-to-text';

const SNIPPET_BYTES = 3000;
const BODY_BYTES = 400_000;
const BODY_CHARS = 12_000;

function formatAddress(a) {
  if (!a?.address) return '';
  if (!a.name) return a.address;
  // Quote display names with special characters ("Doe, John") so the mailer
  // cannot mistake one recipient for two.
  const name = /[,;<>@"()\\]/.test(a.name) ? `"${a.name.replace(/["\\]/g, '\\$&')}"` : a.name;
  return `${name} <${a.address}>`;
}

function collapse(text) {
  return text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function toPlainText(content, isHtml) {
  if (!isHtml) return collapse(content);
  return collapse(
    htmlToText(content, {
      wordwrap: false,
      selectors: [
        { selector: 'img', format: 'skip' },
        { selector: 'style', format: 'skip' },
        { selector: 'script', format: 'skip' },
        { selector: 'a', options: { ignoreHref: true } },
      ],
    }),
  );
}

/** Walk an IMAP BODYSTRUCTURE and pick the readable part plus attachment names. */
export function findParts(node, acc = { text: null, html: null, attachments: [] }) {
  if (!node) return acc;
  if (node.childNodes?.length) {
    for (const child of node.childNodes) findParts(child, acc);
    return acc;
  }
  const type = (node.type || '').toLowerCase();
  const filename = node.dispositionParameters?.filename || node.parameters?.name || '';
  const isAttachment = (node.disposition || '').toLowerCase() === 'attachment' || (filename && !type.startsWith('text/'));
  if (isAttachment) {
    acc.attachments.push(filename || type);
  } else if (type === 'text/plain' && !acc.text) {
    acc.text = node.part || '1';
  } else if (type === 'text/html' && !acc.html) {
    acc.html = node.part || '1';
  }
  return acc;
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function parseReferences(headersBuffer) {
  if (!headersBuffer) return [];
  const unfolded = headersBuffer.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
  const match = unfolded.match(/^references:(.*)$/im);
  return match ? match[1].match(/<[^<>\s]+>/g) ?? [] : [];
}

/** Build the headers and quoted body for a reply. Pure function; easy to test. */
export function buildReply(original, { replyAll = false, selfAddress = '' } = {}) {
  const self = selfAddress.toLowerCase();
  const sender = original.replyTo?.[0] ?? original.from?.[0];
  if (!sender?.address) throw new Error('The original message has no sender address to reply to.');

  const seen = new Set([self, sender.address.toLowerCase()]);
  const cc = [];
  if (replyAll) {
    for (const a of [...(original.to ?? []), ...(original.cc ?? [])]) {
      const key = a.address?.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      cc.push(formatAddress(a));
    }
  }

  const subject = original.subject || '(no subject)';
  const when = original.date ? new Date(original.date).toUTCString() : 'an earlier date';
  const quoted = original.text
    ? original.text
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
    : '';

  return {
    to: formatAddress(sender),
    cc: cc.join(', '),
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    inReplyTo: original.messageId || undefined,
    references: [...(original.references ?? []), original.messageId].filter(Boolean),
    // Kept separate from the new text so the user can edit their reply
    // without touching the quoted original.
    quote: quoted ? `On ${when}, ${formatAddress(sender)} wrote:\n${quoted}\n` : '',
  };
}

/** Final message text for a stored draft: the new text, then any quoted original. */
export function composeBody(draft) {
  const text = String(draft.text ?? '').trim();
  return draft.quote ? `${text}\n\n${draft.quote}` : `${text}\n`;
}

export class EmailService {
  constructor(cfg) {
    this.cfg = cfg;
  }

  async #withInbox(fn) {
    const { imap, address, password } = this.cfg;
    const client = new ImapFlow({
      host: imap.host,
      port: imap.port,
      secure: imap.secure,
      auth: { user: address, pass: password },
      tls: imap.tls,
      logger: false,
    });
    // imapflow emits 'error' on dropped sockets; without a listener Node would crash.
    client.on('error', () => {});
    await client.connect();
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async #downloadText(client, uid, bodyStructure, maxBytes) {
    const parts = findParts(bodyStructure);
    const part = parts.text ?? parts.html;
    if (!part) return { text: '', attachments: parts.attachments };
    const { content } = await client.download(String(uid), part, { uid: true, maxBytes });
    const raw = content ? await streamToString(content) : '';
    return { text: toPlainText(raw, !parts.text), attachments: parts.attachments };
  }

  async #summaries(client, uids) {
    if (!uids.length) return [];
    // Collect first: no other IMAP command may run while a FETCH is streaming.
    const messages = await client.fetchAll(uids, { uid: true, envelope: true, flags: true, bodyStructure: true }, { uid: true });
    messages.sort((a, b) => b.uid - a.uid);
    const out = [];
    for (const m of messages) {
      let snippet = '';
      let attachments = [];
      try {
        const body = await this.#downloadText(client, m.uid, m.bodyStructure, SNIPPET_BYTES);
        snippet = body.text.replace(/\s+/g, ' ').slice(0, 240);
        attachments = body.attachments;
      } catch {
        // A snippet is a nicety; the envelope is still useful without it.
      }
      out.push({
        id: String(m.uid),
        from: formatAddress(m.envelope?.from?.[0]),
        subject: m.envelope?.subject || '(no subject)',
        date: m.envelope?.date ? new Date(m.envelope.date).toISOString() : null,
        unread: !m.flags?.has('\\Seen'),
        snippet,
        ...(attachments.length ? { attachments } : {}),
      });
    }
    return out;
  }

  #isGmail(client) {
    return client.capabilities?.has('X-GM-EXT-1');
  }

  /** Newest first. On Gmail, promotions/social tabs are skipped unless `allCategories`. */
  async list({ unreadOnly = true, limit = 10, sinceDays = 14, allCategories = false } = {}) {
    return this.#withInbox(async (client) => {
      let query;
      if (this.#isGmail(client)) {
        const terms = ['in:inbox', `newer_than:${sinceDays}d`];
        if (unreadOnly) terms.push('is:unread');
        if (!allCategories) terms.push('category:primary');
        query = { gmraw: terms.join(' ') };
      } else {
        query = { since: new Date(Date.now() - sinceDays * 86_400_000) };
        if (unreadOnly) query.seen = false;
      }
      const uids = (await client.search(query, { uid: true })) || [];
      return this.#summaries(client, uids.slice(-limit));
    });
  }

  /** Free-text search of the inbox. On Gmail the query uses Gmail's search syntax. */
  async search({ query, limit = 10 }) {
    return this.#withInbox(async (client) => {
      const criteria = this.#isGmail(client)
        ? { gmraw: `in:inbox ${query}` }
        : { or: [{ subject: query }, { from: query }, { body: query }] };
      const uids = (await client.search(criteria, { uid: true })) || [];
      return this.#summaries(client, uids.slice(-limit));
    });
  }

  /** Highest UID in the inbox, used by the watcher to spot new mail. */
  async latestUid() {
    return this.#withInbox(async (client) => Math.max(0, (client.mailbox?.uidNext ?? 1) - 1));
  }

  /** Unread messages that arrived after `afterUid`. */
  async newSince(afterUid, limit = 10) {
    return this.#withInbox(async (client) => {
      const query = this.#isGmail(client)
        ? { gmraw: 'in:inbox is:unread category:primary', uid: `${afterUid + 1}:*` }
        : { seen: false, uid: `${afterUid + 1}:*` };
      // "n:*" always matches the last message, even when its UID is below n.
      const uids = ((await client.search(query, { uid: true })) || []).filter((u) => u > afterUid);
      const latest = Math.max(0, (client.mailbox?.uidNext ?? 1) - 1);
      return { latest, messages: await this.#summaries(client, uids.slice(-limit)), total: uids.length };
    });
  }

  /** Full message: headers we need for replying plus the readable body. */
  async read(id) {
    const uid = Number.parseInt(id, 10);
    if (!Number.isInteger(uid) || uid <= 0) throw new Error(`"${id}" is not a valid email id.`);
    return this.#withInbox(async (client) => {
      const m = await client.fetchOne(
        String(uid),
        { uid: true, envelope: true, flags: true, bodyStructure: true, headers: ['references'] },
        { uid: true },
      );
      if (!m) throw new Error(`No email with id ${id} in the inbox (it may have been moved or deleted).`);
      const body = await this.#downloadText(client, uid, m.bodyStructure, BODY_BYTES);
      const truncated = body.text.length > BODY_CHARS;
      const env = m.envelope ?? {};
      return {
        id: String(uid),
        from: (env.from ?? []).map((a) => ({ name: a.name || '', address: a.address || '' })),
        replyTo: (env.replyTo ?? []).map((a) => ({ name: a.name || '', address: a.address || '' })),
        to: (env.to ?? []).map((a) => ({ name: a.name || '', address: a.address || '' })),
        cc: (env.cc ?? []).map((a) => ({ name: a.name || '', address: a.address || '' })),
        subject: env.subject || '(no subject)',
        date: env.date ? new Date(env.date).toISOString() : null,
        messageId: env.messageId || null,
        references: parseReferences(m.headers),
        unread: !m.flags?.has('\\Seen'),
        attachments: body.attachments,
        text: truncated ? `${body.text.slice(0, BODY_CHARS)}\n[... message truncated ...]` : body.text,
      };
    });
  }

  /** Sends a stored draft. Called only after a human approved it (or in auto mode). */
  async send(draft) {
    const { smtp, address, password, fromName } = this.cfg;
    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: address, pass: password },
      tls: smtp.tls,
    });
    try {
      const info = await transport.sendMail({
        from: fromName ? { name: fromName, address } : address,
        to: draft.to,
        cc: draft.cc || undefined,
        subject: draft.subject,
        text: composeBody(draft),
        inReplyTo: draft.inReplyTo || undefined,
        references: draft.references?.length ? draft.references : undefined,
      });
      return { messageId: info.messageId, accepted: info.accepted ?? [] };
    } finally {
      transport.close();
    }
  }

  /** Used by `jarvis doctor`. */
  async check() {
    await this.#withInbox(async () => {});
    const { smtp, address, password } = this.cfg;
    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: address, pass: password },
      tls: smtp.tls,
    });
    try {
      await transport.verify();
    } finally {
      transport.close();
    }
  }
}
