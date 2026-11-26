/* ==========================================================================
   GRANDMASTER AI — board.js
   Board rendering and pointer interaction (mouse + touch through Pointer Events).
   The view knows nothing about chess rules: the app tells it what to draw and is
   told what the user did.

   handlers:
     onDown(idx, event)  → {drag: pieceCode} to start dragging, or {} / nothing
     onUp({from, to, moved})  from = square index, to = square index under the pointer or null
     onSecondary(idx)    right mouse button
   ========================================================================== */

import { pieceSvg } from './pieces.js';
import { FILES } from './core.js';

const SVGNS = 'http://www.w3.org/2000/svg';

export class BoardView {
  constructor(frame, handlers) {
    this.frame = frame;
    this.h = handlers;
    this.orientation = 'w';
    this.el = document.createElement('div');
    this.el.className = 'board';
    this.arrowSvg = document.createElementNS(SVGNS, 'svg');
    this.arrowSvg.setAttribute('class', 'arrows');
    this.arrowSvg.setAttribute('viewBox', '0 0 8 8');
    this.badge = document.createElement('div');
    this.badge.className = 'board-badge hidden';
    this.frame.append(this.el, this.arrowSvg, this.badge);
    this.drag = null;
    this._move = (e) => this._onMove(e);
    this._up = (e) => this._onUp(e);
    this._cancel = () => this._cleanupDrag();
    this.el.addEventListener('pointerdown', (e) => this._onDown(e));
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /* ------------------------------------------------------------ drawing -- */

  /** model: {board, orientation, selected, targets: Map(idx→isCapture), last:{from,to}|null, checkIdx} */
  render(model) {
    this.orientation = model.orientation;
    const { board, selected, targets, last, checkIdx } = model;
    let html = '';
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const idx = this.orientation === 'w' ? r * 8 + c : (7 - r) * 8 + (7 - c);
        const p = board[idx];
        const light = ((idx >> 3) + (idx & 7)) % 2 === 0;
        let cls = `sq ${light ? 'light' : 'dark'}`;
        if (selected === idx) cls += ' sel';
        if (last && (last.from === idx || last.to === idx)) cls += ' last';
        if (checkIdx === idx) cls += ' check';
        if (targets && targets.get(idx) === true) cls += ' cap';
        const rank = c === 0 ? `<span class="rk">${8 - (idx >> 3)}</span>` : '';
        const file = r === 7 ? `<span class="fl">${FILES[idx & 7]}</span>` : '';
        html += `<div class="${cls}" data-i="${idx}">${rank}${file}${p ? `<div class="piece" data-p="${p}">${pieceSvg(p)}</div>` : ''}${targets && targets.has(idx) ? '<i class="dot"></i>' : ''}</div>`;
      }
    }
    this.el.innerHTML = html;
  }

  /** arrows: [{from, to, color, opacity, width}] — square indices. */
  setArrows(arrows) {
    const svg = this.arrowSvg;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const center = (idx) => {
      let col = idx & 7;
      let row = idx >> 3;
      if (this.orientation === 'b') { col = 7 - col; row = 7 - row; }
      return [col + 0.5, row + 0.5];
    };
    for (const a of arrows) {
      const [ax, ay] = center(a.from);
      const [bx, by] = center(a.to);
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (len < 0.2) continue;
      const ux = dx / len;
      const uy = dy / len;
      const px = -uy;
      const py = ux;
      const w = (a.width || 0.17) / 2;
      const hw = w * 2.6;
      const hl = Math.min(0.5, len * 0.6);
      const tip = [bx - ux * 0.1, by - uy * 0.1];
      const base = [tip[0] - ux * hl, tip[1] - uy * hl];
      const start = [ax + ux * 0.18, ay + uy * 0.18];
      const pts = [
        [start[0] + px * w, start[1] + py * w],
        [base[0] + px * w, base[1] + py * w],
        [base[0] + px * hw, base[1] + py * hw],
        tip,
        [base[0] - px * hw, base[1] - py * hw],
        [base[0] - px * w, base[1] - py * w],
        [start[0] - px * w, start[1] - py * w],
      ];
      const poly = document.createElementNS(SVGNS, 'polygon');
      poly.setAttribute('points', pts.map((p) => p.join(',')).join(' '));
      poly.setAttribute('fill', a.color);
      poly.setAttribute('opacity', String(a.opacity ?? 0.8));
      svg.appendChild(poly);
    }
  }

  showBadge(text) {
    this.badge.textContent = text || '';
    this.badge.classList.toggle('hidden', !text);
  }

  /* -------------------------------------------------------- interaction -- */

  _squareAt(x, y) {
    const el = document.elementFromPoint(x, y);
    const sq = el && el.closest ? el.closest('.sq') : null;
    return sq && this.el.contains(sq) ? Number(sq.dataset.i) : null;
  }

  get squareSize() {
    return this.el.getBoundingClientRect().width / 8;
  }

  _onDown(e) {
    if (this.drag) return;
    const sq = e.target.closest('.sq');
    if (!sq) return;
    const idx = Number(sq.dataset.i);
    if (e.pointerType === 'mouse' && e.button === 2) {
      e.preventDefault();
      if (this.h.onSecondary) this.h.onSecondary(idx);
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const res = (this.h.onDown && this.h.onDown(idx, e)) || {};
    if (!res.drag) return;
    this._beginDrag({ piece: res.drag, from: idx, x: e.clientX, y: e.clientY, sqEl: sq });
  }

  /** Start a drag that did not begin on the board (e.g. from the setup palette). */
  beginExternalDrag(piece, e, onDrop) {
    if (this.drag) return;
    this._beginDrag({ piece, from: null, x: e.clientX, y: e.clientY, onDrop, external: true });
    this._onMove(e);
  }

  _beginDrag(d) {
    this.drag = { ...d, moved: !!d.external, ghost: null, hover: null };
    window.addEventListener('pointermove', this._move);
    window.addEventListener('pointerup', this._up);
    window.addEventListener('pointercancel', this._cancel);
    if (d.external) this._makeGhost();
  }

  _makeGhost() {
    const size = this.squareSize || 56;
    const g = document.createElement('div');
    g.className = 'drag-ghost';
    g.style.width = `${size}px`;
    g.style.height = `${size}px`;
    g.innerHTML = pieceSvg(this.drag.piece);
    document.body.appendChild(g);
    this.drag.ghost = g;
    if (this.drag.from !== null && this.drag.from !== undefined) {
      const src = this.el.querySelector(`.sq[data-i="${this.drag.from}"]`);
      if (src) src.classList.add('dragging');
    }
  }

  _onMove(e) {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) {
      d.moved = true;
      this._makeGhost();
    }
    if (!d.moved) return;
    d.ghost.style.left = `${e.clientX}px`;
    d.ghost.style.top = `${e.clientY}px`;
    const over = this._squareAt(e.clientX, e.clientY);
    if (over !== d.hover) {
      this.el.querySelectorAll('.sq.hover').forEach((n) => n.classList.remove('hover'));
      if (over !== null) {
        const n = this.el.querySelector(`.sq[data-i="${over}"]`);
        if (n) n.classList.add('hover');
      }
      d.hover = over;
    }
  }

  _onUp(e) {
    const d = this.drag;
    if (!d) return;
    const to = this._squareAt(e.clientX, e.clientY);
    const { moved, from, external, onDrop } = d;
    this._cleanupDrag();
    if (external) { if (onDrop) onDrop(to); return; }
    if (this.h.onUp) this.h.onUp({ from, to, moved });
  }

  _cleanupDrag() {
    const d = this.drag;
    window.removeEventListener('pointermove', this._move);
    window.removeEventListener('pointerup', this._up);
    window.removeEventListener('pointercancel', this._cancel);
    if (d && d.ghost) d.ghost.remove();
    this.el.querySelectorAll('.sq.hover,.sq.dragging').forEach((n) => n.classList.remove('hover', 'dragging'));
    this.drag = null;
  }
}
