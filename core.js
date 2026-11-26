/* ==========================================================================
   GRANDMASTER AI — core.js
   Pure logic (no DOM, no chess.js, no engine). Everything here is unit-tested
   in tests/core.test.js and runs in the browser and in Node.

   Board model: array of 64 entries, index 0 = a8 … 63 = h1 (FEN order).
   Pieces are 2-character codes: colour ('w'|'b') + type ('P','N','B','R','Q','K').
   ========================================================================== */

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
export const FILES = 'abcdefgh';
export const PIECE_VALUES = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 };
export const PIECE_NAMES = { P: 'pawn', N: 'knight', B: 'bishop', R: 'rook', Q: 'queen', K: 'king' };

export const sqName = (i) => FILES[i & 7] + (8 - (i >> 3));
export const sqIndex = (name) => (8 - Number(name[1])) * 8 + FILES.indexOf(name[0]);
export const other = (c) => (c === 'w' ? 'b' : 'w');

/* ------------------------------------------------------------------ FEN -- */

export function emptyState() {
  return { board: Array(64).fill(null), turn: 'w', castling: '', ep: '-', halfmove: 0, fullmove: 1 };
}

export function parseFen(fen) {
  if (typeof fen !== 'string') throw new Error('FEN must be text');
  const parts = fen.trim().split(/\s+/);
  if (!parts[0]) throw new Error('FEN is empty');
  const rows = parts[0].split('/');
  if (rows.length !== 8) throw new Error(`Piece placement needs 8 ranks separated by "/" (found ${rows.length})`);
  const board = [];
  rows.forEach((row, r) => {
    let n = 0;
    for (const ch of row) {
      if (/[1-8]/.test(ch)) {
        for (let k = 0; k < Number(ch); k++) board.push(null);
        n += Number(ch);
      } else if (/[pnbrqkPNBRQK]/.test(ch)) {
        board.push((ch === ch.toUpperCase() ? 'w' : 'b') + ch.toUpperCase());
        n += 1;
      } else {
        throw new Error(`Invalid character "${ch}" in rank ${8 - r}`);
      }
    }
    if (n !== 8) throw new Error(`Rank ${8 - r} describes ${n} squares instead of 8`);
  });
  const turn = parts[1] ?? 'w';
  if (turn !== 'w' && turn !== 'b') throw new Error('Side to move must be "w" or "b"');
  const castlingRaw = parts[2] ?? '-';
  if (!/^(-|[KQkq]+)$/.test(castlingRaw)) throw new Error('Castling field must be "-" or letters from KQkq');
  const castling = ['K', 'Q', 'k', 'q'].filter((c) => castlingRaw.includes(c)).join('');
  const ep = parts[3] ?? '-';
  if (!/^(-|[a-h][36])$/.test(ep)) throw new Error('En-passant field must be "-" or a square on rank 3 or 6');
  const halfmove = parts[4] === undefined ? 0 : Number(parts[4]);
  const fullmove = parts[5] === undefined ? 1 : Number(parts[5]);
  if (!Number.isInteger(halfmove) || halfmove < 0) throw new Error('Halfmove clock must be a non-negative integer');
  if (!Number.isInteger(fullmove) || fullmove < 1) throw new Error('Fullmove number must be 1 or more');
  return { board, turn, castling, ep, halfmove, fullmove };
}

export function boardToFen(state) {
  let placement = '';
  for (let r = 0; r < 8; r++) {
    let empty = 0;
    for (let c = 0; c < 8; c++) {
      const p = state.board[r * 8 + c];
      if (!p) { empty++; continue; }
      if (empty) { placement += empty; empty = 0; }
      placement += p[0] === 'w' ? p[1] : p[1].toLowerCase();
    }
    if (empty) placement += empty;
    if (r < 7) placement += '/';
  }
  return `${placement} ${state.turn} ${state.castling || '-'} ${state.ep || '-'} ${state.halfmove} ${state.fullmove}`;
}

/** First four FEN fields — identifies a position for repetition counting. */
export const fenKey = (fen) => fen.trim().split(/\s+/).slice(0, 4).join(' ');

/* -------------------------------------------------------------- attacks -- */

const KNIGHT = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
const KING = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const ORTH = [[-1, 0], [1, 0], [0, -1], [0, 1]];

