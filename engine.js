/* ==========================================================================
   GRANDMASTER AI — engine.js
   Wrapper around the Stockfish.js WebAssembly engine running in a Web Worker.
   It speaks plain UCI and nothing else — every number the UI shows comes from the
   engine's "info" lines. No scores or moves are ever generated here.

   Search protocol (UCI is strictly sequential, so races are handled explicitly):
     analyze() while idle      → position, go
     analyze() while searching → stop, wait for "bestmove", then position, go
     stop()                    → stop, wait for "bestmove", nothing else starts
   "info" lines that arrive after a stop was requested belong to the old search and
   are dropped.
   ========================================================================== */

import { parseInfo, parseBestmove } from './core.js';

const MULTIPV = 4;

export class StockfishEngine {
  /**
   * handlers: onStatus(text,kind) · onSnapshot(snapshot) · onSearchEnd({id,reason}) · onError(message)
   * snapshot: {id, fen, turn, depth, seldepth, nodes, nps, time, hashfull, lines:[{multipv,depth,seldepth,score,pv,nodes,nps,time}]}
   *           scores are exactly as Stockfish reports them: from the side-to-move's point of view.
   */
  constructor(handlers = {}) {
    this.h = handlers;
    this.worker = null;
    this.ready = false;
    this.name = 'Stockfish';
    this.label = '';
    this.searching = false;
    this.stopping = false;
    this.queued = null;
    this.current = null;
    this.buffers = new Map(); // depth → Map(multipv → info)
    this.waiters = [];
    this.seq = 0;
    this.lastMultiPV = null;
  }

  /* ------------------------------------------------------------ start up -- */

