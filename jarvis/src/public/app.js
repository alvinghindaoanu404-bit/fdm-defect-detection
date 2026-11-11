// Browser side of Jarvis. No framework, no build step.
const $ = (id) => document.getElementById(id);
const chat = $('chat');
const input = $('input');
const orb = $('orb');

const storage = {
  get(key, fallback = '') {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // private browsing: carry on without persistence
    }
  },
};

// The access token can arrive once in the link (#token=...) and is then kept
// on this device.
const hashToken = new URLSearchParams(location.hash.slice(1)).get('token');
if (hashToken) {
  storage.set('jarvis.token', hashToken);
  history.replaceState(null, '', location.pathname);
}

const state = {
  token: storage.get('jarvis.token'),
  session: storage.get('jarvis.session') || newSessionId(),
  busy: false,
  speak: storage.get('jarvis.speak') === '1',
  lastAlertId: 0,
  unread: 0,
};

function newSessionId() {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  storage.set('jarvis.session', id);
  return id;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    askForToken();
    throw new Error('Access token needed.');
  }
  return res;
}

async function apiJson(path, options) {
  const res = await api(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

// ---- tiny, safe Markdown renderer ---------------------------------------
// Everything is escaped first; only a fixed set of tags is produced.
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function inline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,!?;:]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
}

function renderMarkdown(text) {
  const out = [];
  let list = null;
  let para = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (bullet || numbered) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push(inline((bullet ?? numbered)[1]));
    } else if (heading) {
      flushPara();
      flushList();
      out.push(`<h3>${inline(heading[1])}</h3>`);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(inline(line));
    }
  }
  flushPara();
  flushList();
  return out.join('');
}

// ---- conversation ---------------------------------------------------------
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function scrollDown() {
  chat.scrollTop = chat.scrollHeight;
}

function addUserMessage(text) {
  $('welcome')?.remove();
  const row = el('div', 'msg user');
  row.append(el('div', 'bubble', text));
  chat.append(row);
  scrollDown();
}

function addJarvisMessage() {
  $('welcome')?.remove();
  const row = el('div', 'msg jarvis');
  const bubble = el('div', 'bubble');
  const steps = el('div', 'steps');
  const body = el('div', 'body');
  const typing = el('div', 'typing', 'Thinking…');
  bubble.append(steps, body, typing);
  row.append(bubble);
  chat.append(row);
  scrollDown();
  let text = '';
  return {
    step(label, status) {
      let chip = [...steps.children].find((c) => c.dataset.label === label && c.dataset.open === '1');
      if (!chip) {
        chip = el('span', 'step', label);
        chip.dataset.label = label;
        chip.dataset.open = '1';
        steps.append(chip);
      }
      if (status !== 'start') chip.dataset.open = '0';
      if (status === 'error') chip.classList.add('error');
      scrollDown();
    },
    append(delta) {
      text += delta;
      body.innerHTML = renderMarkdown(text);
      scrollDown();
    },
    reset() {
      text = '';
      body.innerHTML = '';
    },
    notice(message) {
      steps.append(el('span', 'step error', message));
    },
    finish(finalText, isError) {
      typing.remove();
      // Streamed text can include interim remarks; the final text is authoritative
      // when nothing was streamed (commands, local models, errors).
      if (!text.trim()) text = finalText;
      else if (isError) text += `\n\n${finalText}`;
      body.innerHTML = renderMarkdown(text);
      if (isError) row.classList.add('error');
      scrollDown();
      return text;
    },
  };
}

const SERVER_TOOL_LABELS = { web_search: 'Searched the web', web_fetch: 'Read a web page' };

async function send(message, shownAs = message) {
  const text = message.trim();
  if (!text || state.busy) return;
  state.busy = true;
  $('btn-send').disabled = true;
  orb.classList.add('busy');
  addUserMessage(shownAs.trim());
  const view = addJarvisMessage();
  let finalText = '';
  let failed = false;

  try {
    const res = await api('/api/chat', { method: 'POST', body: { message: text, session: state.session } });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${res.status}).`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === 'text') view.append(event.delta);
        else if (event.type === 'tool') view.step(event.label ?? SERVER_TOOL_LABELS[event.name] ?? event.name, event.status);
        else if (event.type === 'reset') view.reset();
        else if (event.type === 'notice') view.notice(event.text);
        else if (event.type === 'done') {
          finalText = event.text;
          failed = Boolean(event.error);
        }
      }
    }
  } catch (err) {
    finalText = err.message === 'Failed to fetch' ? 'I cannot reach Jarvis. Is it still running on your computer?' : err.message;
    failed = true;
  }

  const shown = view.finish(finalText || '(No reply.)', failed);
  state.busy = false;
  $('btn-send').disabled = false;
  orb.classList.remove('busy');
  if (state.speak && !failed) speak(shown);
  refreshDrafts();
}

// ---- speech ---------------------------------------------------------------
function speak(text) {
  if (!('speechSynthesis' in window)) return;
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/[*_`#>]/g, '');
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(plain));
}

