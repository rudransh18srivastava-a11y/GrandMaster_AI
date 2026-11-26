/* ==========================================================================
   GRANDMASTER AI — rules.js
   Thin adapter around chess.js (v1.x). The rest of the app never touches chess.js
   directly, and every call is wrapped so both the 1.x names (inCheck, isCheckmate…)
   and the 0.x names (in_check, in_checkmate…) work.

   All functions are stateless and take a FEN string. A new Chess() is cheap, and
   rebuilding from FEN means custom start positions, undo/redo and jumping through
   history behave identically.
   ========================================================================== */

const CDN_URL = 'https://cdn.jsdelivr.net/npm/chess.js@1/+esm';

/** Load chess.js: local copy first (lib/chess.js, put there by `npm run setup`), CDN as a fallback. */
export async function loadChessJs() {
  const tried = [];
  const candidates = [new URL('../lib/chess.js', import.meta.url).href, CDN_URL];
  for (const url of candidates) {
    try {
      const mod = await import(url);
      const Chess = mod.Chess || (mod.default && mod.default.Chess) || mod.default;
      if (typeof Chess === 'function') return { Chess, source: url };
      tried.push(`${url}: module has no Chess export`);
    } catch (err) {
      tried.push(`${url}: ${err && err.message ? err.message : err}`);
    }
  }
  throw new Error('Could not load chess.js.\n' + tried.join('\n'));
}

const call = (g, ...names) => {
  for (const n of names) if (typeof g[n] === 'function') return g[n]();
  return undefined;
};

const plain = (m) => ({
  color: m.color,
  from: m.from,
  to: m.to,
  piece: m.piece,
  captured: m.captured,
  promotion: m.promotion,
  flags: m.flags,
  san: m.san,
});

export function createRules(Chess) {
  const moveCache = new Map();

  const make = (fen) => new Chess(fen);

  /** Is this FEN accepted by chess.js? */
  function isLoadable(fen) {
    try { make(fen); return true; } catch { return false; }
  }

  /** All legal moves, verbose. Cached per FEN. */
  function legalMoves(fen) {
    if (moveCache.has(fen)) return moveCache.get(fen);
    const g = make(fen);
    const list = g.moves({ verbose: true }).map(plain);
    if (moveCache.size > 400) moveCache.clear();
    moveCache.set(fen, list);
    return list;
  }

  function status(fen) {
    const g = make(fen);
    const turn = g.turn();
    const check = !!call(g, 'inCheck', 'in_check');
    const checkmate = !!call(g, 'isCheckmate', 'in_checkmate');
    const stalemate = !!call(g, 'isStalemate', 'in_stalemate');
    const insufficient = !!call(g, 'isInsufficientMaterial', 'insufficient_material');
    return { turn, check, checkmate, stalemate, insufficient, gameOver: checkmate || stalemate || insufficient };
  }

  /** Try a move from `fen`. Returns {ok:true, move, fen} or {ok:false}. */
  function tryMove(fen, from, to, promotion) {
    try {
      const g = make(fen);
      const m = g.move({ from, to, promotion: promotion ? promotion.toLowerCase() : undefined });
      if (!m) return { ok: false };
      return { ok: true, move: plain(m), fen: g.fen() };
    } catch {
      return { ok: false };
    }
  }

  /**
   * Play a UCI line from `fen` for display. Stops at the first illegal move (which should never
   * happen with real engine output). Returns [{uci, san, fen, color, number, move}].
   */
  function playLine(fen, ucis, maxPlies = 24) {
    const out = [];
    let g;
    try { g = make(fen); } catch { return out; }
    const parts = fen.split(/\s+/);
    let number = Number(parts[5]) || 1;
    for (const uci of ucis.slice(0, maxPlies)) {
      const color = g.turn();
      let m;
      try {
        m = g.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined });
      } catch { break; }
      if (!m) break;
      out.push({ uci, san: m.san, fen: g.fen(), color, number, move: plain(m) });
      if (color === 'b') number += 1;
    }
    return out;
  }

  return { isLoadable, legalMoves, status, tryMove, playLine };
}
