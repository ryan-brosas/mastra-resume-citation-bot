const form = document.getElementById('form');
const input = document.getElementById('question');
const submit = document.getElementById('submit');
const thread = document.getElementById('thread');
const stream = document.getElementById('stream');
const welcome = document.getElementById('welcome');
const suggestions = document.getElementById('suggestions');
const docBar = document.getElementById('doc');

const PAD_X = 0.012, PAD_Y = 0.016;
const HISTORY_TURNS = 6;
let turnCount = 0;

/** Sent with each question so a follow-up like "what else?" can be resolved against what came before. */
const history = [];

/**
 * Keeps enough room below the newest exchange that its question can always be scrolled to the top.
 * Without it the anchor clamps at the end of the thread and each answer settles somewhere different.
 */
const spacer = el('div');
let newest = null;

function reserve() {
  if (newest === null) return;
  const used = newest.user.offsetHeight + newest.bot.offsetHeight;
  spacer.style.height = Math.max(0, thread.clientHeight - used - 24) + 'px';
}

const watcher = new ResizeObserver(() => reserve());
addEventListener('resize', reserve);

const FAILURES = {
  invalid_question: ['That question was too long or too short.', 'Keep it under 1000 characters.'],
  unresolved_followup: ["That follow-up could not be tied to the conversation.", 'Ask it as a full question.'],
  manifest_unavailable: ["The résumé isn't loaded.", 'Rebuild it and try again.'],
  retrieval_failed: ["Couldn't search the résumé just now.", 'Try again in a moment.'],
  model_failed: ['No answer came back.', 'Nothing is shown rather than something unchecked.'],
};

