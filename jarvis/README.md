# Jarvis

A personal assistant that runs on your own computer. It reads your email and drafts replies, tells you what is on your calendar, summarises WhatsApp messages, looks things up on the internet, and can alert you when something needs attention. You talk to it from a browser, a terminal, your iPhone, or WhatsApp itself.

## Read this first: what it can and cannot do

| You asked for | What you get | The catch |
|---|---|---|
| Runs locally on my computer | Yes. One Node.js program; your mail password, drafts and WhatsApp session stay on your machine. | The computer must be on and running Jarvis for alerts, WhatsApp and phone access to work. |
| Runs locally on my iPhone | No, and nothing can. iOS does not let an app read other apps' notifications or run a background assistant. | Your iPhone is a remote control for the Jarvis on your computer (web app, WhatsApp chat or Siri Shortcut). See [Using it from your iPhone](#using-it-from-your-iphone). |
| Responds to emails | Reads, searches and drafts replies. **You approve each one** before it is sent. | Inbox only (not archived mail). Needs an app password; personal Outlook/Hotmail accounts generally no longer allow that. |
| Upcoming events | Reads your calendar and reminds you before events. | Read-only: it cannot create or move events. |
| WhatsApp notifications | Records messages that arrive while Jarvis is running and summarises them. You can also chat with Jarvis by messaging yourself. | Uses an unofficial library. This breaks WhatsApp's terms of service and your number could be restricted. Off by default. It never messages other people. |
| Internet access | Web search and page reading. | With a local model, search goes through DuckDuckGo, which sometimes blocks automated use. |

## Quick start

