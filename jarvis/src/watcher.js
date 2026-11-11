// Proactive side of the assistant: periodically looks for new mail and
// imminent calendar events, turns incoming WhatsApp messages into
// notifications, and produces the daily briefing. None of the periodic checks
// call the language model; only the daily briefing does.

function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}` };
}

export class Watcher {
  constructor({ cfg, store, services, agent, log = console }) {
    this.cfg = cfg;
    this.store = store;
    this.email = services.email;
    this.calendar = services.calendar;
    this.whatsapp = services.whatsapp;
    this.agent = agent;
    this.log = log;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (!this.cfg.watcher.enabled) return;
    this.whatsapp?.on('message', (m) => {
      this.store.addNotification({
        kind: 'whatsapp',
        title: m.isGroup ? `${m.sender} in ${m.chat}` : m.chat,
        body: m.text.slice(0, 300),
        key: `wa:${m.id}`,
      });
    });
    const tick = () => this.tick().catch((err) => this.log.warn(`[watcher] ${err.message}`));
    this.timer = setInterval(tick, this.cfg.watcher.intervalMinutes * 60_000);
    this.timer.unref?.();
    // First check shortly after start, once connections have settled.
    setTimeout(tick, 5000).unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Store a notification and, if enabled, push it to the WhatsApp self-chat. */
  async notify(item) {
    const saved = this.store.addNotification(item);
    if (!saved) return null; // duplicate
    if (this.cfg.whatsapp.notify && this.whatsapp?.status === 'connected') {
      await this.whatsapp.sendToSelf(item.body ? `${item.title}\n${item.body}` : item.title).catch((err) => {
        this.log.warn(`[watcher] could not push to WhatsApp: ${err.message}`);
      });
    }
    return saved;
  }

  async tick(now = new Date()) {
    if (this.running) return; // a slow check must not pile up
    this.running = true;
    try {
      await this.checkEmail().catch((err) => this.log.warn(`[watcher] email check failed: ${err.message}`));
      await this.checkCalendar(now).catch((err) => this.log.warn(`[watcher] calendar check failed: ${err.message}`));
      await this.checkBrief(now).catch((err) => this.log.warn(`[watcher] briefing failed: ${err.message}`));
    } finally {
      this.running = false;
    }
  }

  async checkEmail() {
    if (!this.email) return;
    const last = this.store.getState('email.lastUid', null);
    if (last === null) {
      // First run: remember where the inbox is now instead of announcing
      // every unread message that is already there.
      this.store.setState('email.lastUid', await this.email.latestUid());
      return;
    }
    const { latest, messages, total } = await this.email.newSince(last, 5);
    // Oldest first, so notifications read in arrival order.
    for (const m of [...messages].reverse()) {
      await this.notify({ kind: 'email', title: `New email from ${m.from || 'unknown sender'}`, body: `${m.subject}${m.snippet ? `\n${m.snippet}` : ''}`, key: `email:${m.id}` });
    }
    if (total > messages.length) {
      await this.notify({ kind: 'email', title: `...and ${total - messages.length} more new emails`, key: `email:more:${latest}` });
    }
    if (latest > last) this.store.setState('email.lastUid', latest);
  }

  async checkCalendar(now) {
    if (!this.calendar) return;
    const lead = this.cfg.watcher.eventLeadMinutes;
    const { events } = await this.calendar.upcoming({ from: now, days: 1, limit: 30 });
    for (const e of events) {
      if (e.allDay) continue;
      const minutes = Math.round((e.start - now) / 60_000);
      if (minutes < 0 || minutes > lead) continue;
      await this.notify({
        kind: 'calendar',
        title: minutes <= 1 ? `Starting now: ${e.title}` : `In ${minutes} min: ${e.title}`,
        body: [this.calendar.describe(e), e.location].filter(Boolean).join(' - '),
        key: `event:${e.uid}`,
      });
    }
  }

  async checkBrief(now) {
    const at = this.cfg.watcher.briefTime;
    if (!at || !this.agent) return;
    const { day, time } = localParts(now, this.cfg.user.timezone);
    // Only within three hours of the chosen time: starting Jarvis late in the
    // evening should not produce a "morning" briefing.
    const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
    const late = minutes(time) - minutes(at);
    if (late < 0 || late >= 180 || this.store.getState('brief.lastDay', '') === day) return;
    // Mark first: a failing briefing should not retry (and bill) every tick.
    this.store.setState('brief.lastDay', day);
    const { text, error } = await this.agent.brief();
    if (error) throw new Error(text);
    await this.notify({ kind: 'brief', title: 'Your daily briefing', body: text, key: `brief:${day}` });
  }
}