const STARTERS = [
  'Where has Ryan worked?',
  'What did he do at Bluelogic?',
  'Which tools does he use for outreach?',
  'What is he working on next?',
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Anchor the question near the top rather than jumping to the bottom: evidence crops are tall, so
 * scrolling to the end leaves the answer above the viewport and the thread looks stuck.
 */
function anchorTo(turn) {
  reserve();
  const offset = turn.getBoundingClientRect().top - thread.getBoundingClientRect().top + thread.scrollTop;
  thread.scrollTop = Math.max(0, offset - 12);
}

async function loadDocument() {
  try {
    const response = await fetch('ask/document');
    const data = await response.json();
    if (!response.ok) throw new Error(data.code || response.status);
    docBar.textContent = data.pageCount + (data.pageCount === 1 ? ' page' : ' pages');
  } catch {
    docBar.textContent = 'résumé unavailable';
    input.disabled = submit.disabled = true;
  }
}

function clipFor(citation, page) {
  const rects = citation.rects;
  const bx = Math.max(0, Math.min(...rects.map(r => r.x)) - PAD_X);
  const by = Math.max(0, Math.min(...rects.map(r => r.y)) - PAD_Y);
  const bw = Math.min(1 - bx, Math.max(...rects.map(r => r.x + r.width)) + PAD_X - bx);
  const bh = Math.min(1 - by, Math.max(...rects.map(r => r.y + r.height)) + PAD_Y - by);

  // Horizontal percentages resolve against the clip's width; vertical ones resolve against its
  // height, which padding-bottom already derived from the aspect. So vertical values divide by bh.
  const aspect = page.heightPoints / page.widthPoints;
  const pct = (v) => (v * 100).toFixed(4) + '%';

  const clip = el('div', 'clip');
  clip.style.paddingBottom = pct((bh / bw) * aspect);

  const img = document.createElement('img');
  img.src = page.image;
  img.alt = 'Page ' + citation.page + ' of the source document';
  img.loading = 'lazy';
  img.style.width = pct(1 / bw);
  img.style.left = pct(-bx / bw);
  img.style.top = pct(-by / bh);
  img.addEventListener('error', () => { clip.classList.add('clip-failed'); });
  clip.append(img);

  rects.forEach((r, rectIndex) => {
    const hl = el('div', 'hl');
    hl.style.left = pct((r.x - bx) / bw);
    hl.style.width = pct(r.width / bw);
    hl.style.top = pct((r.y - by) / bh);
    hl.style.height = pct(r.height / bh);
    hl.style.animationDelay = (rectIndex * 60) + 'ms';
    clip.append(hl);

    if (rectIndex === 0) {
      const badge = el('div', 'hl-badge', 'page ' + citation.page);
      badge.style.left = pct((r.x - bx) / bw);
      const relativeTop = (r.y - by) / bh;
      // Sit above the box normally, but tuck inside when the crop leaves no room overhead.
      badge.style.top = pct(relativeTop);
      if (relativeTop < 0.08) badge.style.transform = 'translateY(0)';
      clip.append(badge);
    }
  });

  return clip;
}

function reveal(id) {
  const card = document.getElementById(id);
  if (!card) return;
  card.scrollIntoView({ block: 'center' });
  card.classList.remove('flash');
  void card.offsetWidth;
  card.classList.add('flash');
}

/** Model output is never trusted as markup: text lands as text, and only [n] becomes an element. */
function answerBody(text, citationCount, turn) {
  const body = el('p', 'answer');

  for (const part of text.split(/(\[\d+\])/)) {
    const label = /^\[(\d+)\]$/.exec(part);
    if (label && Number(label[1]) <= citationCount) {
      const marker = el('button', 'marker', label[1]);
      marker.type = 'button';
      marker.setAttribute('aria-label', 'Show evidence ' + label[1]);
      marker.addEventListener('click', () => reveal('cite-' + turn + '-' + label[1]));
      body.append(marker);
    } else {
      body.append(document.createTextNode(part));
    }
  }
  return body;
}

function citationCard(citation, label, page, turn, order) {
  const card = el('article', 'cite');
  card.id = 'cite-' + turn + '-' + label;
  card.style.animationDelay = (order * 70) + 'ms';

  card.dataset.citation = citation.id;
  card.append(el('div', 'cite-head', label + ' · page ' + citation.page));

  if (page && citation.rects && citation.rects.length) card.append(clipFor(citation, page));
  card.append(el('div', 'quote', citation.quote));

  if (citation.quote !== citation.excerpt) {
    const full = el('details', 'full');
    full.append(el('summary', null, 'full quoted passage'), el('div', null, citation.excerpt));
    card.append(full);
  }
  return card;
}

function addUserTurn(question) {
  const turn = el('div', 'turn turn-user');
  turn.append(el('div', 'bubble', question));
  stream.insertBefore(turn, spacer);
  return turn;
}

/** Every assistant turn owns one container, so a reply — or a retry — replaces its contents in place. */
function addBotTurn(user) {
  const turn = el('div', 'turn');
  const body = el('div');
  turn.append(body);
  stream.insertBefore(turn, spacer);

  watcher.disconnect();
  newest = { user, bot: turn };
  watcher.observe(turn);
  return body;
}

function renderAnswer(body, data, turn) {
  const parts = [answerBody(data.answer, data.citations.length, turn)];

  if (data.citations.length === 0) {
    parts.push(el('p', 'note', "The résumé doesn't cover that."));
  } else {
    parts.push(el('h2', 'sources', data.citations.length === 1 ? 'Source' : 'Sources'));
    const pages = new Map(data.pages.map((page) => [page.page, page]));
    data.citations.forEach((citation, index) => {
      parts.push(citationCard(citation, String(index + 1), pages.get(citation.page), turn, index));
    });
  }

  if (data.unsupported && data.unsupported.length > 0) {
    parts.push(el('p', 'note', 'Figures the résumé does not contain were left uncited: ' + data.unsupported.join(', ') + '.'));
  }

  body.replaceChildren(...parts);
}

/** Copy is always looked up, never derived: no caller can put arbitrary text on the page. */
function renderFailure(body, code, again) {
  const [headline, detail] = FAILURES[code] || ['Something went wrong.', 'Try again in a moment.'];
  const box = el('div', 'error');
  const retry = el('button', null, 'Try again');
  retry.type = 'button';
  retry.addEventListener('click', again);
  box.append(el('p', null, headline), el('p', 'fine', detail), retry);
  body.replaceChildren(box);
}

/** Retrying re-runs into the same turn, so a failure never leaves a duplicate question behind. */
async function run(body, question, turn, anchor, prior) {
  const thinking = el('div', 'thinking');
  thinking.append(el('span'), el('span'), el('span'));
  body.replaceChildren(thinking);
  anchorTo(anchor);

  submit.disabled = true;
  stream.setAttribute('aria-busy', 'true');

  try {
    const response = await fetch('ask/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, history: prior }),
    });
    const data = await response.json();
    if (response.ok) {
      renderAnswer(body, data, turn);
      history.push({ question, answer: data.answer });
      if (history.length > HISTORY_TURNS) history.shift();
    } else {
      renderFailure(body, data.code, () => run(body, question, turn, anchor, prior));
    }
  } catch {
    // A transport or parse failure reads the same to a reader: no checked answer arrived.
    renderFailure(body, 'model_failed', () => run(body, question, turn, anchor, prior));
  } finally {
    anchorTo(anchor);
    submit.disabled = false;
    stream.setAttribute('aria-busy', 'false');
    input.focus();
  }
}

function ask(question) {
  welcome?.remove();
  const anchor = addUserTurn(question);
  // Snapshot the history now, so a retry sends what preceded the question rather than later turns.
  run(addBotTurn(anchor), question, ++turnCount, anchor, [...history]);
}

function grow() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 176) + 'px';
}

function send() {
  const question = input.value.trim();
  if (!question || submit.disabled) return;
  input.value = '';
  grow();
  ask(question);
}

stream.append(spacer);

for (const text of STARTERS) {
  const button = el('button', null, text);
  button.type = 'button';
  button.addEventListener('click', () => { input.value = text; send(); });
  suggestions.append(button);
}

form.addEventListener('submit', (event) => { event.preventDefault(); send(); });
input.addEventListener('input', grow);

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === '/' && document.activeElement !== input) {
    event.preventDefault();
    input.focus();
  } else if (event.key === 'Escape' && document.activeElement === input) {
    input.value = '';
    grow();
  }
});

loadDocument();
