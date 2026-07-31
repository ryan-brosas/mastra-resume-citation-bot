import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { PROJECT_ROOT } from '../src/citations/manifest.ts';

const CHROME = join(homedir(), '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome');
const available = existsSync(CHROME);
const UI = join(PROJECT_ROOT, 'src/mastra/ui');

/** A page whose text is hostile and whose crop is deliberately not square. */
const HOSTILE = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script> and [1].';
const PAYLOAD = {
  answer: HOSTILE,
  version: 'sha256-test',
  citations: [
    {
      id: 'doc-test.p1.c1',
      page: 1,
      label: 'p.1',
      excerpt: 'quoted passage from the page',
      quote: 'quoted passage from the page',
      rects: [{ x: 0.25, y: 0.5, width: 0.5, height: 0.05 }],
    },
  ],
  pages: [{ page: 1, widthPoints: 612, heightPoints: 792, image: 'ask/page/1?v=sha256-test' }],
};

const TYPES: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };

type Mode = 'ok' | 'no-document' | 'no-citations' | 'broken-image' | 'flaky' | 'mixed' | 'slow' | 'overloaded';

const servers: Server[] = [];
const browsers: ChildProcess[] = [];
const browserProfiles: string[] = [];

after(async () => {
  await Promise.all(browsers.map((browser) => {
    if (browser.exitCode !== null) return Promise.resolve();
    return new Promise<void>((done) => {
      browser.once('exit', () => done());
      browser.kill();
    });
  }));
  await Promise.all(servers.map((instance) => new Promise<void>((done) => instance.close(() => done()))));
  await Promise.all(browserProfiles.map((profile) =>
    rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  ));
});

