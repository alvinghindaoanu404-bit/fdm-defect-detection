// Local web server: the chat UI (usable from a phone browser) and a small
// JSON API. Plain node:http, no framework.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import QRCode from 'qrcode';
import { ROOT } from './config.js';

const PUBLIC_DIR = path.join(ROOT, 'src', 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};
const MAX_BODY = 200_000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

async function readJson(req) {
  if (!/^application\/json/i.test(req.headers['content-type'] ?? '')) {
    // Also what makes cross-site form posts impossible: browsers cannot send
    // JSON to another origin without a preflight, which we never approve.
    throw new HttpError(415, 'Send JSON (content-type: application/json).');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request too large.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (body === null || typeof body !== 'object') throw new Error('not an object');
    return body;
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function sessionId(prefix, raw) {
  const id = String(raw ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  return `${prefix}-${id || 'default'}`;
}

export function createServer({ cfg, agent, store, services }) {
  const { token, loopbackOnly } = cfg.server;

  function authorize(req, url) {
    const hostname = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    // Bound to this computer only: reject requests that arrive under another
    // name (DNS rebinding from a malicious web page).
    if (loopbackOnly && !LOCAL_HOSTS.has(hostname)) throw new HttpError(403, 'Unexpected Host header.');
    const origin = req.headers.origin;
    if (origin && req.method !== 'GET') {
      let originHost = '';
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        // malformed Origin: treated as a mismatch below
      }
      if (originHost !== (req.headers.host ?? '').toLowerCase()) throw new HttpError(403, 'Cross-site request refused.');
    }
    if (!token) return;
    const header = req.headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : (url.searchParams.get('token') ?? '');
    if (!given || !safeEqual(given, token)) throw new HttpError(401, 'Missing or wrong access token.');
  }

  async function api(req, res, url) {
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /api/status') return json(res, 200, agent.status());

    if (route === 'POST /api/chat') {
      const body = await readJson(req);
      const message = String(body.message ?? '').slice(0, 20_000);
      if (!message.trim()) throw new HttpError(400, 'Empty message.');
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      const send = (event) => res.writable && res.write(`${JSON.stringify(event)}\n`);
      const reply = await agent.handle(sessionId('web', body.session), message, { onEvent: send });
      send({ type: 'done', text: reply.text, error: Boolean(reply.error) });
      return res.end();
    }

    // One-shot question and answer, for Siri Shortcuts and scripts.
    if (route === 'POST /api/ask') {
      const body = await readJson(req);
      const message = String(body.message ?? '').slice(0, 20_000);
      if (!message.trim()) throw new HttpError(400, 'Empty message.');
      const reply = await agent.handle(sessionId('ask', body.session), message);
      return json(res, 200, { text: reply.text });
    }

    if (route === 'GET /api/notifications') {
      const sinceId = Number.parseInt(url.searchParams.get('since') ?? '0', 10) || 0;
      return json(res, 200, { notifications: store.listNotifications({ sinceId, limit: 100 }) });
    }
    if (route === 'POST /api/notifications/read') {
      const body = await readJson(req);
      store.markNotificationsRead(Number.isFinite(body.upTo) ? body.upTo : Infinity);
      return json(res, 200, { ok: true });
    }

    if (route === 'GET /api/drafts') {
      const drafts = store.listDrafts().map(({ id, kind, to, cc, subject, text, createdAt }) => ({ id, kind, to, cc, subject, text, createdAt }));
      return json(res, 200, { drafts });
    }
    const draftRoute = url.pathname.match(/^\/api\/drafts\/([a-z0-9]{1,12})(?:\/(send|discard))?$/);
    if (draftRoute) {
      const [, id, action] = draftRoute;
      try {
        if (req.method === 'POST' && action === 'send') {
          await readJson(req);
          const sent = await agent.sendDraft(id);
          return json(res, 200, { ok: true, to: sent.to, subject: sent.subject });
        }
        if (req.method === 'POST' && action === 'discard') {
          await readJson(req);
          agent.discardDraft(id);
          return json(res, 200, { ok: true });
        }
        if (req.method === 'PUT' && !action) {
          const body = await readJson(req);
          if (!store.getDraft(id)) throw new Error(`There is no pending draft "${id}".`);
          const text = String(body.text ?? '').trim();
          if (!text) throw new Error('A draft cannot be empty.');
          store.updateDraft(id, { text: text.slice(0, 50_000) });
          return json(res, 200, { ok: true });
        }
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, err.message);
      }
    }

    if (route === 'GET /api/whatsapp/qr') {
      const wa = services.whatsapp;
      const qr = wa?.qr ? await QRCode.toDataURL(wa.qr, { margin: 1, width: 300 }) : null;
      return json(res, 200, { status: wa?.status ?? 'disabled', detail: wa?.detail ?? '', qr });
    }

    throw new HttpError(404, 'Not found.');
  }

  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://local');
      if (url.pathname.startsWith('/api/')) {
        authorize(req, url);
        return await api(req, res, url);
      }
      const entry = STATIC[url.pathname];
      if (!entry || req.method !== 'GET') throw new HttpError(404, 'Not found.');
      res.writeHead(200, {
        'content-type': entry[1],
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
      });
      fs.createReadStream(path.join(PUBLIC_DIR, entry[0])).pipe(res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(`[server] ${err.stack ?? err.message}`);
      if (res.headersSent) return res.end(`${JSON.stringify({ type: 'done', text: 'Something went wrong on the server.', error: true })}\n`);
      if (!req.complete) {
        // We are answering before reading the whole request (e.g. it was too
        // large). Discard the rest and do not reuse this connection.
        res.setHeader('connection', 'close');
        req.resume();
      }
      json(res, status, { error: status === 500 ? 'Internal error.' : err.message });
    }
  });
}