/** Pieces of `color` that attack square `idx` (geometry only; the target square may be empty or occupied). */
export function attackersOf(board, idx, color) {
  const r0 = idx >> 3;
  const c0 = idx & 7;
  const at = (r, c) => (r < 0 || r > 7 || c < 0 || c > 7 ? undefined : board[r * 8 + c]);
  const out = [];
  const pr = color === 'w' ? r0 + 1 : r0 - 1; // a white pawn attacks "up" (towards row 0)
  for (const dc of [-1, 1]) {
    if (at(pr, c0 + dc) === color + 'P') out.push({ idx: pr * 8 + c0 + dc, type: 'P' });
  }
  for (const [dr, dc] of KNIGHT) {
    if (at(r0 + dr, c0 + dc) === color + 'N') out.push({ idx: (r0 + dr) * 8 + c0 + dc, type: 'N' });
  }
  for (const [dr, dc] of KING) {
    if (at(r0 + dr, c0 + dc) === color + 'K') out.push({ idx: (r0 + dr) * 8 + c0 + dc, type: 'K' });
  }
  const ray = (dirs, types) => {
    for (const [dr, dc] of dirs) {
      let r = r0 + dr;
      let c = c0 + dc;
      while (r >= 0 && r < 8 && c >= 0 && c < 8) {
        const p = board[r * 8 + c];
        if (p) {
          if (p[0] === color && types.includes(p[1])) out.push({ idx: r * 8 + c, type: p[1] });
          break;
        }
        r += dr;
        c += dc;
      }
    }
  };
  ray(DIAG, ['B', 'Q']);
  ray(ORTH, ['R', 'Q']);
  return out;
}

export const isAttacked = (board, idx, byColor) => attackersOf(board, idx, byColor).length > 0;

/** Non-king pieces that are attacked and either undefended or attacked by a cheaper piece. */
export function hangingPieces(board) {
  const out = { w: [], b: [] };
  board.forEach((p, idx) => {
    if (!p || p[1] === 'K') return;
    const color = p[0];
    const enemy = other(color);
    const attackers = attackersOf(board, idx, enemy);
    if (!attackers.length) return;
    const defended = attackersOf(board, idx, color).length > 0;
    const cheapest = Math.min(...attackers.map((a) => PIECE_VALUES[a.type] || 100));
    if (!defended || cheapest < PIECE_VALUES[p[1]]) out[color].push({ idx, piece: p });
  });
  return out;
}

/* ------------------------------------------------------- setup validation -- */

/** Drop castling rights whose king/rook are not on their home squares. */
export function sanitizeCastling(board, castling) {
  const keep = [];
  const dropped = [];
  const rules = {
    K: ['e1', 'h1', 'w'], Q: ['e1', 'a1', 'w'], k: ['e8', 'h8', 'b'], q: ['e8', 'a8', 'b'],
  };
  for (const flag of castling.split('').filter(Boolean)) {
    const [kSq, rSq, col] = rules[flag];
    if (board[sqIndex(kSq)] === col + 'K' && board[sqIndex(rSq)] === col + 'R') keep.push(flag);
    else dropped.push(flag);
  }
  return { castling: keep.join(''), dropped };
}

/** Keep an en-passant square only if a pawn really just made the double step and could be captured. */
export function sanitizeEp(board, turn, ep) {
  if (!ep || ep === '-') return { ep: '-', valid: true };
  const file = ep[0];
  const rank = Number(ep[1]);
  const f = FILES.indexOf(file);
  if (turn === 'b' && rank === 3) {
    const pawn = board[sqIndex(file + '4')] === 'wP';
    const free = !board[sqIndex(file + '3')] && !board[sqIndex(file + '2')];
    const capturer = [f - 1, f + 1].some((x) => x >= 0 && x < 8 && board[sqIndex(FILES[x] + '4')] === 'bP');
    return pawn && free && capturer ? { ep, valid: true } : { ep: '-', valid: false };
  }
  if (turn === 'w' && rank === 6) {
    const pawn = board[sqIndex(file + '5')] === 'bP';
    const free = !board[sqIndex(file + '6')] && !board[sqIndex(file + '7')];
    const capturer = [f - 1, f + 1].some((x) => x >= 0 && x < 8 && board[sqIndex(FILES[x] + '5')] === 'wP');
    return pawn && free && capturer ? { ep, valid: true } : { ep: '-', valid: false };
  }
  return { ep: '-', valid: false };
}

