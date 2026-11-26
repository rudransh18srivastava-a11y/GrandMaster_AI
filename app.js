/* ==========================================================================
   GRANDMASTER AI — app.js
   Wires everything together: position timeline, board, clocks, engine, panels.

   Rules of the house:
   • The user always moves the pieces. Nothing here ever plays a move.
   • Every score and every candidate move comes from a Stockfish "info" line.
   • Clock time never touches an engine score; it is shown separately.
   ========================================================================== */

import * as core from './core.js';
import { pieceSvg } from './pieces.js';
import { BoardView } from './board.js';
import { loadChessJs, createRules } from './rules.js';
import { StockfishEngine } from './engine.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const now = () => performance.now();
const { sqName, sqIndex } = core;

const store = {
  get(k, d) { try { const v = localStorage.getItem('gmai.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('gmai.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const DEFAULTS = {
  theme: null, auto: true, depth: 0, time: 5, showArrows: true, incAlways: false,
  tc: { h: 0, m: 5, s: 0, inc: 0 },
};
const RANK_COLORS = ['#1e9e5a', '#2f6fed', '#d98a00', '#8b5cf6'];

/* ----------------------------------------------------------------- state -- */

const S = {
  timeline: [], idx: 0,
  orientation: 'w',
  selected: null, targets: new Map(), wasSelected: false,
  focusRank: null,
  setup: null,
  promo: null,
  settings: { ...DEFAULTS, ...store.get('settings', {}), tc: { ...DEFAULTS.tc, ...(store.get('settings', {}).tc || {}) } },
  analysis: { status: 'idle', snapshot: null },
  ctx: null,
  engineError: null,
  editing: { w: false, b: false },
};

let rules = null;
let view = null;
const clock = new core.Clock({
  initialMs: (S.settings.tc.h * 3600 + S.settings.tc.m * 60 + S.settings.tc.s) * 1000 || 300000,
  incMs: S.settings.tc.inc * 1000,
});
const engine = new StockfishEngine({
  onStatus: (text, kind) => setPill(text, kind),
  onSnapshot: (snap) => onSnapshot(snap),
  onSearchEnd: (info) => onSearchEnd(info),
  onError: (msg) => { S.engineError = msg; S.analysis.status = 'idle'; setPill('Engine error', 'err'); renderStatus(); renderControls(); },
});

const saveSettings = () => store.set('settings', S.settings);
const curFen = () => S.timeline[S.idx].fen;

/* ------------------------------------------------------ position context -- */

const ctxCache = new Map();
function ctxFor(fen) {
  let c = ctxCache.get(fen);
  if (c) return c;
  const parsed = core.parseFen(fen);
  const moves = rules.legalMoves(fen);
  const status = rules.status(fen);
  const hanging = core.hangingPieces(parsed.board);
  c = {
    fen, parsed, moves, status,
    material: core.materialCount(parsed.board),
    hangingCount: hanging.w.length + hanging.b.length,
    tactical: core.tacticalComplexity({
      captures: moves.filter((m) => m.captured).length,
      checks: moves.filter((m) => /[+#]/.test(m.san)).length,
      hanging: hanging.w.length + hanging.b.length,
      inCheck: status.check,
      legalCount: moves.length,
    }),
  };
  if (ctxCache.size > 300) ctxCache.clear();
  ctxCache.set(fen, c);
  return c;
}

function repetitions() {
  const key = core.fenKey(curFen());
  return S.timeline.slice(0, S.idx + 1).filter((e) => core.fenKey(e.fen) === key).length;
}

function outcome() {
  const c = S.ctx;
  if (c.status.checkmate) return { text: `Checkmate — ${c.parsed.turn === 'w' ? 'Black' : 'White'} wins`, kind: 'mate' };
  if (c.status.stalemate) return { text: 'Stalemate — draw', kind: 'draw' };
  if (c.status.insufficient) return { text: 'Draw — insufficient material', kind: 'draw' };
  return null;
}

/* ------------------------------------------------------ timeline changes -- */

function loadPosition(fen, reason) {
  S.timeline = [{ fen, san: null }];
  S.idx = 0;
  positionChanged(reason);
}

function commitMove(from, to, promotion) {
  const fen = curFen();
  const r = rules.tryMove(fen, sqName(from), sqName(to), promotion);
  if (!r.ok) return false;
  const before = S.ctx.parsed;
  S.timeline.length = S.idx + 1;
  S.timeline.push({
    fen: r.fen, san: r.move.san, from: r.move.from, to: r.move.to,
    color: before.turn, number: before.fullmove, uci: r.move.from + r.move.to + (r.move.promotion || ''),
  });
  S.idx += 1;
  clock.move(before.turn, now(), { force: S.settings.incAlways });
  positionChanged('move');
  return true;
}

function jumpTo(i) {
  if (S.setup || i < 0 || i >= S.timeline.length || i === S.idx) return;
  S.idx = i;
  positionChanged('jump');
}
const undo = () => jumpTo(S.idx - 1);
const redo = () => jumpTo(S.idx + 1);

function positionChanged(reason) {
  S.ctx = ctxFor(curFen());
  S.selected = null;
  S.targets = new Map();
  S.focusRank = null;
  S.promo = null;
  closePromo();
  if (reason !== 'move') clock.syncTurn(S.ctx.parsed.turn, now());
  if ((S.ctx.status.checkmate || S.ctx.status.stalemate) && clock.status === 'running') clock.pause(now());
  store.set('lastFen', curFen());

  // results belong to the previous position: drop them, and stop the old search
  S.analysis.snapshot = null;
  if (engine.busy) engine.stop();
  if (S.analysis.status !== 'paused') S.analysis.status = 'idle';

  renderAll();
  scheduleAnalysis();
}

/* ------------------------------------------------------------- analysis -- */

let analysisTimer = null;
function scheduleAnalysis() {
  clearTimeout(analysisTimer);
  analysisTimer = setTimeout(() => {
    if (S.setup || !engine.ready || S.analysis.status === 'paused' || !S.settings.auto) return;
    if (S.analysis.status === 'running') return;
    startAnalysis();
  }, 180);
}

function limits() {
  return {
    depth: S.settings.depth > 0 ? S.settings.depth : null,
    movetimeMs: S.settings.time > 0 ? S.settings.time * 1000 : null,
  };
}

function startAnalysis() {
  if (!engine.ready || S.setup) return;
  const ctx = S.ctx;
  S.analysis.snapshot = null;
  if (ctx.moves.length === 0) {
    S.analysis.status = 'done';
    renderAnalysis();
    return;
  }
  S.analysis.status = 'running';
  const l = limits();
  engine.analyze({ fen: ctx.fen, turn: ctx.parsed.turn, depth: l.depth, movetimeMs: l.movetimeMs, legalCount: ctx.moves.length });
  renderAnalysis();
}

function pauseAnalysis() {
  if (S.analysis.status !== 'running') return;
  engine.stop();
  S.analysis.status = 'paused';
  renderAnalysis();
}

function resumeAnalysis() {
  if (S.analysis.status !== 'paused') return;
  startAnalysis();
}

function stopAnalysis() {
  if (S.analysis.status !== 'running' && S.analysis.status !== 'paused') return;
  engine.stop();
  S.analysis.status = 'stopped';
  renderAnalysis();
}

function onSnapshot(snap) {
  if (S.analysis.status !== 'running' || !S.ctx || snap.fen !== S.ctx.fen) return;
  const enriched = enrich(snap);
  if (!enriched) return;
  S.analysis.snapshot = enriched;
  renderAnalysis();
}

function onSearchEnd({ reason }) {
  if (reason === 'complete' && S.analysis.status === 'running') {
    S.analysis.status = 'done';
    renderAnalysis();
  }
}

/** Turn a raw engine snapshot into display data. Lines that cannot be replayed are dropped, never invented. */
function enrich(snap) {
  const ctx = S.ctx;
  const mover = ctx.parsed.turn;
  const sign = mover === 'w' ? 1 : -1;
  const homeRank = mover === 'w' ? '1' : '8';
  const raw = [];
  for (const l of snap.lines) {
    const played = rules.playLine(ctx.fen, l.pv, 14);
    if (!played.length) continue;
    raw.push({ l, played });
  }
  const cps = raw.map((r) => core.scoreToCp(r.l.score));
  const lines = raw.map(({ l, played }, i) => {
    const first = played[0];
    const evenPlies = played.length - (played.length % 2);
    let net = 0;
    if (evenPlies >= 2) {
      const after = core.parseFen(played[evenPlies - 1].fen).board;
      net = (core.materialCount(after).diff - ctx.material.diff) * sign;
    }
    // does the moved piece now attack something valuable / loose?
    let threat = null;
    if (!first.move.captured && !/[+#]/.test(first.san)) {
      const boardAfter = core.parseFen(first.fen).board;
      const toIdx = sqIndex(first.move.to);
      const movedType = first.move.piece.toUpperCase();
      let bestVal = 0;
      boardAfter.forEach((p, s) => {
        if (!p || p[0] === mover || p[1] === 'K') return;
        if (!core.attackersOf(boardAfter, s, mover).some((a) => a.idx === toIdx)) return;
        const defended = core.attackersOf(boardAfter, s, p[0]).length > 0;
        const val = core.PIECE_VALUES[p[1]];
        if ((!defended || val > core.PIECE_VALUES[movedType]) && val > bestVal) {
          bestVal = val;
          threat = { type: p[1], square: sqName(s) };
        }
      });
    }
    const explanation = core.explainCandidate({
      rank: i + 1, san: first.san, move: first.move, scoreMover: l.score,
      bestMover: cps[0], nextMover: i === 0 && cps[1] !== undefined ? cps[1] : null,
      pvNetMaterial: net, pvPlies: evenPlies, threat, fullmove: ctx.parsed.fullmove,
      startedFromHomeRank: first.move.from[1] === homeRank,
    });
    return {
      rank: i + 1, san: first.san, uci: first.uci, from: sqIndex(first.move.from), to: sqIndex(first.move.to),
      piece: mover + first.move.piece.toUpperCase(),
      scoreMover: l.score, scoreWhite: core.scoreToWhite(l.score, mover), cp: cps[i],
      depth: l.depth, seldepth: l.seldepth, played, explanation,
    };
  });
  if (!lines.length) return null;
  return { depth: snap.depth, seldepth: snap.seldepth, nodes: snap.nodes, nps: snap.nps, time: snap.time, hashfull: snap.hashfull, lines };
}

async function initEngine() {
  S.engineError = null;
  renderStatus();
  try {
    await engine.init();
    renderStatus();
    renderControls();
    scheduleAnalysis();
  } catch (err) {
    S.engineError = err.message;
    setPill('Engine unavailable', 'err');
    renderStatus();
    renderControls();
  }
}

/* ------------------------------------------------------------ rendering -- */

function setPill(text, kind) {
  const pill = $('#engine-pill');
  pill.className = `pill ${kind || ''}`;
  $('#engine-pill-text').textContent = text;
}

function renderAll() {
  renderBoard();
  renderToolbar();
  renderHistory();
  renderFenPanel();
  renderAnalysis();
  renderClockControls();
  renderTurnNote();
  renderSavedList();
}

function renderAnalysis() {
  renderEval();
  renderCandidates();
  renderArrows();
  renderPositionKv();
  renderStats();
  renderStatus();
  renderControls();
}

function renderBoard() {
  if (S.setup) {
    view.render({ board: S.setup.draft.board, orientation: S.orientation, selected: null, targets: null, last: null, checkIdx: -1 });
    view.setArrows([]);
    view.showBadge('');
    return;
  }
  const ctx = S.ctx;
  const e = S.timeline[S.idx];
  const last = S.idx > 0 ? { from: sqIndex(e.from), to: sqIndex(e.to) } : null;
  const checkIdx = ctx.status.check ? ctx.parsed.board.indexOf(ctx.parsed.turn + 'K') : -1;
  view.render({ board: ctx.parsed.board, orientation: S.orientation, selected: S.selected, targets: S.targets, last, checkIdx });
  const o = outcome();
  view.showBadge(o ? (o.kind === 'mate' ? 'Checkmate' : o.text.split(' — ')[0]) : '');
  $('#clock-w').style.order = S.orientation === 'w' ? 3 : 1;
  $('#clock-b').style.order = S.orientation === 'w' ? 1 : 3;
  $('#board-frame').style.order = 2;
  renderArrows();
}

function renderArrows() {
  const snap = S.analysis.snapshot;
  if (!view || S.setup || !snap || !S.settings.showArrows) { if (view) view.setArrows([]); return; }
  view.setArrows(snap.lines.map((l) => ({
    from: l.from, to: l.to, color: RANK_COLORS[l.rank - 1],
    opacity: S.focusRank ? (S.focusRank === l.rank ? 0.95 : 0.25) : l.rank === 1 ? 0.85 : 0.55,
    width: l.rank === 1 ? 0.2 : 0.15,
  })));
}

function renderToolbar() {
  $('#btn-undo').disabled = !!S.setup || S.idx === 0;
  $('#btn-redo').disabled = !!S.setup || S.idx >= S.timeline.length - 1;
  $('#btn-edit').classList.toggle('on', !!S.setup);
  $('#btn-edit').textContent = S.setup ? '✎ Editing…' : '✎ Edit position';
}

function renderTurnNote() {
  const el = $('#turn-note');
  if (S.setup) { el.textContent = 'Editing: arrange the pieces, set who is to move and castling rights, then press “Apply & analyse”.'; return; }
  const c = S.ctx;
  const o = outcome();
  const bits = [];
  if (o) bits.push(o.text);
  else {
    bits.push(`${c.parsed.turn === 'w' ? 'White' : 'Black'} to move${c.status.check ? ' — in check' : ''}`);
    if (c.parsed.halfmove >= 100) bits.push('50-move rule: a draw can be claimed');
    if (repetitions() >= 3) bits.push('threefold repetition: a draw can be claimed');
  }
  if (clock.flagged) bits.push(`${clock.flagged === 'w' ? 'White' : 'Black'}'s flag has fallen`);
  el.textContent = bits.join(' · ');
}

/* --- evaluation ---------------------------------------------------------- */

function renderEval() {
  const snap = S.analysis.snapshot;
  const bar = $('#evalbar');
  const num = $('#eval-num');
  const cls = $('#eval-class');
  const white = $('#evalbar-white');
  const labL = $('#lab-l');
  const labR = $('#lab-r');
  const win = $('#eval-win');
  const o = S.setup ? null : outcome();
  labL.textContent = '';
  labR.textContent = '';
  win.textContent = '';
  if (S.setup) {
    num.textContent = '—'; cls.textContent = 'Editing position'; bar.classList.add('stale');
    return;
  }
  if (o) {
    const whiteWins = o.kind === 'mate' && S.ctx.parsed.turn === 'b';
    const blackWins = o.kind === 'mate' && S.ctx.parsed.turn === 'w';
    white.style.width = `${whiteWins ? 100 : blackWins ? 0 : 50}%`;
    num.textContent = whiteWins ? '1–0' : blackWins ? '0–1' : '½–½';
    cls.textContent = o.text;
    bar.classList.remove('stale');
    return;
  }
  if (!snap) {
    num.textContent = '…';
    cls.textContent = engine.ready ? (S.analysis.status === 'running' ? 'Stockfish is thinking…' : 'No analysis for this position') : 'Waiting for engine';
    bar.classList.add('stale');
    return;
  }
  const best = snap.lines[0].scoreWhite;
  const pct = core.barPercent(best);
  white.style.width = `${pct}%`;
  bar.classList.remove('stale');
  const text = core.formatScore(best);
  num.textContent = text;
  const c = core.classifyEval(best);
  cls.textContent = c.label;
  (best.value >= 0 ? labL : labR).textContent = text;
  win.textContent = best.type === 'cp' ? `White win chance ≈ ${Math.round(core.winPercent(best.value))}%` : '';
}

function renderStats() {
  const snap = S.analysis.snapshot;
  const rows = [
    ['Depth', snap ? `${snap.depth}${snap.seldepth ? ' / ' + snap.seldepth : ''}` : '—'],
    ['Nodes', snap ? core.formatCount(snap.nodes) : '—'],
    ['Speed', snap ? core.formatCount(snap.nps) + ' n/s' : '—'],
    ['Time', snap ? (snap.time / 1000).toFixed(1) + ' s' : '—'],
    ['Hash', snap ? (snap.hashfull / 10).toFixed(1) + '%' : '—'],
    ['Lines', 'MultiPV 4'],
  ];
  $('#stats').innerHTML = rows.map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join('')
    + `<div class="stat" style="grid-column:1/-1"><div class="k">Engine</div><div class="v" title="${esc(engine.name)}">${esc(engine.label || engine.name || '—')}</div></div>`;
}

/* --- candidates ---------------------------------------------------------- */

function pvHtml(played) {
  return played.slice(0, 12).map((p, i) => {
    const num = p.color === 'w' ? `<span class="num">${p.number}.</span>` : i === 0 ? `<span class="num">${p.number}…</span>` : '';
    return `${num}${esc(p.san)}`;
  }).join(' ');
}

function renderCandidates() {
  const el = $('#cands');
  const ctx = S.ctx;
  if (S.setup) { el.innerHTML = '<div class="empty-msg">Finish editing the position to analyse it.</div>'; return; }
  const o = outcome();
  if (o) { el.innerHTML = `<div class="empty-msg"><strong>${esc(o.text)}</strong><br>There are no legal moves to recommend.</div>`; return; }
  const snap = S.analysis.snapshot;
  if (!snap) {
    let msg;
    if (S.engineError) msg = 'The engine is not available — see the status line below.';
    else if (!engine.ready) msg = 'Loading Stockfish…';
    else if (S.analysis.status === 'running') msg = 'Stockfish is analysing this position…';
    else if (S.analysis.status === 'paused') msg = 'Analysis paused. Press Resume to continue.';
    else msg = S.settings.auto ? 'Waiting to analyse…' : 'Manual mode: press Start to analyse this position.';
    el.innerHTML = `<div class="empty-msg">${esc(msg)}</div>`;
    return;
  }
  const html = snap.lines.map((l) => `
    <div class="cand${S.focusRank === l.rank ? ' focus' : ''}" data-rank="${l.rank}" tabindex="0" aria-label="Candidate ${l.rank}: ${esc(l.san)}">
      <div class="rank">${l.rank}</div>
      <div class="move">${pieceSvg(l.piece)}<span>${esc(l.san)}</span><span class="muted mono" style="font-size:12px;font-weight:500">${l.uci}</span></div>
      <div class="score" title="Stockfish score, White's point of view">${esc(core.formatScore(l.scoreWhite))}<small>depth ${l.depth}</small></div>
      <div class="pv">${pvHtml(l.played)}</div>
      <div class="why">${esc(l.explanation)}</div>
    </div>`).join('');
  const missing = ctx.moves.length < 4 ? `<div class="note">Only ${ctx.moves.length} legal move${ctx.moves.length === 1 ? '' : 's'} in this position.</div>` : '';
  el.innerHTML = html + missing;
}

/* --- position & time context --------------------------------------------- */

const kv = (k, v, title = '') => `<dt${title ? ` title="${esc(title)}"` : ''}>${k}</dt><dd>${v}</dd>`;
const badge = (level, text, title = '') => `<span class="badge l${level}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;

function renderPositionKv() {
  const ctx = S.ctx;
  const m = ctx.material;
  const snap = S.analysis.snapshot;
  let rows = kv('Material advantage', m.diff > 0 ? `White +${m.diff}` : m.diff < 0 ? `Black +${-m.diff}` : 'Equal', 'Pawn=1, minor=3, rook=5, queen=9');
  if (snap && snap.lines[0].scoreWhite.type === 'cp') {
    const positional = snap.lines[0].scoreWhite.value - m.diff * 100;
    const p = positional / 100;
    rows += kv('Positional advantage', Math.abs(p) < 0.25 ? 'Balanced' : `${p > 0 ? 'White' : 'Black'} ${p > 0 ? '+' : '−'}${Math.abs(p).toFixed(2)}`,
      'Stockfish evaluation minus raw material: activity, king safety, structure, initiative.');
  } else {
    rows += kv('Positional advantage', snap ? 'Decided by mate' : '—');
  }
  if (snap) {
    const mover = ctx.parsed.turn;
    const diff = core.positionDifficulty(snap.lines.map((l) => (mover === 'w' ? l.cp : l.cp)));
    rows += kv('Position difficulty', badge(diff.level, diff.label, diff.detail), diff.detail);
  } else rows += kv('Position difficulty', '—');
  rows += kv('Tactical complexity', badge(ctx.tactical.level, ctx.tactical.label, ctx.tactical.detail), ctx.tactical.detail);
  $('#kv-position').innerHTML = rows;

  const side = (col) => {
    const counts = m[col].counts;
    return ['Q', 'R', 'B', 'N', 'P'].map((t) => pieceSvg(col + t).repeat(counts[t])).join('') || '<span class="muted">—</span>';
  };
  $('#material').innerHTML = `
    <div style="display:flex;justify-content:space-between;font-size:13px"><span>White <strong>${m.w.points}</strong></span><span>Black <strong>${m.b.points}</strong></span></div>
    <div class="mat-row" style="margin-top:4px">${side('w')}</div>
    <div class="mat-row">${side('b')}</div>`;
}

let lastNotes = '';
function renderTimeKv() {
  const t = now();
  const w = clock.read('w', t);
  const b = clock.read('b', t);
  const adv = core.timeAdvantage(w, b);
  const pw = core.timePressure(w, clock.incMs);
  const pb = core.timePressure(b, clock.incMs);
  const fmtDiff = (ms) => core.formatClock(Math.round(ms / 1000) * 1000);
  $('#kv-time').innerHTML =
    kv('White time', `<span class="mono">${core.formatClock(w)}</span>`) +
    kv('Black time', `<span class="mono">${core.formatClock(b)}</span>`) +
    kv('Difference', `<span class="mono">${fmtDiff(Math.abs(w - b))}</span>${adv.leader ? ` <span class="muted">${adv.leader === 'w' ? 'White' : 'Black'}</span>` : ''}`) +
    kv('Increment', `<span class="mono">+${clock.incMs / 1000}s</span>`) +
    kv('Time advantage', esc(adv.label)) +
    kv('Time pressure W', badge(pw.level, pw.label, 'Counts the increment as a buffer of about 5 moves')) +
    kv('Time pressure B', badge(pb.level, pb.label, 'Counts the increment as a buffer of about 5 moves'));

  let notes = [];
  const snap = S.analysis.snapshot;
  if (snap && !S.setup) {
    const diff = core.positionDifficulty(snap.lines.map((l) => l.cp));
    notes = core.practicalNotes({ scoreWhite: snap.lines[0].scoreWhite, turn: S.ctx.parsed.turn, time: adv, pressure: { w: pw, b: pb }, difficulty: diff });
  }
  const html = notes.map((n) => `<li>${esc(n)}</li>`).join('');
  if (html !== lastNotes) { $('#practical-notes').innerHTML = html; lastNotes = html; }
}

/* --- history, FEN, saved --------------------------------------------------- */

function renderHistory() {
  const h = $('#history');
  const rootFen = S.timeline[0].fen;
  let html = `<div class="start">${rootFen === core.START_FEN ? 'Start position' : 'Custom start position'}</div>`;
  for (let i = 1; i < S.timeline.length; i++) {
    const e = S.timeline[i];
    if (e.color === 'w') html += `<span class="num">${e.number}.</span>`;
    else if (i === 1) html += `<span class="num">${e.number}…</span>`;
    html += `<button type="button" data-i="${i}" class="${i === S.idx ? 'cur' : ''}${i > S.idx ? ' future' : ''}">${esc(e.san)}</button>`;
  }
  if (S.timeline.length === 1) html += '<div class="muted" style="width:100%;font-size:13px">No moves yet — drag a piece or click a piece, then its destination.</div>';
  h.innerHTML = html;
  const cur = h.querySelector('.cur');
  if (cur) h.scrollTop = Math.max(0, cur.offsetTop - h.clientHeight / 2);
}

function renderFenPanel() {
  const c = S.ctx;
  $('#fen-current').value = curFen();
  const p = c.parsed;
  const reps = repetitions();
  const o = outcome();
  const items = [
    ['Side to move', p.turn === 'w' ? 'White' : 'Black'],
    ['Castling', p.castling || 'none'],
    ['En passant', p.ep],
    ['Halfmove clock', p.halfmove],
    ['Move number', p.fullmove],
    ['Legal moves', c.moves.length],
    ['Status', o ? o.text.split(' — ')[0] : c.status.check ? 'Check' : reps >= 3 ? 'Repetition ×3' : p.halfmove >= 100 ? '50-move rule' : 'Normal'],
  ];
  $('#fen-info').innerHTML = items.map(([k, v]) => `<div><span>${k}</span><br><strong>${esc(v)}</strong></div>`).join('');
}

function renderSavedList() {
  const list = store.get('positions', []);
  $('#saved').innerHTML = list.length
    ? list.map((p, i) => `<li><span class="name" title="${esc(p.fen)}">${esc(p.name)}</span><button class="btn small" data-load="${i}" type="button">Load</button><button class="btn small danger" data-del="${i}" type="button" aria-label="Delete ${esc(p.name)}">✕</button></li>`).join('')
    : '<li class="muted">No saved positions yet.</li>';
}

/* --- analysis controls ----------------------------------------------------- */

function renderStatus() {
  const el = $('#an-status');
  const a = S.analysis;
  el.classList.remove('err');
  if (S.engineError) {
    el.classList.add('err');
    el.innerHTML = `${esc(S.engineError)} <button class="btn small" id="btn-retry" type="button">Retry</button>`;
    return;
  }
  if (!engine.ready) { el.textContent = 'Starting Stockfish…'; return; }
  if (S.setup) { el.textContent = 'Editing position — analysis is held until you apply or cancel.'; return; }
  const o = outcome();
  if (o) { el.textContent = `${o.text}. Nothing to analyse.`; return; }
  const snap = a.snapshot;
  const l = limits();
  const lim = [l.depth ? `depth ${l.depth}` : null, l.movetimeMs ? `${l.movetimeMs / 1000}s` : null].filter(Boolean).join(' / ') || 'unlimited';
  switch (a.status) {
    case 'running': el.textContent = `Analysing… ${snap ? `depth ${snap.depth}` : 'starting'} (limit: ${lim})`; break;
    case 'paused': el.textContent = `Paused${snap ? ` at depth ${snap.depth}` : ''}. Press Resume to continue.`; break;
    case 'stopped': el.textContent = `Stopped${snap ? ` at depth ${snap.depth}` : ''}.`; break;
    case 'done': el.textContent = snap ? `Finished — depth ${snap.depth} reached.` : 'Finished.'; break;
    default: el.textContent = S.settings.auto ? 'Ready — analysis starts automatically.' : 'Ready — press Start to analyse this position.';
  }
}

function renderControls() {
  const a = S.analysis.status;
  const ready = engine.ready && !S.setup && S.ctx && S.ctx.moves.length > 0;
  $('#an-start').disabled = !ready || a === 'running';
  $('#an-pause').disabled = a !== 'running';
  $('#an-resume').disabled = a !== 'paused';
  $('#an-stop').disabled = a !== 'running' && a !== 'paused';
  $('#an-mode').value = S.settings.auto ? 'auto' : 'manual';
  $('#chk-arrows').checked = S.settings.showArrows;
}

/* ---------------------------------------------------------------- clocks -- */

function buildClocks() {
  for (const side of ['w', 'b']) {
    const name = side === 'w' ? 'White' : 'Black';
    $('#clock-' + side).innerHTML = `
      <div class="who"><span class="swatch"></span>${name}</div>
      <div>
        <button type="button" class="time" id="time-${side}" title="Click to type a new time (m:ss, h:mm:ss, 90, 5m)">0:00</button>
        <input type="text" class="time-edit hidden" id="edit-${side}" aria-label="Edit ${name} time" spellcheck="false" autocomplete="off">
      </div>
      <div class="adj">
        ${[[-60000, '−1m'], [-10000, '−10s'], [10000, '+10s'], [60000, '+1m']].map(([d, t]) => `<button type="button" class="btn small" data-side="${side}" data-adj="${d}" aria-label="${t} for ${name}">${t}</button>`).join('')}
      </div>
      <div class="meta"><span id="pr-${side}"></span><span id="st-${side}"></span></div>`;
    const btn = $('#time-' + side);
    const input = $('#edit-' + side);
    btn.addEventListener('click', () => {
      S.editing[side] = true;
      input.value = core.formatClock(Math.ceil(clock.read(side, now()) / 1000) * 1000);
      btn.classList.add('hidden');
      input.classList.remove('hidden');
      input.focus();
      input.select();
    });
    const finish = (commit) => {
      if (!S.editing[side]) return;
      S.editing[side] = false;
      if (commit) {
        const ms = core.parseTimeInput(input.value);
        if (ms !== null) { clock.set(side, ms, now()); renderTurnNote(); renderClockControls(); }
        else flash(input);
      }
      input.classList.add('hidden');
      btn.classList.remove('hidden');
      tickUI();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }
  $$('.adj .btn').forEach((b) => b.addEventListener('click', () => {
    clock.adjust(b.dataset.side, Number(b.dataset.adj), now());
    renderTurnNote(); renderClockControls(); tickUI();
  }));
}

function flash(el) {
  el.style.outline = '2px solid var(--bad)';
  setTimeout(() => { el.style.outline = ''; }, 600);
}

let lastClockSig = '';
function renderClockControls() {
  const st = clock.status;
  $('#clk-start').disabled = st !== 'stopped';
  $('#clk-pause').disabled = st !== 'running';
  $('#clk-resume').disabled = st !== 'paused';
  lastClockSig = `${st}|${clock.side}|${clock.flagged}`;
}

function tickUI() {
  const t = now();
  for (const side of ['w', 'b']) {
    const ms = clock.read(side, t);
    const el = $('#clock-' + side);
    if (!S.editing[side]) $('#time-' + side).textContent = core.formatClock(ms);
    el.classList.toggle('active', clock.status === 'running' && clock.side === side);
    el.classList.toggle('low', ms > 0 && ms <= 10000);
    el.classList.toggle('flagged', clock.flagged === side);
    const pr = core.timePressure(ms, clock.incMs);
    $('#pr-' + side).textContent = `Time pressure: ${pr.label}`;
    $('#st-' + side).textContent = clock.flagged === side ? 'Flag fell' : clock.status === 'running' && clock.side === side ? 'running' : clock.status === 'paused' && clock.side === side ? 'paused' : `+${clock.incMs / 1000}s / move`;
  }
  const sig = `${clock.status}|${clock.side}|${clock.flagged}`;
  if (sig !== lastClockSig) { renderClockControls(); renderTurnNote(); }
  renderTimeKv();
}

function syncPresetSelect() {
  const { h, m, s, inc } = S.settings.tc;
  const total = h * 3600 + m * 60 + s;
  const hit = core.TIME_PRESETS.find((p) => p.minutes * 60 === total && p.inc === inc);
  $('#tc-preset').value = hit ? hit.id : 'custom';
}

function applyTimeControl(resetClocks) {
  const tc = S.settings.tc;
  const ms = (tc.h * 3600 + tc.m * 60 + tc.s) * 1000;
  clock.setIncrement(tc.inc * 1000);
  if (resetClocks && ms > 0) clock.setBase(ms);
  saveSettings();
  renderClockControls();
  renderTurnNote();
  tickUI();
}

function readTcFields() {
  const n = (id, max) => Math.min(max, Math.max(0, Math.floor(Number($(id).value) || 0)));
  S.settings.tc = { h: n('#tc-h', 99), m: n('#tc-m', 999), s: n('#tc-s', 59), inc: n('#tc-inc', 600) };
}

function writeTcFields() {
  const tc = S.settings.tc;
  $('#tc-h').value = tc.h; $('#tc-m').value = tc.m; $('#tc-s').value = tc.s; $('#tc-inc').value = tc.inc;
}

/* ---------------------------------------------------- moving on the board -- */

function playDown(idx) {
  if (S.promo) return {};
  const ctx = S.ctx;
  if (S.selected !== null && S.targets.has(idx)) { attemptMove(S.selected, idx); return {}; }
  const p = ctx.parsed.board[idx];
  if (p && p[0] === ctx.parsed.turn) {
    S.wasSelected = S.selected === idx;
    select(idx);
    return { drag: p };
  }
  if (S.selected !== null) deselect();
  return {};
}

function playUp({ from, to, moved }) {
  if (S.promo) return;
  if (!moved) {
    if (S.wasSelected && S.selected === from) deselect();
    return;
  }
  if (to === null || to === from) return;
  if (S.selected === from && S.targets.has(to)) attemptMove(from, to);
  else deselect();
}

function select(idx) {
  const ctx = S.ctx;
  S.selected = idx;
  S.targets = new Map(ctx.moves.filter((m) => m.from === sqName(idx)).map((m) => [sqIndex(m.to), !!m.captured]));
  renderBoard();
}

function deselect() {
  S.selected = null;
  S.targets = new Map();
  renderBoard();
}

function attemptMove(from, to) {
  const matches = S.ctx.moves.filter((m) => m.from === sqName(from) && m.to === sqName(to));
  if (!matches.length) { deselect(); return; }
  if (matches.some((m) => m.promotion)) { openPromo(from, to, S.ctx.parsed.turn); return; }
  commitMove(from, to);
}

function openPromo(from, to, color) {
  S.promo = { from, to };
  closePromo();
  const wrap = document.createElement('div');
  wrap.className = 'promo';
  wrap.id = 'promo';
  wrap.innerHTML = `<div class="promo-box" role="dialog" aria-label="Choose promotion piece">${['Q', 'R', 'B', 'N'].map((t) => `<button type="button" data-p="${t.toLowerCase()}" aria-label="Promote to ${core.PIECE_NAMES[t]}">${pieceSvg(color + t)}</button>`).join('')}</div>`;
  wrap.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('button[data-p]');
    e.stopPropagation();
    if (b) {
      const { from: f, to: t } = S.promo;
      S.promo = null;
      closePromo();
      commitMove(f, t, b.dataset.p);
    } else if (e.target === wrap) {
      S.promo = null;
      closePromo();
      deselect();
    }
  });
  $('#board-frame').appendChild(wrap);
}

function closePromo() {
  const p = $('#promo');
  if (p) p.remove();
}

/* ------------------------------------------------------- position editor -- */

const PIECES = ['K', 'Q', 'R', 'B', 'N', 'P'];

function buildPalette() {
  for (const col of ['w', 'b']) {
    const host = $('#palette-' + col);
    host.innerHTML = PIECES.map((t, i) => `<button type="button" data-p="${col + t}" class="${i % 2 ? 'dark-sq' : ''}" aria-label="${col === 'w' ? 'White' : 'Black'} ${core.PIECE_NAMES[t]}">${pieceSvg(col + t)}</button>`).join('');
  }
  $$('.palette button').forEach((b) => {
    b.addEventListener('pointerdown', (e) => {
      if (!S.setup || (e.pointerType === 'mouse' && e.button !== 0)) return;
      e.preventDefault();
      view.beginExternalDrag(b.dataset.p, e, (idx) => {
        if (idx === null || !S.setup) return;
        S.setup.draft.board[idx] = b.dataset.p;
        afterSetupEdit();
      });
    });
    b.addEventListener('click', () => { if (S.setup) { S.setup.tool = b.dataset.p; renderSetupTools(); } });
  });
}

function renderSetupTools() {
  if (!S.setup) return;
  $$('.palette button').forEach((b) => b.classList.toggle('sel', b.dataset.p === S.setup.tool));
  $('#tool-move').classList.toggle('on', S.setup.tool === 'move');
  $('#tool-erase').classList.toggle('on', S.setup.tool === 'erase');
}

function enterSetup(state) {
  if (engine.busy) engine.stop();
  if (clock.status === 'running') clock.pause(now());
  S.analysis.snapshot = null;
  if (S.analysis.status !== 'paused') S.analysis.status = 'idle';
  S.selected = null; S.targets = new Map();
  closePromo();
  S.setup = { draft: { ...state, board: [...state.board] }, tool: 'move' };
  placeSetupCard();
  $('#card-setup').classList.remove('hidden');
  writeSetupFields();
  renderSetupTools();
  setMsg('#setup-msg', '', '');
  renderAll();
  // narrow screens: keep the board at the top so board and palette are visible together
  if (!window.matchMedia('(min-width: 921px)').matches) $('#board-frame').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Wide layout: editor sits beside the board (top of the right column). Narrow: directly under the board. */
function placeSetupCard() {
  const card = $('#card-setup');
  if (window.matchMedia('(min-width: 921px)').matches) $('.col-right').prepend(card);
  else $('.col-left .board-wrap').after(card);
}

function exitSetup() {
  S.setup = null;
  $('#card-setup').classList.add('hidden');
}

function writeSetupFields() {
  const d = S.setup.draft;
  $('#setup-turn').value = d.turn;
  $('#setup-half').value = d.halfmove;
  $('#setup-full').value = d.fullmove;
  for (const f of ['K', 'Q', 'k', 'q']) $('#cas-' + f).checked = d.castling.includes(f);
  refreshEpOptions(d.ep);
}

function readSetupFields() {
  const d = S.setup.draft;
  d.turn = $('#setup-turn').value;
  d.halfmove = Math.max(0, Math.floor(Number($('#setup-half').value) || 0));
  d.fullmove = Math.max(1, Math.floor(Number($('#setup-full').value) || 1));
  d.castling = ['K', 'Q', 'k', 'q'].filter((f) => $('#cas-' + f).checked).join('');
  d.ep = $('#setup-ep').value;
}

function refreshEpOptions(keep) {
  const d = S.setup.draft;
  const turn = $('#setup-turn').value;
  const opts = ['-'];
  for (const f of core.FILES) {
    const sq = f + (turn === 'w' ? '6' : '3');
    if (core.sanitizeEp(d.board, turn, sq).valid) opts.push(sq);
  }
  const sel = $('#setup-ep');
  sel.innerHTML = opts.map((o) => `<option value="${o}">${o === '-' ? 'none' : o}</option>`).join('');
  sel.value = opts.includes(keep) ? keep : '-';
}

function afterSetupEdit() {
  refreshEpOptions($('#setup-ep').value);
  setMsg('#setup-msg', '', '');
  renderBoard();
}

function setupDown(idx) {
  const st = S.setup;
  const b = st.draft.board;
  if (st.tool === 'erase') { b[idx] = null; afterSetupEdit(); return {}; }
  if (st.tool === 'move') return b[idx] ? { drag: b[idx] } : {};
  b[idx] = b[idx] === st.tool ? null : st.tool;
  afterSetupEdit();
  return {};
}

function setupUp({ from, to, moved }) {
  if (!moved || !S.setup) return;
  const b = S.setup.draft.board;
  const piece = b[from];
  if (to === null) b[from] = null;
  else if (to !== from) { b[to] = piece; b[from] = null; }
  afterSetupEdit();
}

function applySetup() {
  readSetupFields();
  const v = core.validateSetup(S.setup.draft);
  if (!v.ok) { setMsg('#setup-msg', 'err', v.errors); return; }
  const fen = core.boardToFen(v.state);
  if (!rules.isLoadable(fen)) { setMsg('#setup-msg', 'err', ['The chess rules library rejected this position.']); return; }
  exitSetup();
  loadPosition(fen, 'edit');
  if (v.warnings.length) setMsg('#fen-msg', 'warn', v.warnings);
}

function setMsg(sel, kind, text) {
  const el = $(sel);
  el.className = `msg ${kind || ''}`;
  const list = Array.isArray(text) ? text : [text];
  el.innerHTML = list.filter(Boolean).length > 1 ? `<ul>${list.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : esc(list[0] || '');
}

/* ------------------------------------------------------------------- FEN -- */

function loadFenString(text) {
  try {
    const st = core.parseFen(text.trim());
    const v = core.validateSetup(st);
    if (!v.ok) { setMsg('#fen-msg', 'err', v.errors); return false; }
    const fen = core.boardToFen(v.state);
    if (!rules.isLoadable(fen)) { setMsg('#fen-msg', 'err', ['The chess rules library rejected this FEN.']); return false; }
    if (S.setup) exitSetup();
    loadPosition(fen, 'load');
    setMsg('#fen-msg', v.warnings.length ? 'warn' : 'ok', v.warnings.length ? v.warnings : 'FEN loaded.');
    return true;
  } catch (err) {
    setMsg('#fen-msg', 'err', err.message);
    return false;
  }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

/* ---------------------------------------------------------------- wiring -- */

function bindUi() {
  $('#btn-undo').addEventListener('click', undo);
  $('#btn-redo').addEventListener('click', redo);
  $('#btn-flip').addEventListener('click', () => { S.orientation = S.orientation === 'w' ? 'b' : 'w'; renderBoard(); });
  $('#btn-reset').addEventListener('click', () => { if (S.setup) exitSetup(); loadPosition(core.START_FEN, 'reset'); });
  $('#btn-clear').addEventListener('click', () => enterSetup(core.emptyState()));
  $('#btn-edit').addEventListener('click', () => { if (S.setup) return; enterSetup(core.parseFen(curFen())); });

  $('#tool-move').addEventListener('click', () => { if (S.setup) { S.setup.tool = 'move'; renderSetupTools(); } });
  $('#tool-erase').addEventListener('click', () => { if (S.setup) { S.setup.tool = 'erase'; renderSetupTools(); } });
  $('#setup-clear').addEventListener('click', () => { if (!S.setup) return; S.setup.draft = core.emptyState(); writeSetupFields(); afterSetupEdit(); });
  $('#setup-start').addEventListener('click', () => { if (!S.setup) return; S.setup.draft = core.parseFen(core.START_FEN); writeSetupFields(); afterSetupEdit(); });
  $('#setup-apply').addEventListener('click', applySetup);
  $('#setup-cancel').addEventListener('click', () => { exitSetup(); positionChanged('edit-cancel'); });
  $('#setup-turn').addEventListener('change', () => { refreshEpOptions('-'); });

  $('#history').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (b) jumpTo(Number(b.dataset.i));
  });

  $('#fen-copy').addEventListener('click', async () => {
    const ok = await copyText(curFen());
    setMsg('#fen-msg', ok ? 'ok' : 'err', ok ? 'FEN copied to clipboard.' : 'Could not copy — select the FEN and copy it manually.');
  });
  $('#fen-load').addEventListener('click', () => { if ($('#fen-input').value.trim()) loadFenString($('#fen-input').value); });
  $('#fen-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#fen-load').click(); }
  });
  $('#save-pos').addEventListener('click', () => {
    const list = store.get('positions', []);
    const name = $('#save-name').value.trim() || `Position ${list.length + 1}`;
    list.unshift({ name, fen: curFen(), saved: Date.now() });
    store.set('positions', list.slice(0, 60));
    $('#save-name').value = '';
    renderSavedList();
  });
  $('#saved').addEventListener('click', (e) => {
    const list = store.get('positions', []);
    const load = e.target.closest('[data-load]');
    const del = e.target.closest('[data-del]');
    if (load && list[load.dataset.load]) loadFenString(list[load.dataset.load].fen);
    if (del) { list.splice(Number(del.dataset.del), 1); store.set('positions', list); renderSavedList(); }
  });

  // analysis controls
  $('#an-start').addEventListener('click', startAnalysis);
  $('#an-pause').addEventListener('click', pauseAnalysis);
  $('#an-resume').addEventListener('click', resumeAnalysis);
  $('#an-stop').addEventListener('click', stopAnalysis);
  $('#an-mode').addEventListener('change', () => {
    S.settings.auto = $('#an-mode').value === 'auto';
    saveSettings();
    if (S.settings.auto && S.analysis.status === 'idle') scheduleAnalysis();
    renderAnalysis();
  });
  $('#an-status').addEventListener('click', (e) => { if (e.target.id === 'btn-retry') initEngine(); });

  const setDepth = () => {
    const v = $('#an-depth').value;
    $('#an-depth-custom-wrap').classList.toggle('hidden', v !== 'custom');
    S.settings.depth = v === 'custom' ? Math.min(60, Math.max(1, Math.floor(Number($('#an-depth-custom').value) || 22))) : Number(v);
    saveSettings();
    if (S.analysis.status === 'running') startAnalysis(); else renderStatus();
  };
  const setTime = () => {
    const v = $('#an-time').value;
    $('#an-time-custom-wrap').classList.toggle('hidden', v !== 'custom');
    S.settings.time = v === 'custom' ? Math.min(3600, Math.max(1, Math.floor(Number($('#an-time-custom').value) || 20))) : Number(v);
    saveSettings();
    if (S.analysis.status === 'running') startAnalysis(); else renderStatus();
  };
  $('#an-depth').addEventListener('change', setDepth);
  $('#an-depth-custom').addEventListener('change', setDepth);
  $('#an-time').addEventListener('change', setTime);
  $('#an-time-custom').addEventListener('change', setTime);

  $('#chk-arrows').addEventListener('change', () => { S.settings.showArrows = $('#chk-arrows').checked; saveSettings(); renderArrows(); });

  const cands = $('#cands');
  cands.addEventListener('mouseover', (e) => { const c = e.target.closest('.cand[data-rank]'); setFocus(c ? Number(c.dataset.rank) : null); });
  cands.addEventListener('mouseleave', () => setFocus(null));
  cands.addEventListener('focusin', (e) => { const c = e.target.closest('.cand[data-rank]'); setFocus(c ? Number(c.dataset.rank) : null); });
  cands.addEventListener('focusout', () => setFocus(null));
  cands.addEventListener('click', (e) => { const c = e.target.closest('.cand[data-rank]'); if (c) setFocus(S.focusRank === Number(c.dataset.rank) ? null : Number(c.dataset.rank)); });

  // clocks
  const presetSel = $('#tc-preset');
  presetSel.innerHTML = core.TIME_PRESETS.map((p) => `<option value="${p.id}">${p.id}</option>`).join('') + '<option value="custom">Custom</option>';
  presetSel.addEventListener('change', () => {
    const p = core.TIME_PRESETS.find((x) => x.id === presetSel.value);
    if (!p) return;
    S.settings.tc = { h: Math.floor(p.minutes / 60), m: p.minutes % 60, s: 0, inc: p.inc };
    writeTcFields();
    applyTimeControl(true);
  });
  ['#tc-h', '#tc-m', '#tc-s'].forEach((id) => $(id).addEventListener('input', () => { readTcFields(); syncPresetSelect(); saveSettings(); }));
  $('#tc-inc').addEventListener('input', () => { readTcFields(); syncPresetSelect(); applyTimeControl(false); });
  $('#tc-apply').addEventListener('click', () => { readTcFields(); syncPresetSelect(); applyTimeControl(true); });
  $('#clk-start').addEventListener('click', () => {
    if (S.setup) return;
    if (!clock.start(S.ctx.parsed.turn, now())) flash($('#clk-start'));
    renderClockControls(); tickUI();
  });
  $('#clk-pause').addEventListener('click', () => { clock.pause(now()); renderClockControls(); tickUI(); });
  $('#clk-resume').addEventListener('click', () => { if (!clock.resume(now())) flash($('#clk-resume')); renderClockControls(); tickUI(); });
  $('#clk-reset').addEventListener('click', () => { clock.reset(); renderClockControls(); renderTurnNote(); tickUI(); });
  $('#inc-always').addEventListener('change', () => { S.settings.incAlways = $('#inc-always').checked; saveSettings(); });

  // theme
  $('#btn-theme').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    S.settings.theme = next;
    saveSettings();
    syncThemeButton();
  });

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); undo(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); redo(); }
    else if (e.key === 'f' || e.key === 'F') { S.orientation = S.orientation === 'w' ? 'b' : 'w'; renderBoard(); }
    else if (e.key === 'Escape' && S.selected !== null) deselect();
  });
}

