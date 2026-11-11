// Read-only calendar access through iCalendar (.ics) feeds. Google Calendar,
// iCloud and Outlook can all publish a private ICS link, which avoids OAuth
// entirely. Sources may also be paths to local .ics files.
import fs from 'node:fs/promises';
import ical from 'node-ical';

const CACHE_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;

function text(value) {
  // node-ical returns either a string or { params, val } for text properties.
  if (value && typeof value === 'object' && 'val' in value) return String(value.val);
  return value == null ? '' : String(value);
}

export class CalendarService {
  constructor(cfg, { fetchImpl = fetch, timezone = 'UTC' } = {}) {
    this.sources = cfg.sources;
    this.fetch = fetchImpl;
    this.timezone = timezone;
    this.cache = new Map(); // source -> { at, events }
  }

  async #loadSource(source) {
    const cached = this.cache.get(source);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.events;

    let raw;
    if (/^https?:\/\//i.test(source)) {
      const res = await this.fetch(source, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
      if (!res.ok) throw new Error(`calendar feed answered HTTP ${res.status}`);
      raw = await res.text();
    } else {
      raw = await fs.readFile(source, 'utf8');
    }
    if (!/BEGIN:VCALENDAR/i.test(raw)) throw new Error('not an iCalendar file (is the link the "secret address in iCal format"?)');

    const parsed = ical.sync.parseICS(raw);
    const events = Object.values(parsed).filter((e) => e?.type === 'VEVENT');
    this.cache.set(source, { at: Date.now(), events });
    return events;
  }

  /**
   * Events that overlap [from, from + days). Recurring events are expanded.
   * @returns {{ events: object[], errors: string[] }}
   */
  async upcoming({ from = new Date(), days = 7, limit = 40 } = {}) {
    const to = new Date(from.getTime() + days * 86_400_000);
    const events = [];
    const errors = [];

    for (const [index, source] of this.sources.entries()) {
      let sourceEvents;
      try {
        sourceEvents = await this.#loadSource(source);
      } catch (err) {
        errors.push(`Calendar ${index + 1} could not be loaded: ${err.message}`);
        continue;
      }
      for (const event of sourceEvents) {
        if (String(event.status ?? '').toUpperCase() === 'CANCELLED') continue;
        let instances;
        try {
          instances = ical.expandRecurringEvent(event, { from, to, expandOngoing: true });
        } catch (err) {
          errors.push(`Skipped "${text(event.summary)}": ${err.message}`);
          continue;
        }
        for (const inst of instances) {
          const start = new Date(inst.start);
          const end = inst.end ? new Date(inst.end) : start;
          if (end <= from && !(inst.isFullDay && start >= from)) continue;
          events.push({
            uid: `${event.uid ?? text(event.summary)}@${start.toISOString()}`,
            title: text(inst.summary ?? event.summary) || '(untitled)',
            start,
            end,
            allDay: Boolean(inst.isFullDay),
            location: text(event.location),
            notes: text(event.description).replace(/\s+/g, ' ').slice(0, 300),
          });
        }
      }
    }

    events.sort((a, b) => a.start - b.start);
    return { events: events.slice(0, limit), errors };
  }

  /** Human-readable time range in the user's time zone. */
  describe(event) {
    const day = new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      // All-day events are stored as a calendar date; do not shift them across zones.
      timeZone: event.allDay ? undefined : this.timezone,
    });
    if (event.allDay) return `${day.format(event.start)} (all day)`;
    const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: this.timezone });
    const sameDay = day.format(event.start) === day.format(event.end);
    return sameDay
      ? `${day.format(event.start)} ${time.format(event.start)}-${time.format(event.end)}`
      : `${day.format(event.start)} ${time.format(event.start)} to ${day.format(event.end)} ${time.format(event.end)}`;
  }
}