/** Full legality check of an editable position. Returns sanitized state plus human-readable messages. */
export function validateSetup(state) {
  const errors = [];
  const warnings = [];
  const s = { ...state, board: [...state.board] };
  const count = (code) => s.board.filter((p) => p === code).length;

  for (const [col, name] of [['w', 'White'], ['b', 'Black']]) {
    const kings = count(col + 'K');
    if (kings !== 1) errors.push(`${name} must have exactly one king (found ${kings}).`);
    if (count(col + 'P') > 8) errors.push(`${name} has more than 8 pawns.`);
    if (s.board.filter((p) => p && p[0] === col).length > 16) errors.push(`${name} has more than 16 pieces.`);
  }
  s.board.forEach((p, i) => {
    if (p && p[1] === 'P' && (i < 8 || i >= 56)) errors.push(`A pawn cannot stand on ${sqName(i)} (first or last rank).`);
  });

  if (!errors.length) {
    const kingOf = (col) => s.board.indexOf(col + 'K');
    const waiting = other(s.turn);
    if (isAttacked(s.board, kingOf(waiting), s.turn)) {
      errors.push(`The ${waiting === 'w' ? 'White' : 'Black'} king is in check but it is ${s.turn === 'w' ? 'White' : 'Black'} to move — this position is impossible.`);
    }
  }

  const cas = sanitizeCastling(s.board, s.castling);
  if (cas.dropped.length) warnings.push(`Removed castling right(s) ${cas.dropped.join('')} — king or rook is not on its home square.`);
  s.castling = cas.castling;

  const ep = sanitizeEp(s.board, s.turn, s.ep);
  if (!ep.valid) warnings.push(`En-passant square ${s.ep} is not playable here and was cleared.`);
  s.ep = ep.ep;

  return { ok: errors.length === 0, errors, warnings, state: s };
}

/* ------------------------------------------------------------- material -- */

export function materialCount(board) {
  const side = () => ({ points: 0, counts: { P: 0, N: 0, B: 0, R: 0, Q: 0 } });
  const out = { w: side(), b: side() };
  for (const p of board) {
    if (!p || p[1] === 'K') continue;
    out[p[0]].counts[p[1]]++;
    out[p[0]].points += PIECE_VALUES[p[1]];
  }
  return { w: out.w, b: out.b, diff: out.w.points - out.b.points };
}

/* ----------------------------------------------------------- evaluation -- */

/** Lichess-style logistic win-probability (0–100) for White from a centipawn score. */
export const winPercent = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);

/** Share of the evaluation bar (0–100) given to White. `score` is {type:'cp'|'mate', value} from White's view. */
export function barPercent(score) {
  if (!score) return 50;
  if (score.type === 'mate') return score.value > 0 ? 100 : score.value < 0 ? 0 : 50;
  return Math.min(98, Math.max(2, winPercent(score.value)));
}

/** Convert a score reported from the side-to-move's view into White's view. */
export function scoreToWhite(score, turn) {
  if (!score) return null;
  const sign = turn === 'w' ? 1 : -1;
  return { type: score.type, value: score.value * sign };
}

export const flipScore = (score) => ({ type: score.type, value: -score.value });

/** Numeric stand-in used only to compare/sort scores (mate beats any cp; faster mate is better). */
export function scoreToCp(score) {
  if (score.type === 'cp') return score.value;
  const m = Math.abs(score.value);
  const big = 100000 - m * 100;
  return score.value > 0 ? big : -big;
}

export function formatScore(score) {
  if (!score) return '—';
  if (score.type === 'mate') {
    if (score.value === 0) return '#';
    return score.value > 0 ? `M${score.value}` : `-M${Math.abs(score.value)}`;
  }
  const pawns = score.value / 100;
  const txt = Math.abs(pawns).toFixed(2);
  return pawns > 0 ? `+${txt}` : pawns < 0 ? `-${txt}` : '0.00';
}

