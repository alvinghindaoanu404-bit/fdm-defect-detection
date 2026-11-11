// Shared test helpers: throwaway directories, in-process mail servers and a
// scripted stand-in for the language model.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

const require = createRequire(import.meta.url);

export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-test-'));
}

/** Config built from an explicit env map (never from the real environment). */
export function testConfig(env = {}) {
  return loadConfig({ JARVIS_DATA_DIR: tmpDir(), JARVIS_TIMEZONE: 'Europe/London', JARVIS_USER_NAME: 'Sam', ...env });
}

const CRLF = (s) => s.replace(/\r?\n/g, '\r\n');

export const MAILS = {
  plain: CRLF(`From: Anna Lind <anna@example.org>
To: Sam <testuser@example.com>
Cc: Bo <bo@example.org>
Subject: Lunch on Friday?
Message-ID: <m1@example.org>
References: <m0@example.org>
Date: Mon, 09 Nov 2026 10:00:00 +0000
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

Hi Sam,

Are you free for lunch on Friday at 12:30?

Anna
`),
  html: CRLF(`From: "Shop, The" <news@shop.example>
To: testuser@example.com
Subject: =?UTF-8?Q?Caf=C3=A9_offer?=
Message-ID: <m2@shop.example>
Date: Tue, 10 Nov 2026 09:00:00 +0000
MIME-Version: 1.0
Content-Type: text/html; charset=iso-8859-1
Content-Transfer-Encoding: quoted-printable

<html><body><h1>Caf=E9 deals</h1><p>Half price <b>today</b> only.</p><script>alert(1)</script></body></html>
`),
  attachment: CRLF(`From: Raj <raj@example.net>
To: testuser@example.com
Subject: Report attached
Message-ID: <m3@example.net>
Date: Tue, 10 Nov 2026 11:00:00 +0000
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="XX"

--XX
Content-Type: text/plain; charset=utf-8

Please find the quarterly report attached.
--XX
Content-Type: application/pdf; name="q3-report.pdf"
Content-Disposition: attachment; filename="q3-report.pdf"
Content-Transfer-Encoding: base64

JVBERi0xLjQK
--XX--
`),
};

/** In-memory IMAP server seeded with three messages (the first is already read). */
export async function startImap() {
  const hoodiecrow = require('hoodiecrow-imap');
  const server = hoodiecrow({
    plugins: ['UIDPLUS', 'IDLE', 'LITERALPLUS'],
    users: { 'testuser@example.com': { password: 'testpass' } },
    storage: {
      INBOX: {
        messages: [
          { raw: MAILS.plain, flags: ['\\Seen'], internaldate: '09-Nov-2026 10:00:00 +0000' },
          { raw: MAILS.html, internaldate: '10-Nov-2026 09:00:00 +0000' },
          { raw: MAILS.attachment, internaldate: '10-Nov-2026 11:00:00 +0000' },
        ],
      },
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.server ?? server).address().port;
  return { server, port, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** SMTP server that records every message it accepts. */
export async function startSmtp() {
  const { SMTPServer } = require('smtp-server');
  const received = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onAuth: (auth, session, cb) => cb(null, { user: auth.username }),
    onData(stream, session, cb) {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        received.push({ from: session.envelope.mailFrom.address, to: session.envelope.rcptTo.map((r) => r.address), raw: Buffer.concat(chunks).toString('utf8') });
        cb();
      });
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { received, port: server.server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

/**
 * Stand-in for a model. `script(userText)` returns steps, each either
 * { tool, input } or { text }. Tool results are recorded in `this.toolResults`.
 */
export class ScriptedProvider {
  name = 'scripted';
  model = 'test-model';
  nativeWeb = false;
  maxToolResultChars = 20_000;

  constructor(script) {
    this.script = script;
    this.toolResults = [];
    this.calls = [];
  }

  async run({ system, history = [], userText, tools, executeTool, onEvent = () => {} }) {
    this.calls.push({ system, userText, toolNames: tools.map((t) => t.name), historyLength: history.length });
    let text = '';
    for (const step of this.script(userText)) {
      if (step.tool) this.toolResults.push({ tool: step.tool, ...(await executeTool(step.tool, step.input ?? {})) });
      if (step.text) {
        text += step.text;
        onEvent({ type: 'text', delta: step.text });
      }
    }
    return { text, history: [...history, { role: 'user', content: userText }, { role: 'assistant', content: text }] };
  }

  describeError(err) {
    return err.message;
  }
}
