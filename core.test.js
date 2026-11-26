import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../js/core.js';

const { parseFen, boardToFen, START_FEN } = core;

test('FEN round-trips for the start position and a messy one', () => {
  assert.equal(boardToFen(parseFen(START_FEN)), START_FEN);
  const f = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
  assert.equal(boardToFen(parseFen(f)), f);
});

test('parseFen accepts short FENs and rejects garbage', () => {
  const s = parseFen('8/8/8/8/8/8/8/K6k b');
  assert.equal(s.turn, 'b');
  assert.equal(s.fullmove, 1);
  assert.throws(() => parseFen('8/8/8/8/8/8/8 w - - 0 1'), /8 ranks/);
  assert.throws(() => parseFen('9/8/8/8/8/8/8/8 w - - 0 1'), /Invalid character|squares/);
  assert.throws(() => parseFen('8/8/8/8/8/8/8/8 x - - 0 1'), /Side to move/);
  assert.throws(() => parseFen('8/8/8/8/8/8/8/8 w Z - 0 1'), /Castling/);
});

test('square helpers', () => {
  assert.equal(core.sqName(0), 'a8');
  assert.equal(core.sqName(63), 'h1');
  assert.equal(core.sqIndex('e4'), 36);
  assert.equal(core.sqName(core.sqIndex('c7')), 'c7');
});

test('attack detection (pawns, knights, sliders, blockers)', () => {
  const s = parseFen('4k3/8/8/3p4/4P3/8/8/4K2R w K - 0 1');
  assert.equal(core.isAttacked(s.board, core.sqIndex('d5'), 'w'), true); // e4 pawn
  assert.equal(core.isAttacked(s.board, core.sqIndex('e5'), 'b'), false); // d5 pawn attacks c4/e4
  assert.equal(core.isAttacked(s.board, core.sqIndex('e4'), 'b'), true);
  assert.equal(core.isAttacked(s.board, core.sqIndex('h8'), 'w'), true); // rook h1 up the file
  const blocked = parseFen('4k3/8/8/8/7p/8/8/4K2R w - - 0 1');
  assert.equal(core.isAttacked(blocked.board, core.sqIndex('h8'), 'w'), false);
});

test('validateSetup catches impossible positions', () => {
  assert.equal(core.validateSetup(parseFen(START_FEN)).ok, true);
  assert.equal(core.validateSetup(parseFen('8/8/8/8/8/8/8/K7 w - - 0 1')).ok, false);
  const twoKings = core.validateSetup(parseFen('kk6/8/8/8/8/8/8/K7 w - - 0 1'));
  assert.equal(twoKings.ok, false);
  const pawnOnBackRank = core.validateSetup(parseFen('P3k3/8/8/8/8/8/8/4K3 w - - 0 1'));
  assert.equal(pawnOnBackRank.ok, false);
  // black king in check with white to move = impossible
  const impossible = core.validateSetup(parseFen('4k3/8/8/8/8/8/8/4RK2 w - - 0 1'));
  assert.equal(impossible.ok, false);
  assert.match(impossible.errors[0], /in check/);
  // side to move may be in check
  assert.equal(core.validateSetup(parseFen('4k3/8/8/8/8/8/8/4RK2 b - - 0 1')).ok, true);
});

test('validateSetup repairs castling rights and en-passant squares', () => {
  const r = core.validateSetup(parseFen('r3k2r/8/8/8/8/8/8/4K3 w KQkq e3 0 1'));
  assert.equal(r.ok, true);
  assert.equal(r.state.castling, 'kq');
  assert.equal(r.state.ep, '-');
  assert.ok(r.warnings.length >= 2);
  const ep = core.validateSetup(parseFen('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2'));
  assert.equal(ep.state.ep, 'd6');
});

test('material count and difference', () => {
  const m = core.materialCount(parseFen(START_FEN).board);
  assert.equal(m.w.points, 39);
  assert.equal(m.b.points, 39);
  assert.equal(m.diff, 0);
  const m2 = core.materialCount(parseFen('4k3/8/8/8/8/8/8/3QK2R w - - 0 1').board);
  assert.equal(m2.diff, 14);
  assert.equal(m2.w.counts.Q, 1);
});

test('hanging pieces: undefended or attacked by a cheaper piece', () => {
  const s = parseFen('4k3/8/8/3q4/8/2N5/8/4K3 b - - 0 1'); // Nc3 attacked by queen? no: queen d5 attacks c4... check explicit
  const h = core.hangingPieces(parseFen('4k3/8/8/3p4/4Q3/8/8/4K3 w - - 0 1').board);
  assert.equal(h.w.length, 1); // queen on e4 attacked by pawn d5
  assert.equal(h.b.length, 1); // pawn d5 attacked by queen, undefended
  assert.ok(s);
});

