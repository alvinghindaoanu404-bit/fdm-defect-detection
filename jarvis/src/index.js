#!/usr/bin/env node
// Command-line entry point.
//   node src/index.js start    run Jarvis: web app, background checks, WhatsApp
//   node src/index.js chat     talk to Jarvis in this terminal
//   node src/index.js brief    print a one-off briefing
//   node src/index.js doctor   check that everything is set up
import os from 'node:os';
import readline from 'node:readline';
import QRCode from 'qrcode';
import { createApp } from './app.js';
import { loadConfig, loadEnvFile } from './config.js';
import { createServer } from './server.js';

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

function reportProblems(cfg) {
  for (const p of cfg.problems) console.warn(`! ${p}`);
}

async function start(cfg) {
  if (!cfg.server.loopbackOnly && cfg.server.token.length < 16) {
    console.error('Refusing to start: JARVIS_HOST makes Jarvis reachable from your network, which requires JARVIS_TOKEN (16+ characters).');
    process.exit(1);
  }
  const app = createApp(cfg);
  const { services, agent, watcher } = app;

  if (services.whatsapp) {
    services.whatsapp.on('qr', async (qr) => {
      console.log('\nLink WhatsApp: open WhatsApp on your phone > Settings > Linked devices > Link a device, then scan:\n');
      console.log(await QRCode.toString(qr, { type: 'terminal', small: true }));
      console.log('(The same code is shown in the web app.)\n');
    });
    services.whatsapp.on('status', (s) => console.log(`[whatsapp] ${s}${services.whatsapp.detail ? `: ${services.whatsapp.detail}` : ''}`));
    services.whatsapp.start().catch((err) => console.warn(`[whatsapp] failed to start: ${err.message}`));
  }
  watcher.start();

  const server = createServer(app);
  server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${cfg.server.port} is already in use. Is Jarvis already running? (Change JARVIS_PORT to use another port.)` : err.message);
    process.exit(1);
  });
  server.listen(cfg.server.port, cfg.server.host, () => {
    const s = agent.status();
    console.log(`Jarvis is running.  Brain: ${s.brain.provider} (${s.brain.model || 'not set'})`);
    console.log(`  Email: ${s.email.enabled ? s.email.address : 'off'} | Calendar: ${s.calendar.enabled ? 'on' : 'off'} | WhatsApp: ${s.whatsapp.enabled ? 'on' : 'off'} | Web: ${s.web.enabled ? s.web.via : 'off'}`);
    if (cfg.server.loopbackOnly) {
      console.log(`  Open http://localhost:${cfg.server.port} on this computer.`);
      console.log('  (To use it from your phone, see "Using it from your iPhone" in the README.)');
    } else {
      for (const ip of lanAddresses()) console.log(`  On your phone (same Wi-Fi): http://${ip}:${cfg.server.port}/#token=<your JARVIS_TOKEN>`);
    }
  });

  const shutdown = async () => {
    watcher.stop();
    await services.whatsapp?.stop();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function chat(cfg) {
  const { agent } = createApp(cfg);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'you > ' });
  console.log('Jarvis is listening. Type /help for commands, Ctrl+C to quit.\n');
  rl.prompt();
  // Lines are handled one at a time, in order (also when input is piped in).
  for await (const raw of rl) {
    const line = raw.trim();
    if (line) {
      let streamed = false;
      const reply = await agent.handle('terminal', line, {
        onEvent: (e) => {
          if (e.type === 'text') {
            if (!streamed) process.stdout.write('\njarvis > ');
            streamed = true;
            process.stdout.write(e.delta);
          } else if (e.type === 'tool' && e.status === 'start') {
            process.stdout.write(`${streamed ? '\n' : ''}  [${e.label}...]\n`);
            streamed = false;
          } else if (e.type === 'notice') {
            process.stdout.write(`\n  (${e.text})\n`);
          } else if (e.type === 'reset') {
            streamed = false;
          }
        },
      });
      // Commands and errors are not streamed; print them whole.
      console.log(streamed ? '\n' : `\njarvis > ${reply.text}\n`);
    }
    rl.prompt();
  }
  process.exit(0);
}

async function brief(cfg) {
  const { agent } = createApp(cfg);
  const reply = await agent.brief();
  console.log(reply.text);
  process.exit(reply.error ? 1 : 0);
}

async function doctor(cfg) {
  const { services, provider } = createApp(cfg);
  let failures = 0;
  const check = async (label, fn) => {
    try {
      const note = await fn();
      console.log(`  ok    ${label}${note ? ` - ${note}` : ''}`);
    } catch (err) {
      failures++;
      console.log(`  FAIL  ${label} - ${err.message}`);
    }
  };
  const skip = (label, why) => console.log(`  off   ${label} - ${why}`);

  console.log('Checking your setup...\n');
  if (cfg.llm.provider === 'anthropic') {
    await check(`Brain: Claude (${cfg.llm.anthropic.model})`, async () => {
      try {
        await provider.client.models.retrieve(cfg.llm.anthropic.model);
      } catch (err) {
        throw new Error(provider.describeError(err));
      }
    });
  } else if (!cfg.llm.local.model) {
    failures++;
    console.log('  FAIL  Brain - nothing configured. Set ANTHROPIC_API_KEY, or LOCAL_LLM_MODEL for a model on this computer.');
  } else {
    await check(`Brain: local model "${cfg.llm.local.model}" at ${cfg.llm.local.baseUrl}`, () => provider.check());
  }

  if (services.email) await check(`Email: ${cfg.email.address}`, () => services.email.check());
  else skip('Email', 'set EMAIL_ADDRESS and EMAIL_PASSWORD (an app password)');

  if (services.calendar) {
    await check('Calendar', async () => {
      const { events, errors } = await services.calendar.upcoming({ days: 30 });
      if (errors.length) throw new Error(errors.join('; '));
      return `${events.length} event(s) in the next 30 days`;
    });
  } else skip('Calendar', 'set CALENDAR_ICS_URLS');

  if (provider.nativeWeb) console.log("  ok    Web - Claude's built-in search (checked on first use)");
  else if (services.web.searchBackend) await check(`Web search (${services.web.searchBackend})`, async () => `${(await services.web.search('weather today', 3)).length} result(s)`);
  else skip('Web', 'WEB_SEARCH=off');

  if (cfg.whatsapp.enabled) console.log('  ok    WhatsApp - enabled; it links when you run "npm start" (scan the QR code)');
  else skip('WhatsApp', 'set WHATSAPP_ENABLED=true (read the README warning first)');

  console.log(failures ? `\n${failures} problem(s) to fix.` : '\nAll good.');
  process.exit(failures ? 1 : 0);
}

const HELP = `Usage: npm start | npm run chat | npm run brief | npm run doctor

  start    run Jarvis: web app, background checks and WhatsApp
  chat     talk to Jarvis in this terminal
  brief    print a one-off briefing and exit
  doctor   check that your .env settings work`;

async function main() {
  const command = process.argv[2] ?? 'start';
  if (['help', '--help', '-h'].includes(command)) return console.log(HELP);
  loadEnvFile();
  const cfg = loadConfig();
  reportProblems(cfg);
  const commands = { start, chat, brief, doctor };
  if (!commands[command]) {
    console.error(`Unknown command "${command}".\n\n${HELP}`);
    process.exit(1);
  }
  await commands[command](cfg);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