async function serve(mode: Mode): Promise<string> {
  let answered = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path === '/ask' || path === '/') {
      response.writeHead(200, { 'content-type': TYPES['.html'] });
      response.end(await readFile(join(UI, 'index.html')));
      return;
    }
    for (const file of ['app.css', 'app.js', 'favicon.svg']) {
      if (path === '/ask/' + file) {
        response.writeHead(200, { 'content-type': file.endsWith('.css') ? TYPES['.css'] : file.endsWith('.js') ? TYPES['.js'] : 'image/svg+xml' });
        response.end(await readFile(join(UI, file)));
        return;
      }
    }
    if (path === '/ask/document') {
      if (mode === 'no-document') {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ code: 'manifest_unavailable' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ title: 'sample', pageCount: 3, citationCount: 24, version: 'sha256-test' }));
      return;
    }
    if (path.startsWith('/ask/page/')) {
      if (mode === 'broken-image') {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(await readFile(join(PROJECT_ROOT, 'src/citations/generated/pages/page-01.png')));
      return;
    }
    if (path === '/ask/answer') {
      answered += 1;
      if (mode === 'slow') await new Promise((wait) => setTimeout(wait, 500));
      if (mode === 'overloaded') {
        response.writeHead(429, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ code: 'overloaded' }));
        return;
      }
      if (mode === 'flaky' && answered === 1) {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ code: 'retrieval_failed' }));
        return;
      }
      // 'mixed' alternates a tall answer with a one-line one, so anchoring cannot depend on length.
      const bare = { ...PAYLOAD, answer: 'Nothing here.', citations: [], pages: [] };
      const short = mode === 'no-citations' || (mode === 'mixed' && answered % 2 === 0);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(short ? bare : PAYLOAD));
      return;
    }
    response.writeHead(404);
    response.end();
  });

  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}/ask`;
}

/** Minimal CDP driver: Node ships a WebSocket client, so no browser automation dependency is needed. */
async function open(url: string) {
  const profile = await mkdtemp(join(tmpdir(), 'resume-bot-chrome-'));
  browserProfiles.push(profile);
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-sandbox',
    '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1024,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  browsers.push(chrome);

  const endpoint = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('chrome did not report a debugging port')), 20000);
    chrome.stderr!.on('data', (chunk: Buffer) => {
      const found = /ws:\/\/[^\s]+/.exec(chunk.toString());
      if (found) {
        clearTimeout(timer);
        resolve(found[0]);
      }
    });
  });

  const socket = new WebSocket(endpoint);
  await new Promise<void>((ready) => socket.addEventListener('open', () => ready(), { once: true }));

  let id = 0;
  const pending = new Map<number, (value: any) => void>();
  socket.addEventListener('message', (event: any) => {
    const message = JSON.parse(String(event.data));
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
  });

  const send = (method: string, params: unknown = {}, sessionId?: string) =>
    new Promise<any>((resolve) => {
      const next = ++id;
      pending.set(next, resolve);
      socket.send(JSON.stringify({ id: next, method, params, sessionId }));
    });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

  const evaluate = async (expression: string) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    return result?.result?.value;
  };

  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  // A short viewport, so a couple of exchanges genuinely overflow and scrolling behaviour matters.
  await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 600, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send('Page.navigate', { url }, sessionId);

  // Wait for something app.js builds, not for markup the parser already produced: the input exists
  // before the script has attached its listeners.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate('document.querySelectorAll("#suggestions button").length > 0')) break;
    await new Promise((wait) => setTimeout(wait, 100));
  }

  const setViewport = (width: number, height: number) =>
    send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true }, sessionId);

  return { evaluate, setViewport };
}

async function settle(evaluate: (expression: string) => Promise<any>, expression: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate(expression)) return true;
    await new Promise((wait) => setTimeout(wait, 100));
  }
  return false;
}

test('the answer renders hostile model text as text and places highlights on the right axis', { skip: !available }, async () => {
  const { evaluate } = await open(await serve('ok'));

  await evaluate('window.__errors = []; window.addEventListener("error", (e) => window.__errors.push(String(e.message)));');
  await evaluate('document.getElementById("question").value = "anything"; document.getElementById("form").requestSubmit();');

  const rendered = await settle(evaluate, 'document.querySelector(".cite") !== null');
  if (!rendered) {
    const diag = await evaluate('JSON.stringify({ text: document.body.innerText, errors: window.__errors })');
    assert.fail('a citation card must render — ' + String(diag));
  }

  assert.equal(await evaluate('window.__pwned === 1'), false, 'model text must never execute');
  assert.equal(await evaluate('document.querySelector(".answer script, .answer img") !== null'), false);
  assert.ok(String(await evaluate('document.querySelector(".answer").textContent')).includes('<script>'));
  assert.equal(await evaluate('document.querySelectorAll(".marker").length'), 1, 'only [1] becomes a control');

  // A 0.05-high rect on a 612x792 page must be ~5% of the crop's height, not of its width.
  const ratio = await evaluate(`(() => {
    const clip = document.querySelector('.clip').getBoundingClientRect();
    const hl = document.querySelector('.hl').getBoundingClientRect();
    return { w: hl.width / clip.width, h: hl.height / clip.height, aspect: clip.height / clip.width };
  })()`);

  // Crop spans 0.5 + 2*0.012 wide and 0.05 + 2*0.016 high of a page that is 792/612 tall.
  const cropW = 0.5 + 0.024;
  const cropH = 0.05 + 0.032;
  assert.ok(Math.abs(ratio.w - 0.5 / cropW) < 0.02, `highlight width ratio was ${ratio.w}`);
  assert.ok(Math.abs(ratio.h - 0.05 / cropH) < 0.05, `highlight height ratio was ${ratio.h}`);
  assert.ok(Math.abs(ratio.aspect - (cropH / cropW) * (792 / 612)) < 0.05, `crop aspect was ${ratio.aspect}`);
});

test('an unavailable document disables asking rather than failing on submit', { skip: !available }, async () => {
  const { evaluate } = await open(await serve('no-document'));
  assert.ok(await settle(evaluate, 'document.getElementById("question").disabled === true'));
  assert.match(String(await evaluate('document.getElementById("doc").textContent')), /unavailable/i);
});

test('loading state and composer controls remain accessible on mobile', { skip: !available }, async () => {
  const { evaluate, setViewport } = await open(await serve('slow'));
  await setViewport(390, 844);
  await evaluate('document.getElementById("question").value = "x"; document.getElementById("form").requestSubmit();');

  assert.ok(await settle(evaluate, 'document.querySelector(".thinking") !== null'));
  assert.equal(await evaluate('document.querySelector(".thinking").getAttribute("role")'), 'status');
  assert.match(String(await evaluate('document.querySelector(".thinking").textContent')), /searching/i);

  const controls = await evaluate(`(() => {
    const button = document.getElementById('submit').getBoundingClientRect();
    document.getElementById('question').focus();
    return { width: button.width, height: button.height, focus: getComputedStyle(document.querySelector('.composer')).boxShadow };
  })()`);
  assert.ok(controls.width >= 44 && controls.height >= 44, `send target was ${controls.width}x${controls.height}`);
  assert.notEqual(controls.focus, 'none', 'the composer must show a visible focus ring');
});

test('an answer with no citations says so instead of showing an empty evidence list', { skip: !available }, async () => {
  const { evaluate } = await open(await serve('no-citations'));
  await evaluate('document.getElementById("question").value = "x"; document.getElementById("form").requestSubmit();');

  assert.ok(await settle(evaluate, 'document.querySelector(".note") !== null'));
  assert.equal(await evaluate('document.querySelectorAll(".cite").length'), 0);
  assert.equal(await evaluate('document.querySelector(".sources") !== null'), false);
});

test('a page image that fails to load reports itself instead of leaving a blank crop', { skip: !available }, async () => {
  const { evaluate } = await open(await serve('broken-image'));
  await evaluate('document.getElementById("question").value = "x"; document.getElementById("form").requestSubmit();');

  assert.ok(await settle(evaluate, 'document.querySelector(".clip-failed") !== null'), 'the clip must mark itself failed');
});

test('an overloaded answer remains a controlled retryable failure', { skip: !available }, async () => {
  const { evaluate } = await open(await serve('overloaded'));
  await evaluate('document.getElementById("question").value = "x"; document.getElementById("form").requestSubmit();');

  assert.ok(await settle(evaluate, 'document.querySelector(".error") !== null'));
  assert.match(String(await evaluate('document.querySelector(".error").textContent')), /too many questions/i);
  assert.equal(await evaluate('document.querySelector(".error button").textContent'), 'Try again');
});

test('retrying a failed answer reuses its turn instead of repeating the question', { skip: !available }, async () => {
  const { evaluate } = await open(await serve('flaky'));
  await evaluate('document.getElementById("question").value = "only asked once"; document.getElementById("form").requestSubmit();');

  assert.ok(await settle(evaluate, 'document.querySelector(".error") !== null'), 'the first attempt must fail');
  assert.equal(await evaluate('document.querySelectorAll(".turn-user").length'), 1);

  await evaluate('document.querySelector(".error button").click();');
  assert.ok(await settle(evaluate, 'document.querySelector(".cite") !== null'), 'the retry must succeed in place');

  assert.equal(await evaluate('document.querySelectorAll(".turn-user").length'), 1, 'retry must not repeat the question');
  assert.equal(await evaluate('document.querySelectorAll(".error").length'), 0, 'the failure must be replaced');
});

test('each new answer stays on screen instead of scrolling past it', { skip: !available }, async () => {
  const { evaluate } = await open(await serve('mixed'));
  const tops: number[] = [];

  for (let turn = 1; turn <= 3; turn += 1) {
    await evaluate(`document.getElementById("question").value = "Question ${turn}"; document.getElementById("form").requestSubmit();`);
    assert.ok(
      await settle(evaluate, `document.querySelectorAll(".turn").length >= ${turn * 2} && !document.getElementById("submit").disabled`),
      `turn ${turn} must complete`,
    );

    // Scrolling is smooth, so wait for the position to stop moving before measuring.
    let previous = -1;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const now = await evaluate('Math.round(document.getElementById("thread").scrollTop)');
      if (now === previous) break;
      previous = now;
      await new Promise((wait) => setTimeout(wait, 100));
    }

    // Evidence crops are tall; scrolling to the bottom of them would push the answer off the top.
    const placement = await evaluate(`(() => {
      const turns = [...document.querySelectorAll('.turn-user')];
      const box = turns[turns.length - 1].getBoundingClientRect();
      return { top: Math.round(box.top), viewport: innerHeight };
    })()`);

    assert.ok(placement.top >= 0, `turn ${turn} scrolled above the viewport (top ${placement.top})`);
    assert.ok(placement.top < placement.viewport, `turn ${turn} is below the fold (top ${placement.top})`);
    tops.push(placement.top);
  }

  // Long and short answers alternate, so a stable resting position proves the reserved space works.
  const spread = Math.max(...tops) - Math.min(...tops);
  assert.ok(spread <= 24, `each question should settle in the same place, saw ${JSON.stringify(tops)}`);
});
