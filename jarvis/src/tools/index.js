// The tools the assistant can call. Each tool is { name, description,
// parameters (JSON Schema), run(input, ctx) } and returns a string or a
// JSON-serialisable value. Only tools for configured integrations are offered.
import { buildReply } from '../integrations/email.js';

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

function emailTools({ email, store, cfg }) {
  const autoSend = cfg.email.sendMode === 'auto';

  const saveOrSend = async (draft) => {
    if (!autoSend) {
      const saved = store.addDraft(draft);
      return {
        draft_id: saved.id,
        status: 'saved_awaiting_approval',
        to: saved.to,
        ...(saved.cc ? { cc: saved.cc } : {}),
        subject: saved.subject,
        note: `Not sent. Only the user can send it: the Send button in the app, or by typing /send ${saved.id}. Show them the draft text and this id.`,
      };
    }
    const sent = await email.send(draft);
    return { status: 'sent', to: draft.to, subject: draft.subject, accepted: sent.accepted };
  };

  return [
    {
      name: 'list_emails',
      description:
        'List recent emails in the inbox, newest first, with sender, subject, date and a short snippet. Use this to see what has arrived. Reading does not mark anything as read.',
      parameters: obj({
        unread_only: { type: 'boolean', description: 'Only unread messages. Default true.' },
        limit: { type: 'integer', minimum: 1, maximum: 25, description: 'How many to return. Default 10.' },
        since_days: { type: 'integer', minimum: 1, maximum: 90, description: 'Look back this many days. Default 14.' },
        include_promotions: { type: 'boolean', description: 'Gmail only: include the Promotions/Social/Updates tabs. Default false.' },
      }),
      run: (i) => email.list({ unreadOnly: i.unread_only ?? true, limit: i.limit ?? 10, sinceDays: i.since_days ?? 14, allCategories: i.include_promotions ?? false }),
    },
    {
      name: 'search_emails',
      description:
        'Search the inbox. Matches sender, subject and body. With Gmail the query may use Gmail search syntax (e.g. "from:anna invoice newer_than:30d").',
      parameters: obj(
        {
          query: { type: 'string', description: 'What to look for.' },
          limit: { type: 'integer', minimum: 1, maximum: 25, description: 'How many to return. Default 10.' },
        },
        ['query'],
      ),
      run: (i) => email.search({ query: i.query, limit: i.limit ?? 10 }),
    },
    {
      name: 'read_email',
      description: 'Read one email in full (headers, body text, attachment names) by the id from list_emails or search_emails.',
      parameters: obj({ id: { type: 'string', description: 'Email id.' } }, ['id']),
      run: (i) => email.read(i.id),
    },
    {
      name: 'draft_reply',
      description: autoSend
        ? 'Reply to an email and SEND it immediately. Only call this when the user has clearly asked for the reply to be sent.'
        : 'Write a reply to an email. This saves a draft for the user to approve; it does not send anything. Write only the new message text: the greeting, body and sign-off. The original message is quoted automatically.',
      parameters: obj(
        {
          email_id: { type: 'string', description: 'Id of the email being answered.' },
          body: { type: 'string', description: 'The reply text, plain text.' },
          reply_all: { type: 'boolean', description: 'Also address the other recipients. Default false.' },
        },
        ['email_id', 'body'],
      ),
      run: async (i) => {
        const original = await email.read(i.email_id);
        const reply = buildReply(original, { replyAll: i.reply_all ?? false, selfAddress: cfg.email.address });
        return saveOrSend({
          kind: 'reply',
          to: reply.to,
          cc: reply.cc,
          subject: reply.subject,
          text: i.body.trim(),
          quote: reply.quote,
          inReplyTo: reply.inReplyTo,
          references: reply.references,
          sourceEmailId: original.id,
        });
      },
    },
    {
      name: 'draft_email',
      description: autoSend
        ? 'Compose a new email and SEND it immediately. Only call this when the user has clearly asked for it to be sent.'
        : 'Compose a new email (not a reply). This saves a draft for the user to approve; it does not send anything.',
      parameters: obj(
        {
          to: { type: 'string', description: 'Recipient address(es), comma separated.' },
          subject: { type: 'string' },
          body: { type: 'string', description: 'Plain text body.' },
        },
        ['to', 'subject', 'body'],
      ),
      run: (i) => saveOrSend({ kind: 'new', to: i.to, cc: '', subject: i.subject, text: i.body.trim(), quote: '' }),
    },
  ];
}