/** Describe an evaluation (White's point of view). */
export function classifyEval(score) {
  if (!score) return { label: 'Waiting for engine', side: '=', tier: 0 };
  if (score.type === 'mate') {
    if (score.value === 0) return { label: 'Checkmate', side: '=', tier: 7 };
    const side = score.value > 0 ? 'w' : 'b';
    return { label: `Forced mate for ${side === 'w' ? 'White' : 'Black'} in ${Math.abs(score.value)}`, side, tier: 7 };
  }
  const p = Math.abs(score.value) / 100;
  const side = score.value > 0 ? 'w' : 'b';
  const who = side === 'w' ? 'White' : 'Black';
  if (p < 0.25) return { label: 'Equal position', side: '=', tier: 0 };
  if (p < 0.75) return { label: `${who} is slightly better`, side, tier: 1 };
  if (p < 1.5) return { label: `${who} is better`, side, tier: 2 };
  if (p < 3) return { label: `${who} is clearly better`, side, tier: 3 };
  if (p < 6) return { label: `${who} is winning`, side, tier: 4 };
  return { label: `${who} is completely winning`, side, tier: 5 };
}

/* ------------------------------------------------------------ UCI parsing -- */

/** Parse an "info … pv …" line. Returns null for lines without a score and a principal variation. */
export function parseInfo(line) {
  if (!line.startsWith('info ')) return null;
  const t = line.trim().split(/\s+/);
  if (t[1] === 'string') return null;
  const out = { multipv: 1, pv: [] };
  let hasScore = false;
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : undefined; };
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case 'depth': out.depth = num(t[++i]); break;
      case 'seldepth': out.seldepth = num(t[++i]); break;
      case 'multipv': out.multipv = num(t[++i]); break;
      case 'nodes': out.nodes = num(t[++i]); break;
      case 'nps': out.nps = num(t[++i]); break;
      case 'time': out.time = num(t[++i]); break;
      case 'hashfull': out.hashfull = num(t[++i]); break;
      case 'tbhits': out.tbhits = num(t[++i]); break;
      case 'currmove': case 'currmovenumber': case 'refutation': i++; break;
      case 'score': {
        const kind = t[++i];
        const value = num(t[++i]);
        if ((kind === 'cp' || kind === 'mate') && value !== undefined) {
          out.score = { type: kind, value };
          hasScore = true;
        }
        if (t[i + 1] === 'lowerbound' || t[i + 1] === 'upperbound') out.bound = t[++i];
        break;
      }
      case 'pv': out.pv = t.slice(i + 1); i = t.length; break;
      default: break;
    }
  }
  if (!hasScore || !out.pv.length || !out.depth) return null;
  return out;
}

export function parseBestmove(line) {
  const m = /^bestmove\s+(\S+)/.exec(line);
  return m ? m[1] : null;
}

export function uciToMove(uci) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined };
}

/* ------------------------------------------------------------- formatting -- */

export function formatCount(n) {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + ' M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + ' K';
  return String(Math.round(n));
}