  async init() {
    this.destroy();
    this._status('Loading Stockfish…', 'busy');
    let manifest;
    try {
      const res = await fetch(new URL('../engine/engine.json', import.meta.url), { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      manifest = await res.json();
    } catch (err) {
      throw new Error(`Stockfish files not found in /engine (${err.message}). Run "npm run setup" — see the README.`);
    }
    this.label = manifest.label || manifest.script;
    const url = new URL(`../engine/${manifest.script}`, import.meta.url);

    this.worker = new Worker(url);
    this.worker.onmessage = (e) => this._onLine(typeof e.data === 'string' ? e.data : String(e.data && e.data.data ? e.data.data : e.data));
    this.worker.onerror = (e) => this._fail(`Engine worker error: ${e.message || 'could not start (is the .wasm file next to the .js file?)'}`);

    this._send('uci');
    await this._waitFor((l) => l === 'uciok', 30000, 'Stockfish did not answer to "uci" — check that the .wasm file sits next to the .js file in /engine.');
    this._send('setoption name UCI_AnalyseMode value true');
    this._send('setoption name Hash value 32');
    this._send(`setoption name MultiPV value ${MULTIPV}`);
    this.lastMultiPV = MULTIPV;
    this._send('ucinewgame');
    this._send('isready');
    await this._waitFor((l) => l === 'readyok', 30000, 'Stockfish did not become ready.');
    this.ready = true;
    this._status('Engine ready', 'ok');
  }

  destroy() {
    if (this.worker) {
      try { this.worker.terminate(); } catch { /* ignore */ }
    }
    this.worker = null;
    this.ready = false;
    this.searching = false;
    this.stopping = false;
    this.queued = null;
    this.current = null;
    this.buffers.clear();
    this.waiters.forEach((w) => { clearTimeout(w.timer); w.reject(new Error('Engine stopped')); });
    this.waiters = [];
  }

  /* -------------------------------------------------------------- control -- */

  /**
   * Analyse a position. `depth` and `movetimeMs` are optional limits (both null → infinite).
   * `legalCount` tells us how many lines to wait for (MultiPV is capped by the number of legal moves).
   */
  analyze({ fen, turn, depth = null, movetimeMs = null, legalCount = MULTIPV }) {
    if (!this.ready) return;
    this.queued = { fen, turn, depth, movetimeMs, legalCount };
    if (this.searching) {
      if (!this.stopping) { this._send('stop'); this.stopping = true; }
    } else {
      this._startQueued();
    }
  }

  /** Stop the current search (if any) and start nothing else. */
  stop() {
    this.queued = null;
    if (this.searching && !this.stopping) {
      this._send('stop');
      this.stopping = true;
    }
  }

  get busy() { return this.searching; }

  _startQueued() {
    const job = this.queued;
    this.queued = null;
    if (!job || !this.ready) return;
    this.current = { id: ++this.seq, ...job, expected: Math.max(1, Math.min(MULTIPV, job.legalCount)) };
    this.buffers.clear();
    this.stopping = false;
    this._send(`position fen ${job.fen}`);
    let go = 'go';
    if (job.depth) go += ` depth ${job.depth}`;
    if (job.movetimeMs) go += ` movetime ${Math.round(job.movetimeMs)}`;
    if (!job.depth && !job.movetimeMs) go = 'go infinite';
    this.searching = true;
    this._send(go);
  }

  /* --------------------------------------------------------------- output -- */

  _onLine(raw) {
    const line = raw.trim();
    if (!line) return;
    for (const w of [...this.waiters]) {
      if (w.pred(line)) {
        clearTimeout(w.timer);
        this.waiters = this.waiters.filter((x) => x !== w);
        w.resolve(line);
      }
    }
    if (line.startsWith('id name ')) { this.name = line.slice(8).trim(); return; }
    if (line.startsWith('info ')) { this._onInfo(line); return; }
    if (line.startsWith('bestmove')) this._onBestmove(line);
  }

  _onInfo(line) {
    if (!this.searching || this.stopping || !this.current) return; // belongs to a search we abandoned
    const info = parseInfo(line);
    if (!info || info.bound) return; // ignore partial (fail-high/low) lines
    let level = this.buffers.get(info.depth);
    if (!level) {
      level = new Map();
      this.buffers.set(info.depth, level);
      for (const d of [...this.buffers.keys()]) if (d < info.depth - 3) this.buffers.delete(d);
    }
    level.set(info.multipv, info);
    if (level.size >= this.current.expected) this._commit(info.depth, level);
  }

  _commit(depth, level) {
    const lines = [...level.values()].sort((a, b) => a.multipv - b.multipv);
    this.buffers.delete(depth);
    const cur = this.current;
    this.h.onSnapshot && this.h.onSnapshot({
      id: cur.id,
      fen: cur.fen,
      turn: cur.turn,
      depth,
      seldepth: Math.max(...lines.map((l) => l.seldepth || 0)),
      nodes: Math.max(...lines.map((l) => l.nodes || 0)),
      nps: Math.max(...lines.map((l) => l.nps || 0)),
      time: Math.max(...lines.map((l) => l.time || 0)),
      hashfull: Math.max(...lines.map((l) => l.hashfull || 0)),
      lines,
    });
  }

  _onBestmove(line) {
    if (!this.searching) return;
    const finished = this.current;
    const wasStopped = this.stopping;
    this.searching = false;
    this.stopping = false;
    const best = parseBestmove(line);
    if (this.queued) {
      this._startQueued();
      return;
    }
    this.current = null;
    this.h.onSearchEnd && this.h.onSearchEnd({ id: finished ? finished.id : 0, reason: wasStopped ? 'stopped' : 'complete', bestmove: best });
  }

  /* -------------------------------------------------------------- helpers -- */

  _send(cmd) {
    if (this.worker) this.worker.postMessage(cmd);
  }

  _status(text, kind) {
    this.h.onStatus && this.h.onStatus(text, kind);
  }

  _fail(message) {
    this.ready = false;
    this.searching = false;
    this.h.onError && this.h.onError(message);
  }

  _waitFor(pred, timeoutMs, timeoutMessage) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(timeoutMessage));
      }, timeoutMs);
      this.waiters.push({ pred, resolve, reject, timer });
    });
  }
}