function calendarTools({ calendar }) {
  return [
    {
      name: 'get_upcoming_events',
      description: "Calendar events from now on, soonest first. Times are in the user's time zone. The calendar is read-only.",
      parameters: obj({
        days: { type: 'integer', minimum: 1, maximum: 60, description: 'How many days ahead to look. Default 7.' },
        limit: { type: 'integer', minimum: 1, maximum: 60, description: 'Maximum number of events. Default 25.' },
      }),
      run: async (i) => {
        const { events, errors } = await calendar.upcoming({ days: i.days ?? 7, limit: i.limit ?? 25 });
        return {
          events: events.map((e) => ({
            title: e.title,
            when: calendar.describe(e),
            // All-day events are calendar dates; a UTC timestamp would mislead.
            ...(e.allDay ? {} : { starts_at: e.start.toISOString() }),
            ...(e.location ? { location: e.location } : {}),
            ...(e.notes ? { notes: e.notes } : {}),
          })),
          ...(errors.length ? { problems: errors } : {}),
        };
      },
    },
  ];
}

function whatsappTools({ whatsapp }) {
  return [
    {
      name: 'get_whatsapp_messages',
      description:
        'WhatsApp messages other people sent to the user recently, oldest first. Only messages that arrived while Jarvis was running are available. This is read-only: Jarvis cannot send WhatsApp messages to other people.',
      parameters: obj({
        since_hours: { type: 'integer', minimum: 1, maximum: 168, description: 'How far back to look. Default 24.' },
        chat: { type: 'string', description: 'Only this person or group (partial name is fine).' },
        limit: { type: 'integer', minimum: 1, maximum: 150, description: 'Maximum number of messages. Default 60.' },
      }),
      run: (i) => {
        const messages = format(whatsapp.recent({ sinceHours: i.since_hours ?? 24, chat: i.chat ?? '', limit: i.limit ?? 60 }));
        if (whatsapp.status === 'connected') return { connected: true, messages };
        return {
          connected: false,
          note: whatsapp.detail || 'WhatsApp is not linked right now, so newer messages may be missing.',
          messages,
        };
      },
    },
  ];

  function format(messages) {
    return messages.map((m) => ({
      chat: m.chat,
      ...(m.isGroup ? { from: m.sender } : {}),
      at: new Date(m.timestamp).toISOString(),
      text: m.text,
    }));
  }
}

function webTools({ web }, ctx) {
  return [
    {
      name: 'web_search',
      description: 'Search the web. Returns titles, links and snippets. Follow up with read_webpage for details.',
      parameters: obj(
        {
          query: { type: 'string', description: 'Search terms.' },
          limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Number of results. Default 6.' },
        },
        ['query'],
      ),
      run: (i) => web.search(i.query, i.limit ?? 6),
    },
    {
      name: 'read_webpage',
      description:
        'Open a web page and return its text. You may only open links that already appeared in this conversation (search results, the user\'s messages, emails) or pages on a site the user named.',
      parameters: obj({ url: { type: 'string', description: 'Full link, starting with https://' } }, ['url']),
      run: (i, session) => {
        if (!ctx.isUrlAllowed(i.url, session)) {
          throw new Error(
            'This link has not appeared in the conversation, so it will not be opened. Search for it first, or ask the user to paste the link or name the site.',
          );
        }
        return web.read(i.url);
      },
    },
  ];
}

/**
 * @param {object} services  { email, calendar, whatsapp, web, store, cfg }
 * @param {object} ctx       { nativeWeb, isUrlAllowed }
 */
export function buildTools(services, ctx) {
  const { cfg } = services;
  const tools = [];
  if (cfg.email.enabled) tools.push(...emailTools(services));
  if (cfg.calendar.enabled) tools.push(...calendarTools(services));
  if (cfg.whatsapp.enabled) tools.push(...whatsappTools(services));
  // With Claude's own web tools on, the search/fetch run on Anthropic's side.
  if (!ctx.nativeWeb && services.web.searchBackend) tools.push(...webTools(services, ctx));
  return tools;
}