/** Clock text. Shows tenths under 20 seconds, h:mm:ss from one hour. */
export function formatClock(ms) {
  ms = Math.max(0, ms);
  if (ms < 20000) {
    const tenths = Math.ceil(ms / 100);
    const s = Math.floor(tenths / 10);
    return `0:${String(s).padStart(2, '0')}.${tenths % 10}`;
  }
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** "1:30", "1:02:03", "90", "5m", "1h30m", "45s" → milliseconds, or null if invalid. */
export function parseTimeInput(str) {
  const s = String(str ?? '').trim().toLowerCase();
  if (!s) return null;
  const cap = 100 * 3600 * 1000;
  let ms = null;
  if (/^\d+(\.\d+)?$/.test(s)) {
    ms = parseFloat(s) * 1000;
  } else if (/^\d+:\d+(\.\d+)?$/.test(s) || /^\d+:\d+:\d+(\.\d+)?$/.test(s)) {
    const p = s.split(':').map(Number);
    if (p.length === 2) ms = (p[0] * 60 + p[1]) * 1000;
    else ms = (p[0] * 3600 + p[1] * 60 + p[2]) * 1000;
    if (p.length === 2 && p[1] >= 60) return null;
    if (p.length === 3 && (p[1] >= 60 || p[2] >= 60)) return null;
  } else {
    const re = /(\d+(?:\.\d+)?)\s*([hms])/g;
    let m;
    let used = 0;
    let total = 0;
    while ((m = re.exec(s))) {
      used += m[0].length;
      total += parseFloat(m[1]) * { h: 3600, m: 60, s: 1 }[m[2]] * 1000;
    }
    if (used === 0 || used !== s.replace(/\s+/g, '').length) return null;
    ms = total;
  }
  if (ms === null || !Number.isFinite(ms) || ms < 0 || ms > cap) return null;
  return Math.round(ms);
}

export const TIME_PRESETS = [
  { id: '1+0', minutes: 1, inc: 0 },
  { id: '3+0', minutes: 3, inc: 0 },
  { id: '3+2', minutes: 3, inc: 2 },
  { id: '5+0', minutes: 5, inc: 0 },
  { id: '5+3', minutes: 5, inc: 3 },
  { id: '10+0', minutes: 10, inc: 0 },
  { id: '15+10', minutes: 15, inc: 10 },
  { id: '30+0', minutes: 30, inc: 0 },
];

/* ------------------------------------------------------------------ Clock -- */

/**
 * Two independent chess clocks. All methods take `now` (ms, e.g. performance.now()),
 * so the model is deterministic and testable; the UI only reads it.
 */
export class Clock {
  constructor({ initialMs = 300000, incMs = 0 } = {}) {
    this.initialMs = initialMs;
    this.incMs = incMs;
    this.ms = { w: initialMs, b: initialMs };
    this.status = 'stopped'; // 'stopped' | 'running' | 'paused'
    this.side = null; // side whose clock runs (or ran, when paused)
    this.last = 0;
    this.flagged = null;
  }

  _sync(now) {
    if (this.status !== 'running') return;
    const dt = Math.max(0, now - this.last);
    this.last = now;
    this.ms[this.side] -= dt;
    if (this.ms[this.side] <= 0) {
      this.ms[this.side] = 0;
      this.flagged = this.side;
      this.status = 'stopped';
    }
  }

  read(side, now) { this._sync(now); return this.ms[side]; }

  start(side, now) {
    this._sync(now);
    if (this.ms[side] <= 0) return false;
    this.side = side;
    this.status = 'running';
    this.last = now;
    return true;
  }

  pause(now) {
    this._sync(now);
    if (this.status === 'running') this.status = 'paused';
  }

  resume(now) {
    if (this.status !== 'paused' || !this.side) return false;
    if (this.ms[this.side] <= 0) return false;
    this.status = 'running';
    this.last = now;
    return true;
  }

  /**
   * A move was registered for `mover`. While running, the mover receives the increment
   * and the opponent's clock starts. When not running the clocks stay untouched unless `force`.
   */
  move(mover, now, { force = false } = {}) {
    if (this.status === 'running') {
      this._sync(now);
      if (this.status !== 'running') return; // flagged just now
      this.ms[mover] += this.incMs;
      this.side = other(mover);
      this.last = now;
    } else if (force) {
      this.ms[mover] += this.incMs;
    }
  }

  /** Follow the board's side to move (undo/redo/edit) without touching any time. */
  syncTurn(turn, now) {
    if (this.status === 'running') {
      this._sync(now);
      if (this.status === 'running') { this.side = turn; this.last = now; }
    } else if (this.status === 'paused') {
      this.side = turn;
    }
  }

  set(side, ms, now) {
    this._sync(now);
    this.ms[side] = Math.max(0, Math.round(ms));
    if (this.ms[side] > 0 && this.flagged === side) this.flagged = null;
    if (this.ms[side] === 0 && this.status === 'running' && this.side === side) {
      this.flagged = side;
      this.status = 'stopped';
    }
  }

  adjust(side, deltaMs, now) {
    this._sync(now);
    this.set(side, this.ms[side] + deltaMs, now);
  }

  setIncrement(incMs) { this.incMs = Math.max(0, Math.round(incMs)); }

  /** New base time for both players (stops the clocks). */
  setBase(initialMs) {
    this.initialMs = Math.max(0, Math.round(initialMs));
    this.reset();
  }

  reset() {
    this.ms = { w: this.initialMs, b: this.initialMs };
    this.status = 'stopped';
    this.side = null;
    this.flagged = null;
  }
}

/* --------------------------------------------------- practical-play context -- */

/** Time-pressure level for one side. Increment counts as a buffer of ~5 moves (heuristic). */
export function timePressure(ms, incMs = 0) {
  const effective = ms + 5 * incMs;
  if (ms <= 0) return { level: 4, label: 'Flagged' };
  if (effective <= 10000) return { level: 3, label: 'Critical' };
  if (effective <= 30000) return { level: 2, label: 'High' };
  if (effective <= 120000) return { level: 1, label: 'Moderate' };
  return { level: 0, label: 'Low' };
}

export function timeAdvantage(whiteMs, blackMs) {
  const diff = whiteMs - blackMs;
  const abs = Math.abs(diff);
  const total = whiteMs + blackMs;
  const threshold = Math.max(5000, 0.05 * Math.max(whiteMs, blackMs));
  if (abs < threshold || total <= 0) return { leader: null, diffMs: abs, label: 'Even on time' };
  const leader = diff > 0 ? 'w' : 'b';
  const ratio = Math.max(whiteMs, blackMs) / Math.max(1, Math.min(whiteMs, blackMs));
  return {
    leader,
    diffMs: abs,
    ratio,
    label: `${leader === 'w' ? 'White' : 'Black'} has more time`,
  };
}

/**
 * How hard is the position for the side to move? Derived from the real MultiPV spread.
 * `cps` are scores from the mover's point of view, best first.
 */
export function positionDifficulty(cps) {
  if (!cps || cps.length === 0) return { level: 0, label: '—', detail: 'No engine data yet.' };
  if (cps.length === 1) return { level: 4, label: 'Forced', detail: 'Only one legal move.' };
  const best = cps[0];
  const gap12 = best - cps[1];
  const close = cps.filter((c) => best - c <= 50).length;
  const pawns = (x) => (Math.abs(x) >= 9000 ? 'a mate-sized' : (x / 100).toFixed(2));
  if (gap12 >= 300) return { level: 4, label: 'Very hard', detail: `Only-move position: the 2nd-best move is ${pawns(gap12)} pawns worse.` };
  if (gap12 >= 120) return { level: 3, label: 'Hard', detail: `One clearly best move; the 2nd-best is ${pawns(gap12)} pawns worse.` };
  if (close >= 3) return { level: 0, label: 'Easy', detail: `${close} of the top ${cps.length} moves are within 0.50 of the best.` };
  return { level: 1, label: 'Moderate', detail: `Best two moves are ${pawns(gap12)} apart; ${close} candidate(s) within 0.50.` };
}

/** Rough tactical density of a position, from facts on the board. */
export function tacticalComplexity({ captures = 0, checks = 0, hanging = 0, inCheck = false, legalCount = 0 }) {
  const score = checks * 1.0 + captures * 0.6 + hanging * 2 + (inCheck ? 3 : 0);
  const detail = `${captures} capture(s), ${checks} check(s), ${hanging} piece(s) en prise, ${legalCount} legal moves.`;
  if (score < 3) return { level: 0, label: 'Low', score, detail };
  if (score < 8) return { level: 1, label: 'Medium', score, detail };
  return { level: 2, label: 'High', score, detail };
}

/** Plain-language remarks mixing objective eval with clock context — never changes engine numbers. */
export function practicalNotes({ scoreWhite, turn, time, pressure, difficulty }) {
  const notes = [];
  if (!scoreWhite) return notes;
  const moverName = turn === 'w' ? 'White' : 'Black';
  const mover = turn;
  const cpWhite = scoreWhite.type === 'cp' ? scoreWhite.value : null;
  if (time.leader && time.diffMs >= 30000 && time.ratio >= 1.25) {
    const leadName = time.leader === 'w' ? 'White' : 'Black';
    if (cpWhite !== null && Math.abs(cpWhite) < 150 && (cpWhite === 0 || (cpWhite > 0 ? 'w' : 'b') !== time.leader || Math.abs(cpWhite) < 50)) {
      notes.push(`${leadName} has the extra time, which may matter in practice even though Stockfish rates the position only ${classifyEval(scoreWhite).label.toLowerCase()}.`);
    } else {
      notes.push(`${leadName} is ahead on the clock (${Math.round(time.diffMs / 1000)}s).`);
    }
  }
  if (pressure[mover].level >= 2 && difficulty.level >= 3) {
    notes.push(`${moverName} is to move in ${pressure[mover].label.toLowerCase()} time pressure and the position demands precise play (${difficulty.label.toLowerCase()}).`);
  } else if (pressure[mover].level >= 2) {
    notes.push(`${moverName} is to move with ${pressure[mover].label.toLowerCase()} time pressure.`);
  }
  if (cpWhite !== null && Math.abs(cpWhite) >= 300 && time.leader && (cpWhite > 0 ? 'w' : 'b') !== time.leader) {
    notes.push('The engine advantage is large enough that the clock is unlikely to change the objective picture.');
  }
  return notes;
}

/* ------------------------------------------------- candidate explanations -- */

const article = (name) => `a ${name}`;

const assessPhrase = (cp) => {
  if (cp >= 300) return 'keeps a winning advantage';
  if (cp >= 75) return 'keeps a clear edge';
  if (cp >= 25) return 'keeps a slight edge';
  if (cp > -25) return 'holds the balance';
  if (cp > -75) return 'keeps the position close, if slightly worse';
  if (cp > -300) return 'limits the damage';
  return 'is the most resilient try in a difficult position';
};

/**
 * Short, fact-based explanation for a candidate. Every sentence is derived from the real
 * engine score / PV and from board facts (capture, check, material change along the PV).
 */
export function explainCandidate(a) {
  const { rank, san, move, scoreMover, bestMover, nextMover, pvNetMaterial, pvPlies, threat, fullmove, startedFromHomeRank } = a;
  const parts = [];

  // 1. Headline from the engine score
  if (scoreMover.type === 'mate') {
    const n = Math.abs(scoreMover.value);
    if (scoreMover.value > 0) parts.push(san.endsWith('#') ? 'Delivers checkmate.' : `Forces checkmate in ${n}.`);
    else parts.push(rank === 1 ? `Best defence, but the engine still finds a forced mate against you in ${n}.` : `Allows a forced mate in ${n}.`);
  } else if (rank === 1) {
    parts.push(`Engine's first choice — it ${assessPhrase(scoreMover.value)}.`);
  } else {
    const gap = bestMover - scoreMover.value;
    if (Math.abs(bestMover) >= 9000) parts.push('Much weaker than the top choice.');
    else if (gap < 10) parts.push('Practically as strong as the top choice.');
    else parts.push(`${(gap / 100).toFixed(2)} pawns weaker than the top choice, yet it ${assessPhrase(scoreMover.value)}.`);
  }

  // 2. What the move does (board facts)
  const facts = [];
  if (move.promotion) facts.push(`Promotes to ${article(PIECE_NAMES[move.promotion.toUpperCase()])}.`);
  if (move.captured) facts.push(`Captures ${article(PIECE_NAMES[move.captured.toUpperCase()])}.`);
  if (/[kq]/.test(move.flags || '') && move.piece.toUpperCase() === 'K') facts.push('Castles, bringing the king to safety.');
  if (san.includes('+') && !san.endsWith('#')) facts.push('Gives check.');
  if (!facts.length && threat) facts.push(`Attacks the ${PIECE_NAMES[threat.type]} on ${threat.square}.`);
  if (!facts.length && (move.piece.toUpperCase() === 'N' || move.piece.toUpperCase() === 'B') && startedFromHomeRank && fullmove <= 12) {
    facts.push(`Develops the ${PIECE_NAMES[move.piece.toUpperCase()]}.`);
  }
  if (!facts.length && move.piece.toUpperCase() === 'P' && ['d4', 'e4', 'd5', 'e5'].includes(move.to)) facts.push('Fights for the centre.');
  if (facts.length) parts.push(facts[0]);

  // 3. Only-move warning
  if (rank === 1 && nextMover !== null && nextMover !== undefined && scoreMover.type === 'cp' && bestMover - nextMover >= 150) {
    parts.push(`Only move: the next-best alternative is ${Math.min(99, (bestMover - nextMover) / 100).toFixed(2)} pawns worse.`);
  }

  // 4. Material along the engine's line
  if (pvPlies >= 2 && Math.abs(pvNetMaterial) >= 1 && parts.length < 4) {
    const n = Math.abs(pvNetMaterial);
    parts.push(`Along the main line you ${pvNetMaterial > 0 ? 'win' : 'give up'} ${n} point${n === 1 ? '' : 's'} of material within ${pvPlies} plies.`);
  }
  return parts.slice(0, 4).join(' ');
}