function setSpeak(on) {
  state.speak = on;
  storage.set('jarvis.speak', on ? '1' : '0');
  $('btn-speak').setAttribute('aria-pressed', String(on));
  if (!on && 'speechSynthesis' in window) speechSynthesis.cancel();
}

$('btn-speak').addEventListener('click', () => {
  setSpeak(!state.speak);
  // iOS only allows speech after a tap; this primes it.
  if (state.speak) speak('Voice on.');
});
setSpeak(state.speak);

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (Recognition && window.isSecureContext) {
  const mic = $('btn-mic');
  mic.hidden = false;
  const recognition = new Recognition();
  recognition.lang = navigator.language || 'en-US';
  recognition.interimResults = false;
  let listening = false;
  recognition.onresult = (e) => {
    const heard = e.results[0]?.[0]?.transcript ?? '';
    if (heard) send(heard);
  };
  recognition.onend = () => {
    listening = false;
    mic.classList.remove('listening');
  };
  recognition.onerror = recognition.onend;
  mic.addEventListener('click', () => {
    if (listening) return recognition.stop();
    try {
      recognition.start();
      listening = true;
      mic.classList.add('listening');
    } catch {
      // already started
    }
  });
}

// ---- composer -------------------------------------------------------------
function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value;
  if (!text.trim() || state.busy) return;
  input.value = '';
  autosize();
  send(text);
});

input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('form').requestSubmit();
  }
});

$('chips').addEventListener('click', (e) => {
  const chip = e.target.closest('button');
  if (chip?.dataset.prompt) send(chip.dataset.prompt, chip.textContent);
});

$('btn-new').addEventListener('click', () => {
  if (state.busy) return;
  state.session = newSessionId();
  chat.replaceChildren();
  const welcome = el('section', 'welcome');
  welcome.id = 'welcome';
  welcome.append(el('h2', '', 'Fresh start.'), el('p', '', 'What do you need?'));
  chat.append(welcome);
});

// ---- sheets ---------------------------------------------------------------
const sheet = $('sheet');
const sheetBody = $('sheet-body');
let sheetKind = '';

function openSheet(kind, title) {
  sheetKind = kind;
  $('sheet-title').textContent = title;
  sheetBody.replaceChildren();
  sheet.hidden = false;
}

function closeSheet() {
  sheet.hidden = true;
  sheetKind = '';
}

$('sheet-close').addEventListener('click', closeSheet);
sheet.addEventListener('click', (e) => {
  if (e.target === sheet && sheetKind !== 'token') closeSheet();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !sheet.hidden && sheetKind !== 'token') closeSheet();
});

function setBadge(id, count) {
  const badge = $(id);
  badge.hidden = count === 0;
  badge.textContent = count > 99 ? '99+' : String(count);
}

// drafts
async function refreshDrafts() {
  try {
    const { drafts } = await apiJson('/api/drafts');
    setBadge('badge-drafts', drafts.length);
    if (sheetKind === 'drafts') renderDrafts(drafts);
    return drafts;
  } catch {
    return [];
  }
}

function renderDrafts(drafts) {
  sheetBody.replaceChildren();
  if (!drafts.length) {
    sheetBody.append(el('p', 'empty', 'No drafts waiting. When Jarvis writes an email, it lands here for you to approve.'));
    return;
  }
  for (const d of drafts) {
    const card = el('div', 'card');
    const area = el('textarea');
    area.value = d.text;
    area.setAttribute('aria-label', 'Draft text');
    const status = el('p', 'note');
    const sendBtn = el('button', 'btn primary', 'Send');
    const discardBtn = el('button', 'btn', 'Discard');
    sendBtn.type = discardBtn.type = 'button';
    const row = el('div', 'row');
    row.append(sendBtn, discardBtn);
    card.append(el('h3', '', d.subject), el('p', 'meta', `To: ${d.to}${d.cc ? `  ·  Cc: ${d.cc}` : ''}${d.kind === 'reply' ? '  ·  the original message is quoted below your text' : ''}`), area, row, status);
    sheetBody.append(card);

    const act = async (label, fn) => {
      sendBtn.disabled = discardBtn.disabled = true;
      status.className = 'note';
      status.textContent = label;
      try {
        await fn();
        await refreshDrafts();
      } catch (err) {
        status.className = 'note error';
        status.textContent = err.message;
        sendBtn.disabled = discardBtn.disabled = false;
      }
    };
    sendBtn.addEventListener('click', () =>
      act('Sending…', async () => {
        if (area.value.trim() !== d.text.trim()) await apiJson(`/api/drafts/${d.id}`, { method: 'PUT', body: { text: area.value } });
        await apiJson(`/api/drafts/${d.id}/send`, { method: 'POST', body: {} });
      }),
    );
    discardBtn.addEventListener('click', () => act('Discarding…', () => apiJson(`/api/drafts/${d.id}/discard`, { method: 'POST', body: {} })));
  }
}