You need [Node.js](https://nodejs.org) 22 or newer.

```bash
cd jarvis
npm install
cp .env.example .env      # Windows: copy .env.example .env
```

Open `.env` in a text editor and fill in at least the brain (section 1 of the file). Then:

```bash
npm run doctor            # checks every setting and tells you what is wrong
npm start                 # then open http://localhost:8787
```

Other ways to run it: `npm run chat` (talk in the terminal) and `npm run brief` (print one briefing and exit).

## Choosing the brain

Jarvis needs a language model. You have two options, and you can switch with one line in `.env`.

**Claude (recommended).** Set `ANTHROPIC_API_KEY`. The default model is `claude-opus-5-5`. It is pay-per-use: as a rough estimate, a briefing that reads a dozen emails costs somewhere between a few cents and 20 cents. `JARVIS_MODEL=claude-sonnet-5-5` or `claude-haiku-5-5` is cheaper. The trade-off is privacy: the emails and messages Jarvis reads are sent to Anthropic's API to be processed. Web search uses Claude's built-in search. If Claude's safety filters decline a request, Jarvis lets Anthropic retry it on its recommended fallback model (`ANTHROPIC_FALLBACKS=false` turns this off).

**A model on your computer (free, private, weaker).** Install [Ollama](https://ollama.com), pull a model that supports tool calling, and set `LOCAL_LLM_MODEL` to its name. Nothing leaves your machine except web searches. Expect a small local model to make more mistakes with multi-step tasks such as "find the email from Anna and draft a reply". Two practical notes:

- Give the model enough context, or it silently forgets its instructions: start Ollama with `OLLAMA_CONTEXT_LENGTH=16384` (or higher).
- LM Studio and llama.cpp work too; point `LOCAL_LLM_URL` at their OpenAI-compatible address.

## Setting up each feature

**Email.** Set `EMAIL_ADDRESS` and `EMAIL_PASSWORD`. The password must be an *app password*, not your normal one. Gmail: turn on 2-Step Verification, then create one at <https://myaccount.google.com/apppasswords>. iCloud: <https://account.apple.com> > Sign-In and Security > App-Specific Passwords. Gmail, iCloud, Yahoo and Fastmail are recognised automatically; for anything else also set the IMAP and SMTP hosts.

**Calendar.** Set `CALENDAR_ICS_URLS` to your calendar's private iCal link. Google Calendar: Settings > click your calendar > "Secret address in iCal format". iCloud: share the calendar as a Public Calendar and copy the link. Several links can be separated with commas. Treat the link like a password.

**WhatsApp.** Set `WHATSAPP_ENABLED=true`, run `npm start`, and scan the QR code (shown in the terminal and in the web app) from WhatsApp > Settings > Linked devices > Link a device. From then on:

- incoming messages are recorded so you can ask "what did I miss on WhatsApp?";
- messages you send to yourself (the "Message yourself" chat) are treated as messages to Jarvis, and it replies there;
- new-email alerts, event reminders and the daily briefing are sent to that chat (`WHATSAPP_NOTIFY`).

Jarvis only sees messages that arrive while it is running, never marks chats as read, and has no way to message anyone but you.

**Daily briefing.** Set `DAILY_BRIEF_TIME=07:30` to get one automatically each morning.

## Using it from your iPhone

Pick whichever suits you. All of them need the computer to be on.

1. **WhatsApp (simplest).** With WhatsApp enabled, open the "Message yourself" chat and type to Jarvis. Alerts arrive there as normal WhatsApp notifications.
2. **The web app on your home Wi-Fi.** In `.env` set `JARVIS_HOST=0.0.0.0` and `JARVIS_TOKEN` to a long random phrase. `npm start` prints a link like `http://192.168.1.20:8787/#token=...`; open it in Safari, then Share > Add to Home Screen for an app-like icon. For voice, use the dictation key on the iPhone keyboard and the speaker button to have replies read aloud. (The in-page microphone button only appears on the computer itself, because browsers require HTTPS for it elsewhere.)
3. **"Hey Siri, Jarvis".** In the Shortcuts app create a shortcut named Jarvis: *Dictate Text* > *Get Contents of URL* (URL `http://<computer address>:8787/api/ask`, method POST, header `Authorization: Bearer <your token>`, JSON body with `message` = the dictated text) > *Get Dictionary Value* (`text`) > *Speak Text*.
4. **Away from home.** Install [Tailscale](https://tailscale.com) on the computer and the phone and use the computer's Tailscale address in place of the Wi-Fi address. Do not forward the port on your router.

## Commands

Type these in any chat with Jarvis (browser, terminal or WhatsApp). They are handled by the program, not by the model.

| Command | What it does |
|---|---|
| `/brief` | Calendar, email and WhatsApp summary |
| `/drafts` | Email drafts waiting for your approval |
| `/send <id>` | Send a draft |
| `/discard <id>` | Delete a draft |
| `/new` | Start a fresh conversation |
| `/status` | What is connected |

## Safety

An assistant that reads your mail, browses the web and can send messages is a target: anyone can email you text that tries to give it instructions. The design assumes that will happen.

- **Sending needs you.** The model can only save drafts. Sending happens through the Send button or `/send`, which the model cannot trigger. `EMAIL_SEND_MODE=auto` removes this protection; a cleverly written incoming email could then make Jarvis send mail in your name. Leave it on `approve`.
- **No WhatsApp messages to other people.** That capability does not exist in the code.
- **Links.** When Jarvis does the browsing itself (a local model, or `WEB_SEARCH=duckduckgo`/`brave`), it opens a web page only if the exact link already appeared in the conversation (search results, your messages, an email) or the page is on a site you named. This blocks the trick of smuggling your private data out inside a web address. It also refuses addresses on your own computer and home network. With Claude's built-in web tools, search and page reading run on Anthropic's side, which likewise only fetches links already present in the conversation.
- **Access.** By default the web app answers only on the computer itself. Opening it to your network requires `JARVIS_TOKEN`.
- **What remains.** A model can still be fooled into giving you a wrong or manipulated summary. Read important emails yourself before acting on them.

Your settings are in `.env`; drafts, notifications and the WhatsApp session are in `data/`. Both are excluded from git. Delete `data/whatsapp-auth` to unlink WhatsApp.

## What has and has not been tested

`npm test` runs 61 automated tests. They cover email against real IMAP and SMTP servers running inside the test, calendar parsing (recurring events, time zones), the web server and its access rules, the approval flow, both model integrations and the WhatsApp message handling.

Not yet verified against the real services, because the build environment had no accounts and no access to them: a live Gmail or iCloud mailbox, a live Claude or Ollama model (both integrations were tested against stand-ins that speak the same protocol), linking a real WhatsApp account, DuckDuckGo and Brave search, and the Siri Shortcut. `npm run doctor` is the fastest way to find out which of these work on your machine.

## Project layout

```
src/index.js           command line: start, chat, brief, doctor
src/app.js             wires everything together
src/agent.js           system prompt, conversations, tool execution, slash commands
src/llm/               the two brains: anthropic.js (Claude), local.js (Ollama etc.)
src/tools/             the tools the model can call, and input validation
src/integrations/      email.js, calendar.js, whatsapp.js, web.js
src/watcher.js         background checks, reminders, daily briefing
src/server.js          web server and API
src/public/            the web app
test/                  automated tests
```