test('score conversion, formatting and classification', () => {
  assert.deepEqual(core.scoreToWhite({ type: 'cp', value: 50 }, 'b'), { type: 'cp', value: -50 });
  assert.equal(core.formatScore({ type: 'cp', value: 34 }), '+0.34');
  assert.equal(core.formatScore({ type: 'cp', value: -120 }), '-1.20');
  assert.equal(core.formatScore({ type: 'cp', value: 0 }), '0.00');
  assert.equal(core.formatScore({ type: 'mate', value: 3 }), 'M3');
  assert.equal(core.formatScore({ type: 'mate', value: -5 }), '-M5');
  assert.equal(core.classifyEval({ type: 'cp', value: 10 }).side, '=');
  assert.match(core.classifyEval({ type: 'cp', value: -180 }).label, /Black is clearly better/);
  assert.match(core.classifyEval({ type: 'mate', value: 2 }).label, /mate for White in 2/);
  assert.equal(core.barPercent({ type: 'mate', value: 4 }), 100);
  assert.equal(core.barPercent({ type: 'mate', value: -1 }), 0);
  assert.equal(Math.round(core.barPercent({ type: 'cp', value: 0 })), 50);
  assert.ok(core.barPercent({ type: 'cp', value: 200 }) > core.barPercent({ type: 'cp', value: 100 }));
  assert.ok(core.scoreToCp({ type: 'mate', value: 2 }) > core.scoreToCp({ type: 'mate', value: 5 }));
  assert.ok(core.scoreToCp({ type: 'mate', value: 9 }) > core.scoreToCp({ type: 'cp', value: 2000 }));
});

test('parseInfo handles a real Stockfish line, mate scores and bounds', () => {
  const line = 'info depth 18 seldepth 26 multipv 2 score cp -13 nodes 1234567 nps 987654 hashfull 41 tbhits 0 time 1250 pv e2e4 e7e5 g1f3 b8c6';
  const i = core.parseInfo(line);
  assert.equal(i.depth, 18);
  assert.equal(i.multipv, 2);
  assert.deepEqual(i.score, { type: 'cp', value: -13 });
  assert.equal(i.nodes, 1234567);
  assert.deepEqual(i.pv, ['e2e4', 'e7e5', 'g1f3', 'b8c6']);
  const mate = core.parseInfo('info depth 9 seldepth 4 multipv 1 score mate -3 nodes 100 nps 1 time 1 pv a1a2');
  assert.deepEqual(mate.score, { type: 'mate', value: -3 });
  const bound = core.parseInfo('info depth 9 multipv 1 score cp 55 lowerbound nodes 10 pv e2e4');
  assert.equal(bound.bound, 'lowerbound');
  assert.equal(core.parseInfo('info string NNUE evaluation using nn.nnue'), null);
  assert.equal(core.parseInfo('info depth 5 currmove e2e4 currmovenumber 1'), null);
  assert.equal(core.parseInfo('bestmove e2e4'), null);
  assert.equal(core.parseBestmove('bestmove e2e4 ponder e7e5'), 'e2e4');
  assert.equal(core.parseBestmove('info depth 1'), null);
  assert.deepEqual(core.uciToMove('e7e8q'), { from: 'e7', to: 'e8', promotion: 'q' });
});

test('clock text and time parsing', () => {
  assert.equal(core.formatClock(300000), '5:00');
  assert.equal(core.formatClock(3661000), '1:01:01');
  assert.equal(core.formatClock(9400), '0:09.4');
  assert.equal(core.formatClock(0), '0:00.0');
  assert.equal(core.formatClock(-5), '0:00.0');
  assert.equal(core.parseTimeInput('1:30'), 90000);
  assert.equal(core.parseTimeInput('1:02:03'), 3723000);
  assert.equal(core.parseTimeInput('90'), 90000);
  assert.equal(core.parseTimeInput('5m'), 300000);
  assert.equal(core.parseTimeInput('1h30m'), 5400000);
  assert.equal(core.parseTimeInput('0:09.5'), 9500);
  assert.equal(core.parseTimeInput('abc'), null);
  assert.equal(core.parseTimeInput('1:75'), null);
  assert.equal(core.parseTimeInput(''), null);
  assert.equal(core.parseTimeInput('-5'), null);
});