$('btn-drafts').addEventListener('click', async () => {
  openSheet('drafts', 'Email drafts');
  renderDrafts(await refreshDrafts());
});

// notifications
const KIND_LABEL = { email: 'Email', calendar: 'Calendar', whatsapp: 'WhatsApp', brief: 'Briefing' };

async function pollAlerts() {
  try {
    const { notifications } = await apiJson(`/api/notifications?since=${state.lastAlertId}`);
    if (!notifications.length) return;
    state.lastAlertId = notifications.at(-1).id;
    state.unread += notifications.filter((n) => !n.read).length;
    setBadge('badge-alerts', state.unread);
    document.title = state.unread ? `(${state.unread}) Jarvis` : 'Jarvis';
  } catch {
    // offline or locked; try again on the next poll
  }
}

$('btn-alerts').addEventListener('click', async () => {
  openSheet('alerts', 'Notifications');
  try {
    const { notifications } = await apiJson('/api/notifications?since=0');
    if (!notifications.length) sheetBody.append(el('p', 'empty', 'Nothing yet. New email, upcoming events and WhatsApp messages show up here.'));
    for (const n of notifications.reverse()) {
      const card = el('div', n.read ? 'card' : 'card unread');
      card.append(el('h3', '', n.title), el('p', 'meta', `${KIND_LABEL[n.kind] ?? n.kind} · ${new Date(n.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`));
      if (n.body) card.append(el('p', '', n.body));
      sheetBody.append(card);
    }
    await apiJson('/api/notifications/read', { method: 'POST', body: {} });
    state.unread = 0;
    setBadge('badge-alerts', 0);
    document.title = 'Jarvis';
  } catch (err) {
    sheetBody.append(el('p', 'note error', err.message));
  }
});

// WhatsApp linking
async function showQr() {
  openSheet('qr', 'Link WhatsApp');
  const render = async () => {
    if (sheetKind !== 'qr') return;
    try {
      const { status, detail, qr } = await apiJson('/api/whatsapp/qr');
      sheetBody.replaceChildren();
      if (qr) {
        const img = el('img', 'qr');
        img.src = qr;
        img.alt = 'WhatsApp linking QR code';
        sheetBody.append(el('p', 'note', 'On your phone: WhatsApp > Settings > Linked devices > Link a device, then scan this code.'), img);
      } else {
        sheetBody.append(el('p', 'empty', status === 'connected' ? 'WhatsApp is linked.' : detail || `WhatsApp status: ${status}`));
      }
      if (status !== 'connected') setTimeout(render, 4000);
    } catch (err) {
      sheetBody.replaceChildren(el('p', 'note error', err.message));
    }
  };
  render();
}

$('wa-banner').addEventListener('click', showQr);

// access token
function askForToken() {
  if (sheetKind === 'token') return;
  openSheet('token', 'Access token');
  const field = el('input', 'field');
  field.type = 'password';
  field.placeholder = 'JARVIS_TOKEN from your .env file';
  field.setAttribute('aria-label', 'Access token');
  const save = el('button', 'btn primary', 'Unlock');
  save.type = 'button';
  const row = el('div', 'row');
  row.append(save);
  sheetBody.append(el('p', 'note', 'This Jarvis is protected. Enter the access token set on the computer running it.'), field, row);
  const submit = () => {
    if (!field.value.trim()) return;
    state.token = field.value.trim();
    storage.set('jarvis.token', state.token);
    closeSheet();
    refreshStatus();
    pollAlerts();
    refreshDrafts();
  };
  save.addEventListener('click', submit);
  field.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  field.focus();
}

// status line
async function refreshStatus() {
  try {
    const s = await apiJson('/api/status');
    const parts = [];
    if (s.email.enabled) parts.push('Email');
    if (s.calendar.enabled) parts.push('Calendar');
    if (s.whatsapp.enabled) parts.push(s.whatsapp.status === 'connected' ? 'WhatsApp' : `WhatsApp (${s.whatsapp.status.replace('_', ' ')})`);
    if (s.web.enabled) parts.push('Web');
    $('status-line').textContent = parts.length ? parts.join(' · ') : 'Nothing connected yet';
    $('wa-banner').hidden = !(s.whatsapp.enabled && s.whatsapp.status === 'qr');
    // Only offer shortcuts for things that are actually connected.
    for (const chip of document.querySelectorAll('#chips [data-needs]')) chip.hidden = !s[chip.dataset.needs]?.enabled;
    setBadge('badge-drafts', s.pendingDrafts);
  } catch (err) {
    $('status-line').textContent = err.message === 'Access token needed.' ? 'Locked' : 'Offline';
  }
}

refreshStatus();
pollAlerts();
setInterval(refreshStatus, 20_000);
setInterval(pollAlerts, 20_000);
autosize();
