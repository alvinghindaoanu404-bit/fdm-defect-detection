// Internet access: web search and page reading, run from this computer.
import dns from 'node:dns/promises';
import net from 'node:net';
import { htmlToText } from 'html-to-text';

const USER_AGENT = 'Mozilla/5.0 (compatible; personal-assistant/0.1)';
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/** Parse the result page of html.duckduckgo.com. Exported for tests. */
export function parseDuckDuckGo(html, limit = 6) {
  const results = [];
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/g;
  const snippets = [...html.matchAll(snippetRe)].map((m) => stripTags(m[1]));
  let i = 0;
  for (const m of html.matchAll(linkRe)) {
    let url = decodeEntities(m[1]);
    if (url.startsWith('//')) url = `https:${url}`;
    try {
      // DuckDuckGo wraps targets as /l/?uddg=<encoded url>
      const wrapped = new URL(url).searchParams.get('uddg');
      if (wrapped) url = wrapped;
    } catch {
      continue;
    }
    const snippet = snippets[i++] ?? '';
    if (/duckduckgo\.com\/y\.js/.test(url)) continue; // sponsored result
    results.push({ title: stripTags(m[2]), url, snippet });
    if (results.length >= limit) break;
  }
  return results;
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || v6.startsWith('ff');
}

export class WebService {
  constructor(cfg, { fetchImpl = fetch, lookup = dns.lookup } = {}) {
    this.cfg = cfg;
    this.lookup = lookup;
    // Node reports every network failure as "fetch failed"; say what failed.
    this.fetch = async (url, init) => {
      try {
        return await fetchImpl(url, init);
      } catch (err) {
        const host = new URL(url).hostname;
        const why = err.name === 'TimeoutError' ? 'it took too long to answer' : (err.cause?.code ?? err.cause?.message ?? err.message);
        throw new Error(`Could not reach ${host} (${why}). Check the internet connection.`);
      }
    };
  }

  /** Which client-side search engine to use ('' when search is off or handled by Claude). */
  get searchBackend() {
    const { search, braveKey } = this.cfg;
    if (search === 'brave' || (search === 'auto' && braveKey)) return 'brave';
    if (search === 'duckduckgo' || search === 'auto') return 'duckduckgo';
    return '';
  }

  async search(query, limit = 6) {
    return this.searchBackend === 'brave' ? this.#brave(query, limit) : this.#duckduckgo(query, limit);
  }

  async #duckduckgo(query, limit) {
    const res = await this.fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: { 'user-agent': USER_AGENT, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ q: query }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`DuckDuckGo answered HTTP ${res.status}`);
    const results = parseDuckDuckGo(await res.text(), limit);
    if (!results.length) {
      throw new Error('DuckDuckGo returned no parseable results (it may be rate-limiting this computer). Set BRAVE_API_KEY for a more reliable search.');
    }
    return results;
  }

  async #brave(query, limit) {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(limit));
    const res = await this.fetch(url, {
      headers: { accept: 'application/json', 'x-subscription-token': this.cfg.braveKey },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Brave Search answered HTTP ${res.status}`);
    const data = await res.json();
    return (data.web?.results ?? []).slice(0, limit).map((r) => ({ title: stripTags(r.title ?? ''), url: r.url, snippet: stripTags(r.description ?? '') }));
  }

  async #assertPublic(url) {
    if (!/^https?:$/.test(url.protocol)) throw new Error('Only http and https links can be opened.');
    if (this.cfg.allowPrivateHosts) return;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = net.isIP(host) ? [{ address: host }] : await this.lookup(host, { all: true });
    if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
      // A page or email could otherwise trick the assistant into poking at
      // routers, NAS boxes or Jarvis's own API on the home network.
      throw new Error(`Refusing to open ${url.hostname}: it points at this computer or the local network.`);
    }
  }

  /** Download a page and return its readable text. */
  async read(rawUrl, maxChars = 12_000) {
    let url = new URL(rawUrl);
    let res;
    for (let hop = 0; ; hop++) {
      await this.#assertPublic(url);
      res = await this.fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' },
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const location = res.headers.get('location');
      if (res.status < 300 || res.status >= 400 || !location) break;
      if (hop >= MAX_REDIRECTS) throw new Error('Too many redirects.');
      url = new URL(location, url);
    }
    if (!res.ok) throw new Error(`The site answered HTTP ${res.status}.`);

    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    if (type && !/text\/|json|xml/.test(type)) {
      throw new Error(`Cannot read this kind of content (${type.split(';')[0]}). Only web pages and text are supported.`);
    }

    // Read at most MAX_BYTES so a huge download cannot exhaust memory.
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body ?? []) {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= MAX_BYTES) break;
    }
    const raw = Buffer.concat(chunks).toString('utf8');

    let title = '';
    let text = raw;
    if (type.includes('html') || /^\s*<(!doctype|html)/i.test(raw)) {
      title = stripTags(raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
      text = htmlToText(raw, {
        wordwrap: false,
        baseElements: { selectors: ['main', 'article', 'body'], returnDomByDefault: true },
        selectors: [
          { selector: 'img', format: 'skip' },
          { selector: 'nav', format: 'skip' },
          { selector: 'footer', format: 'skip' },
          { selector: 'script', format: 'skip' },
          { selector: 'style', format: 'skip' },
          { selector: 'a', options: { ignoreHref: true } },
        ],
      });
    }
    text = text.replace(/\n{3,}/g, '\n\n').trim();
    const truncated = text.length > maxChars;
    return { url: url.toString(), title, text: truncated ? `${text.slice(0, maxChars)}\n[... page truncated ...]` : text };
  }
}