test('Clock: runs independently, increments the mover, pauses and flags', () => {
  const c = new core.Clock({ initialMs: 60000, incMs: 2000 });
  assert.equal(c.start('w', 1000), true);
  assert.equal(c.read('w', 4000), 57000); // 3s elapsed
  assert.equal(c.read('b', 4000), 60000);
  c.move('w', 4000); // white moved: +2s, black runs
  assert.equal(c.ms.w, 59000);
  assert.equal(c.side, 'b');
  assert.equal(c.read('b', 9000), 55000);
  c.pause(9000);
  assert.equal(c.status, 'paused');
  assert.equal(c.read('b', 20000), 55000); // paused: no drain
  assert.equal(c.resume(20000), true);
  assert.equal(c.read('b', 21000), 54000);
  c.move('b', 21000);
  assert.equal(c.ms.b, 56000);
  assert.equal(c.side, 'w');
});

test('Clock: moves while stopped do not change time unless forced; flag falls at zero', () => {
  const c = new core.Clock({ initialMs: 5000, incMs: 3000 });
  c.move('w', 0);
  assert.equal(c.ms.w, 5000);
  c.move('w', 0, { force: true });
  assert.equal(c.ms.w, 8000);
  c.start('b', 100);
  c.read('b', 3100);
  assert.equal(c.ms.b, 2000);
  assert.equal(c.flagged, null);
  assert.equal(c.read('b', 20000), 0);
  assert.equal(c.flagged, 'b');
  assert.equal(c.status, 'stopped');
  c.set('b', 10000, 20000);
  assert.equal(c.flagged, null);
});

test('Clock: manual edits, adjust, base change, increment change and turn sync', () => {
  const c = new core.Clock({ initialMs: 60000, incMs: 0 });
  c.set('w', 125000, 0);
  c.adjust('b', -10000, 0);
  assert.equal(c.ms.w, 125000);
  assert.equal(c.ms.b, 50000);
  c.setIncrement(5000);
  assert.equal(c.incMs, 5000);
  c.start('w', 0);
  c.syncTurn('b', 1000); // board turned to black (e.g. undo) — no increment, clock follows
  assert.equal(c.side, 'b');
  assert.equal(c.ms.w, 124000);
  c.setBase(30000);
  assert.deepEqual(c.ms, { w: 30000, b: 30000 });
  assert.equal(c.status, 'stopped');
});

test('time pressure, advantage and difficulty heuristics', () => {
  assert.equal(core.timePressure(5000).label, 'Critical');
  assert.equal(core.timePressure(25000).label, 'High');
  assert.equal(core.timePressure(25000, 10000).label, 'Moderate'); // +10s increment buffer
  assert.equal(core.timePressure(600000).label, 'Low');
  assert.equal(core.timePressure(0).label, 'Flagged');
  assert.equal(core.timeAdvantage(300000, 100000).leader, 'w');
  assert.equal(core.timeAdvantage(300000, 298000).leader, null);
  assert.equal(core.positionDifficulty([100, -300]).label, 'Very hard');
  assert.equal(core.positionDifficulty([100, -40]).label, 'Hard');
  assert.equal(core.positionDifficulty([30, 25, 20, -50]).label, 'Easy');
  assert.equal(core.positionDifficulty([30, -50, -90, -130]).label, 'Moderate');
  assert.equal(core.positionDifficulty([10]).label, 'Forced');
  assert.equal(core.tacticalComplexity({ captures: 0, checks: 0, hanging: 0 }).label, 'Low');
  assert.equal(core.tacticalComplexity({ captures: 8, checks: 3, hanging: 2 }).label, 'High');
});

test('explainCandidate only states facts derived from its inputs', () => {
  const base = {
    rank: 1, san: 'Qxf7#', move: { piece: 'q', captured: 'p', flags: 'c', to: 'f7' },
    scoreMover: { type: 'mate', value: 1 }, bestMover: 99900, nextMover: 300,
    pvNetMaterial: 0, pvPlies: 1, threat: null, fullmove: 4, startedFromHomeRank: false,
  };
  const t = core.explainCandidate(base);
  assert.match(t, /Delivers checkmate/);
  assert.match(t, /Captures a pawn/);
  const quiet = core.explainCandidate({
    ...base, san: 'Nf3', move: { piece: 'n', flags: 'n', to: 'f3' }, scoreMover: { type: 'cp', value: 30 },
    bestMover: 30, nextMover: -200, startedFromHomeRank: true, fullmove: 1,
  });
  assert.match(quiet, /first choice/);
  assert.match(quiet, /Develops the knight/);
  assert.match(quiet, /Only move/);
  const second = core.explainCandidate({
    ...base, rank: 2, san: 'd4', move: { piece: 'p', flags: 'b', to: 'd4' }, scoreMover: { type: 'cp', value: 10 }, bestMover: 30,
  });
  assert.match(second, /0\.20 pawns weaker/);
  assert.match(second, /centre/);
});