function setFocus(rank) {
  if (S.focusRank === rank) return;
  S.focusRank = rank;
  $$('#cands .cand').forEach((c) => c.classList.toggle('focus', Number(c.dataset.rank) === rank));
  renderArrows();
}

function syncThemeButton() {
  $('#btn-theme').textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? 'Light' : 'Dark';
}

function syncSettingsToUi() {
  const s = S.settings;
  writeTcFields();
  syncPresetSelect();
  $('#inc-always').checked = !!s.incAlways;
  const depthSel = $('#an-depth');
  if ([...depthSel.options].some((o) => o.value === String(s.depth))) depthSel.value = String(s.depth);
  else { depthSel.value = 'custom'; $('#an-depth-custom').value = s.depth; $('#an-depth-custom-wrap').classList.remove('hidden'); }
  const timeSel = $('#an-time');
  if ([...timeSel.options].some((o) => o.value === String(s.time))) timeSel.value = String(s.time);
  else { timeSel.value = 'custom'; $('#an-time-custom').value = s.time; $('#an-time-custom-wrap').classList.remove('hidden'); }
  syncThemeButton();
}

/* ------------------------------------------------------------------ boot -- */

function showFatal(err) {
  const box = $('#fatal');
  box.classList.remove('hidden');
  box.innerHTML = `<h2 style="font-size:18px;margin-bottom:8px">GRANDMASTER AI could not start</h2>
    <p>The chess-rules library (chess.js) is missing. From the project folder run:</p>
    <pre>npm install\nnpm run setup\nnpm start</pre>
    <p class="muted">Then open <strong>http://localhost:8080</strong>. Details:</p>
    <pre>${esc(err.message)}</pre>`;
  $('#layout').classList.add('hidden');
}

async function boot() {
  try {
    const { Chess } = await loadChessJs();
    rules = createRules(Chess);
  } catch (err) {
    showFatal(err);
    return;
  }
  view = new BoardView($('#board-frame'), {
    onDown: (idx) => (S.setup ? setupDown(idx) : playDown(idx)),
    onUp: (info) => (S.setup ? setupUp(info) : playUp(info)),
    onSecondary: (idx) => { if (S.setup) { S.setup.draft.board[idx] = null; afterSetupEdit(); } },
  });
  buildClocks();
  buildPalette();
  bindUi();
  syncSettingsToUi();

  let fen = store.get('lastFen', core.START_FEN);
  try { core.parseFen(fen); if (!rules.isLoadable(fen)) fen = core.START_FEN; } catch { fen = core.START_FEN; }
  loadPosition(fen, 'boot');
  tickUI();
  setInterval(tickUI, 100);
  initEngine();
}

boot();
