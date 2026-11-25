'use strict';
/* GRANDMASTER AI – app.js
   Engine: Stockfish (Web Worker). Rules: chess.js 0.10.3. All evaluations come from the engine;
   clocks never alter the engine score (they only feed the separate Practical Advantage model). */
const ENGINE_URL = localStorage.getItem('gm.engine') || 'https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js';
const $ = id => document.getElementById(id), FILES = 'abcdefgh';
const VAL = {p:1,n:3,b:3,r:5,q:9,k:0}, GLY = {k:'♚',q:'♛',r:'♜',b:'♝',n:'♞',p:'♟\uFE0E'};
const NAME = {p:'pawn',n:'knight',b:'bishop',r:'rook',q:'queen',k:'king'};
const LV = {beg:[1,'500–800'],cas:[4,'800–1200'],int:[8,'1200–1600'],adv:[12,'1600–2000'],exp:[16,'2000–2400'],max:[20,'max']};
const SYM = {Great:'!',Best:'★',Excellent:'✓',Good:'•',Inaccuracy:'?!',Mistake:'?',Blunder:'??'};
const clamp = (x,a,b) => Math.max(a,Math.min(b,x));
const wp = sc => 100/(1+Math.exp(-0.00368*clamp(sc,-1500,1500)));            // engine score -> win % (White)
const fmt = sc => { if (Math.abs(sc) >= 9000) { const m = 10000-Math.abs(sc); return (sc<0?'-':'')+(m?'M'+m:'#'); } return (sc>0?'+':'')+(sc/100).toFixed(2); };
const mmss = ms => { ms = Math.max(0,ms); if (ms < 10000) return (ms/1000).toFixed(1); const s = Math.floor(ms/1000), h = Math.floor(s/3600), m = Math.floor(s%3600/60); return (h?h+':':'')+String(m).padStart(2,'0')+':'+String(s%60).padStart(2,'0'); };
const flipFen = f => { const a = f.split(' '); a[1] = a[1]==='w'?'b':'w'; a[3] = '-'; return a.join(' '); };
const mvObj = u => ({from:u.slice(0,2),to:u.slice(2,4),promotion:u[4]});
function setStatus(t, err) { const s = $('status'); s.textContent = t; s.className = 'pill'+(err?' err':''); }

/* ---------------- Engine (Stockfish in a Web Worker) ---------------- */
const RE = /depth (\d+)(?:.*?multipv (\d+))? .*?score (cp|mate) (-?\d+).*? nodes (\d+).* pv (.+)$/;
class Engine {
  constructor() {
    this.failed = false; this.cur = null; this.next = null; this.lines = {};
    this.ready = new Promise(r => this._r = r);
    try {
      const local = !/^https?:/.test(ENGINE_URL);
      this.w = local ? new Worker(ENGINE_URL)
        : new Worker(URL.createObjectURL(new Blob([`importScripts("${ENGINE_URL}")`], {type:'text/javascript'})));
      this.w.onmessage = e => this.msg(String(e.data));
      this.w.onerror = () => this.fail('Engine failed to load – check your connection or ENGINE_URL.');
      this.post('uci');
      setTimeout(() => { if (!this.ok) this.fail('Engine did not start within 20 s.'); }, 20000);
    } catch (e) { this.fail('Web Workers unavailable: '+e.message); }
  }
  fail(m) { this.failed = true; setStatus('⚠ '+m, true); this._r(); }
  post(s) { this.w.postMessage(s); }
  msg(l) {
    if (l === 'uciok') this.post('isready');
    else if (l === 'readyok') { this.ok = true; this._r(); setStatus('Stockfish ready'); }
    else if (l.startsWith('info') && !/bound/.test(l)) {
      const m = l.match(RE);
      if (m && this.cur) this.lines[+(m[2]||1)] = {depth:+m[1], raw: m[3]==='cp' ? +m[4] : (+m[4]>0?1:-1)*(10000-Math.abs(+m[4])), nodes:+m[5], pv:m[6].trim().split(' ')};
    } else if (l.startsWith('bestmove')) this.end(l.split(' ')[1]);
  }
  end(best) {
    const j = this.cur, nx = this.next; this.cur = null; this.next = null;
    const sg = j.o.fen.split(' ')[1]==='w' ? 1 : -1;   // engine scores are side-to-move; convert to White's point of view
    const ls = Object.keys(this.lines).sort((a,b)=>a-b).map(k => ({...this.lines[k], sc:this.lines[k].raw*sg}));
    j.res(nx ? null : {best, lines:ls, ms:performance.now()-this.t0});
    if (nx) this.start(nx);
  }
  async go(o) {
    await this.ready; if (this.failed) return null;
    return new Promise(res => {
      const j = {o,res};
      if (this.cur) { if (this.next) this.next.res(null); this.next = j; this.post('stop'); } else this.start(j);
    });
  }
  start(j) {
    const o = j.o; this.cur = j; this.lines = {}; this.t0 = performance.now();
    this.post('setoption name MultiPV value '+(o.mpv||1));
    this.post('setoption name Skill Level value '+(o.skill ?? 20));
    this.post('position fen '+o.fen);
    this.post('go movetime '+o.ms);
  }
}

/* ---------------- Chess helpers ---------------- */
function san(fen,u) { const m = new Chess(fen).move(mvObj(u)); return m ? m.san : null; }
function pvText(fen,pv,k=7) {
  const c = new Chess(fen); let n = +fen.split(' ')[5]||1, o = [], first = true;
  for (const u of pv.slice(0,k)) { const col = c.turn(), m = c.move(mvObj(u)); if (!m) break; o.push((col==='w'?n+'. ':first?n+'… ':'')+m.san); if (col==='b') n++; first = false; }
  return o.join(' ');
}
function mat(c) { const m = {w:0,b:0}; for (const r of c.board()) for (const p of r) if (p) m[p.color] += VAL[p.type]; return m; }
function phase(c) { let t = 0; for (const r of c.board()) for (const p of r) if (p && p.type!=='p' && p.type!=='k') t += VAL[p.type]; return t<=26?'Endgame':(c.history().length<20&&t>=48)?'Opening':'Middlegame'; }
const diffLabel = d => d<=20?'Easy':d<=40?'Beginner':d<=60?'Intermediate':d<=80?'Advanced':'Expert';
const evalClass = sc => { const a = Math.abs(sc), s = sc>0?'White':'Black'; if (a>=9000) return s+' has a forced checkmate'; return a<30?'Equal position':a<90?'Slightly better for '+s:a<200?s+' is better':a<400?s+' is clearly better':s+' is winning'; };

/* Position Difficulty Score 0-100: mobility, forcing moves, "only move" gap, candidate density, balance, imbalance, check, king pressure */
function difficulty(c, lines) {
  const mv = c.moves({verbose:true}), n = mv.length; if (!n) return 0;
  const t = c.turn(), f = l => t==='w'?wp(l.sc):100-wp(l.sc);
  let d = Math.min(n,45)/45*16;
  const caps = mv.filter(m=>m.captured).length, chk = mv.filter(m=>/[+#]/.test(m.san)).length;
  d += Math.min(caps+1.5*chk,10)/10*16;
  if (lines.length) {
    const f0 = f(lines[0]);
    if (lines[1]) d += Math.min(f0-f(lines[1]),30)/30*22;
    d += Math.min(lines.filter(l=>f0-f(l)<6).length-1,2)/2*8;
    d += 14*(1-Math.abs(wp(lines[0].sc)-50)/50);
  }
  const m = mat(c); d += Math.min(Math.abs(m.w-m.b),4)/4*6; if (c.in_check()) d += 8;
  let ks = null, E = [];
  c.board().forEach((r,y) => r.forEach((p,x) => { if (!p) return; if (p.type==='k'&&p.color===t) ks = [x,y]; else if (p.color!==t&&p.type!=='p'&&p.type!=='k') E.push([x,y]); }));
  if (ks) d += Math.min(E.filter(e=>Math.max(Math.abs(e[0]-ks[0]),Math.abs(e[1]-ks[1]))<=3).length,4)*2.5;
  return Math.round(clamp(d,0,100));
}
/* tactical opportunities for the side to move in `fen` (mate in one, material-winning captures) */
function tacs(fen) {
  const c = new Chess(fen), o = [];
  for (const m of c.moves({verbose:true})) {
    c.move(m);
    if (c.in_checkmate()) o.push([99,`${m.san} is checkmate`]);
    else if (m.captured) { const rec = c.moves({verbose:true}).some(x=>x.to===m.to&&x.captured), g = VAL[m.captured]-(rec?VAL[m.piece]:0); if (g>=2) o.push([g,`${m.san} wins the ${NAME[m.captured]} on ${m.to}`]); }
    c.undo();
  }
  return o.sort((a,b)=>b[0]-a[0]).slice(0,3).map(x=>x[1]);
}
const threats = fen => new Chess(fen).in_check() ? ['You are in check – you must respond.'] : tacs(flipFen(fen));

/* plain-language explanation built from the actual move + engine numbers */
function why(fen, l, i, lines) {
  const c = new Chess(fen), u = l.pv[0], m = c.move(mvObj(u)); if (!m) return '';
  const mover = m.color, P = [], mine = s => mover==='w'?s:-s;
  if (Math.abs(l.sc) >= 9000) P.push(mine(l.sc)>0 ? `Forces checkmate in ${10000-Math.abs(l.sc)}.` : 'Delays checkmate as long as possible; the position is lost against best play.');
  if (m.captured) P.push(`Captures the ${NAME[m.captured]} on ${m.to}`+(c.moves({verbose:true}).some(x=>x.to===m.to&&x.captured) ? ', but it can be recaptured, so this is a trade.' : ' and it cannot be taken back.'));
  if (m.promotion) P.push(`Promotes the pawn to a ${NAME[m.promotion]}.`);
  if (m.flags.includes('k')||m.flags.includes('q')) P.push('Castles: the king gets safer and the rook joins the game.');
  if (/[+#]/.test(m.san) && !/#/.test(m.san)) P.push('Gives check, forcing the opponent to respond.');
  if (!P.length && ['n','b'].includes(m.piece) && +fen.split(' ')[5] < 11) P.push(`Develops the ${NAME[m.piece]} to an active square.`);
  if (!P.length && m.piece==='p' && ['d4','e4','d5','e5'].includes(m.to)) P.push('Claims central space.');
  const th = (c.game_over() || c.in_check()) ? [] : tacs(flipFen(c.fen()));
  if (th.length) P.push('Next it threatens: '+th[0]+'.');
  if (i === 0 && lines[1] && Math.abs(l.sc) < 9000) { const g = Math.abs(l.sc-lines[1].sc)/100; P.push(g >= 1 ? `It is about ${g.toFixed(1)} pawns better than the second choice.` : 'Several moves are close in value; this one is the most accurate.'); }
  if (i > 0 && Math.abs(l.sc) < 9000 && Math.abs(lines[0].sc) < 9000) P.push(`A reasonable alternative, about ${(Math.abs(lines[0].sc-l.sc)/100).toFixed(1)} pawns below the best move.`);
  if (P.length <= 1 && !m.captured) P.unshift('Improves piece coordination while keeping the position under control.');
  return P.join(' ');
}

/* ---------------- State ---------------- */
let eng, game = new Chess(), mode = 'play', user = 'w', level = 'int', sel = null, legal = [], flip = false, gen = 0;
let flagged = null, thinking = false, recs = [], cls = [], tl = [], rdo = [], clk = {w:3e5,b:3e5}, inc = 0, clockOn = false;
let last = performance.now(), tk = 0, budget = 0, skillNow = 8, TT = [], ch = null;
const H = () => game.history({verbose:true});
const ended = () => flagged || (game.game_over() ? (game.in_checkmate() ? (game.turn()==='w'?'Black':'White')+' wins by checkmate' : game.in_stalemate() ? 'Draw by stalemate' : 'Draw (repetition, 50-move rule or insufficient material)') : null);

/* ---------------- Board component ---------------- */
function Board(el, h) {
  this.el = el; this.flip = false;
  this.draw = (map, marks = {}) => {
    el.innerHTML = '';
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
      const rr = this.flip?7-r:r, ff = this.flip?7-f:f, s = FILES[ff]+(8-rr), p = map[s];
      const d = document.createElement('div');
      d.className = 'sq '+((rr+ff)%2?'dk':'lt')+(marks[s]?' '+marks[s]:''); d.dataset.sq = s;
      if (r === 7) d.dataset.f = FILES[ff]; if (f === 0) d.dataset.r = 8-rr;
      if (p) { const e = document.createElement('span'); e.className = 'pc '+p[0]; e.textContent = GLY[p[1]]; e.draggable = true; e.ondragstart = ev => ev.dataTransfer.setData('text','sq:'+s); d.appendChild(e); }
      d.onclick = () => h.click(s); d.ondragover = ev => ev.preventDefault();
      d.ondrop = ev => { ev.preventDefault(); h.drop(ev.dataTransfer.getData('text'), s); };
      el.appendChild(d);
    }
  };
}
const B = new Board($('board'), {click: s => mainClick(s), drop: (src,dst) => { if (src.startsWith('sq:')) tryMove(src.slice(3),dst); }});

const canMove = () => !ended() && !thinking && (mode==='analysis' || game.turn()===user);
function mainClick(s) {
  if (sel && tryMove(sel,s)) return;
  const p = game.get(s);
  if (p && canMove() && p.color===game.turn()) { sel = s; legal = game.moves({square:s,verbose:true}).map(m=>m.to); } else { sel = null; legal = []; }
  renderBoard();
}
function tryMove(from,to) {
  if (!canMove()) return false;
  const mv = game.moves({square:from,verbose:true}).filter(m=>m.to===to); if (!mv.length) return false;
  let pr; if (mv[0].promotion) { pr = (prompt('Promote to q, r, b or n?','q')||'q').toLowerCase()[0]; if (!'qrbn'.includes(pr)) pr = 'q'; }
  if (!game.move({from,to,promotion:pr})) return false;
  sel = null; legal = []; rdo = []; afterMove(); return true;
}

/* ---------------- Game flow ---------------- */
function readTC() { const v = $('tc').value; if (v==='custom') return [Math.round(+$('cm').value*60000)||60000, Math.round(+$('ci').value*1000)||0]; const [m,i] = v.split('+'); return [m*60000, i*1000]; }
function newGame(fen, fromEditor) {
  gen++; game = new Chess();
  if (fen && !game.load(fen)) { setStatus('Invalid FEN: '+fen, true); game = new Chess(); }
  mode = $('mode').value; level = $('level').value;
  const c = $('color').value; user = fromEditor ? game.turn() : c==='r' ? (Math.random()<.5?'w':'b') : c;
  flip = user==='b'; B.flip = flip;
  recs = []; cls = []; rdo = []; sel = null; legal = []; flagged = null; clockOn = false; thinking = false;
  const [t,i] = readTC(); inc = i; clk = {w:t,b:t}; tl = [{...clk}];
  $('customBar').classList.toggle('hide', !fromEditor); $('review').innerHTML = '';
  renderAll(); startFlow(gen);
}
async function startFlow(my) { await analyseCurrent(my); if (my===gen && mode==='play') engineMove(); }
async function afterMove() {
  gen++; const my = gen, n = game.history().length, mv = H()[n-1];
  if (mode==='play') { if (clockOn) clk[mv.color] += inc*1000; clockOn = true; }
  tl[n] = {w:clk.w,b:clk.b}; renderAll();
  await analyseCurrent(my); if (my===gen && mode==='play') engineMove();
}
function thinkMs() {
  const n = game.history().length, p = recs[n-1]; let ms = 1100;
  if (game.moves().length <= 2) ms = 250; else if (p) ms *= 0.7+p.diff/60;          // critical positions get more time
  if (mode==='play') { if (clk[user] < 20000) ms *= 0.4; else if (clk[user] < 60000) ms *= 0.7; } // quick advice when your clock is low
  return Math.round(Math.min(ms,5000));
}
async function evalFen(fen, ms) {
  const c = new Chess(fen);
  if (c.game_over()) return {fen,lines:[],sc:c.in_checkmate()?(c.turn()==='w'?-10000:10000):0,depth:0,nodes:0,ms:0,diff:0};
  const res = await eng.go({fen,ms,mpv:3,skill:20}); if (!res) return null;
  const lines = res.lines.filter(l => san(fen,l.pv[0]));                            // never expose an illegal suggestion
  if (!lines.length) return null;
  return {fen,lines,sc:lines[0].sc,depth:lines[0].depth,nodes:Math.max(...lines.map(l=>l.nodes)),ms:res.ms,diff:difficulty(c,lines)};
}
async function analyseCurrent(my = gen, ms) {
  const n = game.history().length; if (recs[n] && !ms) { renderAll(); return; }
  budget = ms || thinkMs(); $('status').textContent = 'Analysing…';
  const r = await evalFen(game.fen(), budget); if (!r || my !== gen) return;
  recs[n] = r; recs.length = n+1; if (n>0) classify(n); setStatus('Stockfish ready'); renderAll();
}
function adaptive(r,t) {
  let s = LV[level][0]; if (level==='max') return skillNow = 20;
  if (r) { const f = t==='w'?wp(r.sc):100-wp(r.sc); s += f>80?-3:f>65?-1:f<25?1:0; s += r.diff>70?1:0; }  // balanced challenge, no random blunders
  if (clk[t] < 15000) s -= 2;
  return skillNow = clamp(s,0,20);
}
async function engineMove() {
  if (ended() || mode!=='play' || game.turn()===user) return;
  const my = gen, n = game.history().length, r = recs[n], t = game.turn(); thinking = true; $('status').textContent = 'Engine thinking…';
  const skill = adaptive(r,t); let u;
  if (skill >= 20 && r && r.lines[0]) u = r.lines[0].pv[0];
  else { const ms = Math.round(clamp((clk[t]/30000+inc/1000*.7)*1000*(0.5+(r?r.diff:30)/70),150,6000)); const x = await eng.go({fen:game.fen(),ms,mpv:1,skill}); if (!x || my!==gen) { thinking = false; return; } u = x.best; }
  thinking = false; if (my !== gen) return;
  if (!game.move(mvObj(u))) { setStatus('Engine returned an illegal move – ignored', true); return; }
  afterMove();
}
function classify(n) {
  const a = recs[n-1], b = recs[n], mv = H()[n-1]; if (!a || !b || !a.lines.length || !mv) return;
  const w = mv.color==='w', f = s => w?wp(s):100-wp(s), u = mv.from+mv.to+(mv.promotion||''), best = a.lines[0].pv[0]===u;
  const loss = best ? 0 : Math.max(0, f(a.sc)-f(b.sc)); let k;
  if (best) k = (a.lines[1] && f(a.sc)-f(a.lines[1].sc) >= 15) ? 'Great' : 'Best';
  else k = loss<2?'Excellent':loss<5?'Good':loss<10?'Inaccuracy':loss<20?'Mistake':'Blunder';
  cls[n] = {k, loss, acc:clamp(103.1668*Math.exp(-0.04354*loss)-3.1669,0,100), swing:Math.abs(wp(b.sc)-wp(a.sc))};
}
function undo() {
  if (!game.history().length) return; gen++; thinking = false;
  do { rdo.push(game.undo()); } while (mode==='play' && game.turn()!==user && game.history().length);
  afterJump();
}
function redo() {
  if (!rdo.length) return; gen++;
  do { game.move(rdo.pop()); } while (mode==='play' && game.turn()!==user && rdo.length);
  afterJump();
}
function afterJump() { const n = game.history().length; if (tl[n]) clk = {...tl[n]}; clockOn = n>0 && mode==='play'; flagged = null; sel = null; legal = []; recs.length = Math.min(recs.length,n+1); renderAll(); startFlow(gen); }

/* ---------------- Clocks ---------------- */
function tick() {
  const now = performance.now(), dt = now-last; last = now; tk++;
  if (mode==='play' && clockOn && !ended()) { const t = game.turn(); clk[t] -= dt; if (clk[t] <= 0) { clk[t] = 0; flagged = (t==='w'?'Black':'White')+' wins on time'; renderAll(); } }
  drawClocks(); if (tk%5===0) renderEval();
}
function drawClocks() {
  for (const c of ['w','b']) { $('t'+c).textContent = mmss(clk[c]); $('c'+c).classList.toggle('low', clk[c]<15000); $('c'+c).classList.toggle('active', mode==='play'&&clockOn&&!ended()&&game.turn()===c); }
}

/* ---------------- Practical advantage (separate from Stockfish eval) ----------------
   Parametric logistic model (NOT fitted to a dataset): engine score in logit space + a bounded shift for the
   difference in estimated human-error probability, which grows when seconds-per-remaining-move is short
   relative to what the position demands. Shift is damped when the engine score is large and zero for forced mates. */
function practical() {
  const n = game.history().length, r = recs[n]; if (!r) return null;
  const sc = r.sc, d = r.diff||30, rem = Math.max(12, 40-n/2);
  const err = s => { const avail = (clk[s]/1000 + inc/1000*rem)/rem, need = 2+d/10; return 1-Math.exp(-0.18*(need/Math.max(avail,.2))*(0.4+d/100)); };
  const ew = err('w'), eb = err('b');
  const shift = Math.abs(sc)>=9000 ? 0 : clamp(5*(eb-ew),-1.2,1.2)*Math.exp(-Math.abs(sc)/600);
  const w = 100/(1+Math.exp(-(0.00368*clamp(sc,-1500,1500)+shift)));
  return {w, shift, ew, eb};
}
function practicalAdvice(r, p) {
  if (!r || !p || ended() || mode!=='play' && !clockOn) return 'Clock-based advice appears once a timed game is running.';
  const t = game.turn(), o = t==='w'?'b':'w', me = clk[t], op = clk[o], m = mat(game), md = (m[t]-m[o]), f = x => t==='w'?x:-x;
  const near = r.lines.filter(l => Math.abs(l.sc-r.lines[0].sc) <= 60), c = new Chess(r.fen);
  const info = l => { const x = new Chess(r.fen), mv = x.move(mvObj(l.pv[0])); return {l, mv, rep:x.moves().length, forcing:/[+#]/.test(mv.san)||!!mv.captured}; };
  const cand = near.map(info), timeEdge = me > 2*op && me-op > 20000, oppSevere = op < 20000, ahead = f(r.sc) >= 150 || md >= 2;
  if (ahead && (oppSevere || op < me)) { const s = cand.sort((a,b)=>a.rep-b.rep)[0]; return `You are ahead and ${oppSevere?'your opponent is in severe time trouble':'have the safer position'}: prefer simple, accurate play such as ${s.mv.san}, which leaves the opponent ${s.rep} replies.`; }
  if (timeEdge || oppSevere) { const s = cand.sort((a,b)=>(b.rep+8*b.forcing)-(a.rep+8*a.forcing))[0]; return `You have the clock advantage${f(r.sc)<0?' despite being worse':''}: a practical try within the engine's top choices is ${s.mv.san}, which keeps pressure and forces difficult decisions. Engine still rates it ${fmt(s.l.sc)}.`; }
  return 'No clock-based preference right now; the engine\'s top move is also the practical choice.';
}

/* ---------------- Rendering ---------------- */
function drawArrows(r) {
  const xy = s => { let x = FILES.indexOf(s[0]), y = 8-s[1]; if (flip) { x = 7-x; y = 7-y; } return [x+.5,y+.5]; };
  const cols = ['#2ea043','#388bfd','#d29922']; let h = '';
  if (r) r.lines.slice(0,3).forEach((l,i) => { const [x1,y1] = xy(l.pv[0].slice(0,2)), [x2,y2] = xy(l.pv[0].slice(2,4));
    h += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${cols[i]}" stroke-width="${.16-.04*i}" stroke-linecap="round" opacity=".8"/><circle cx="${x2}" cy="${y2}" r="${.24-.04*i}" fill="${cols[i]}" opacity=".85"/>`; });
  $('arrows').innerHTML = h;
}
function renderBoard() {
  const map = {}, ks = {}; game.board().forEach((row,r) => row.forEach((p,f) => { if (p) { const s = FILES[f]+(8-r); map[s] = p.color+p.type; if (p.type==='k') ks[p.color] = s; } }));
  const mk = {}, h = H(), l = h[h.length-1]; if (l) { mk[l.from] = 'last'; mk[l.to] = 'last'; }
  if (game.in_check()) mk[ks[game.turn()]] = (mk[ks[game.turn()]]||'')+' chk';
  legal.forEach(s => mk[s] = (mk[s]||'')+(map[s]?' cap':' dot')); if (sel) mk[sel] = (mk[sel]||'')+' sel';
  B.draw(map, mk); drawArrows(recs[game.history().length]);
}
function renderEval() {
  const n = game.history().length, r = recs[n], res = ended(); drawClocks();
  $('banner').classList.toggle('hide', !res); $('banner').innerHTML = res ? '<b>'+res+'</b>' : '';
  if (!r) return;
  const sc = r.sc, m = mat(game), md = m.w-m.b, p = practical();
  $('evbar').className = (sc>=0?'pos-w':'pos-b')+(flip?' flipped':''); $('evw').style.height = clamp(wp(sc),2,98)+'%'; $('evl').textContent = fmt(sc);
  $('c-eng').innerHTML = `<small>Engine evaluation</small><b>${fmt(sc)}</b><em>White expected score ${Math.round(wp(sc))}%</em>`;
  $('c-mat').innerHTML = `<small>Material</small><b>${md?(md>0?'White +':'Black +')+Math.abs(md):'Equal'}</b><em>${m.w} vs ${m.b} points</em>`;
  $('c-prac').innerHTML = `<small>Practical advantage (estimate)</small><b>${p.w>=50?'White':'Black'} ${Math.round(Math.max(p.w,100-p.w))}%</b><em>clock shift ${p.shift>=0?'+':''}${p.shift.toFixed(2)} logit</em>`;
  $('pbar').style.width = p.w+'%'; $('cls').textContent = evalClass(sc)+' · Position '+diffLabel(r.diff).toLowerCase()+' ('+r.diff+'/100). Percentages are model estimates, not guarantees.';
  const W = [], low = c => clk[c] < 15000 || (clk[c]/1000+inc/1000*20)/20 < 3;
  if (clk.w > 2*clk.b && clk.w-clk.b > 20000) W.push(['Time Advantage: White']); if (clk.b > 2*clk.w && clk.b-clk.w > 20000) W.push(['Time Advantage: Black']);
  for (const c of ['w','b']) if (low(c)) W.push(['Severe Time Pressure: '+(c==='w'?'White':'Black'),1]);
  if (Math.abs(md) >= 1) W.push(['Material Advantage: '+(md>0?'White':'Black')]);
  if (Math.abs(p.w-wp(sc)) >= 8 || (p.w-50)*(wp(sc)-50) < 0 && Math.abs(p.w-wp(sc)) > 3) W.push(['Practical Advantage differs from Engine Advantage',1]);
  if (cls[n] && cls[n].swing >= 20) W.push(['Major evaluation swing ('+cls[n].k+')',1]);
  $('warn').innerHTML = W.map(x => `<span class="chip${x[1]?' red':''}">${x[0]}</span>`).join('');
  $('advice').textContent = practicalAdvice(r,p);
}
function renderLines() {
  const n = game.history().length, r = recs[n];
  if (!r || !r.lines.length) { $('lines').innerHTML = `<p class="mut">${ended()||'Waiting for the engine…'}</p>`; $('tac').innerHTML = ''; return; }
  $('lines').innerHTML = r.lines.map((l,i) => `<div class="ln c${i}"><div class="lh"><b>${['Best','2nd','3rd'][i]}</b><span class="mv">${san(r.fen,l.pv[0])}</span><em>${fmt(l.sc)}</em></div><div class="pv">${pvText(r.fen,l.pv)}</div><p>${why(r.fen,l,i,r.lines)}</p></div>`).join('');
  const th = threats(r.fen), op = tacs(r.fen);
  $('tac').innerHTML = `<div class="tacs"><b>Tactical opportunities for ${game.turn()==='w'?'White':'Black'}</b>${op.length?op.join('; '):'none found'}<b>Opponent threats</b>${th.length?th.join('; '):'none immediate'}${th.length&&!game.in_check()?'<b>Under pressure</b>Prefer the suggestions above that move or protect the threatened piece.':''}</div>`;
}
function acc(col) { const a = cls.map((c,i)=>c&&(i%2?'w':'b')===col?c.acc:null).filter(x=>x!==null); return a.length ? Math.round(a.reduce((x,y)=>x+y,0)/a.length)+'%' : '–'; }
function renderDash() {
  const n = game.history().length, r = recs[n], m = mat(game);
  const items = r ? [['Evaluation',fmt(r.sc)],['Best move',r.lines[0]?san(r.fen,r.lines[0].pv[0]):'–'],['Difficulty',r.diff+' · '+diffLabel(r.diff)],['Depth',r.depth],['Nodes',r.nodes>1e6?(r.nodes/1e6).toFixed(2)+'M':Math.round(r.nodes/1e3)+'k'],['Analysis time',(r.ms/1000).toFixed(1)+' s'],['Budget',budget+' ms'],['Phase',phase(game)],['Material',m.w+' – '+m.b],['Accuracy W / B',acc('w')+' / '+acc('b')],['Engine skill',mode==='play'?skillNow+' ('+(LV[level][1])+')':'–']] : [];
  $('dash').innerHTML = items.map(x => `<div><small>${x[0]}</small>${x[1]}</div>`).join('');
}
function renderMoves() {
  const h = H(); let s = '';
  h.forEach((m,i) => { if (i%2===0) s += `<span class="n">${i/2+1}.</span>`; const c = cls[i+1]; s += `<span class="${c?'k-'+c.k:''}" title="${c?c.k:''}">${m.san}${c?' '+SYM[c.k]:''}</span>`; });
  $('moves').innerHTML = s || '<span class="mut">No moves yet</span>'; $('moves').scrollTop = 1e6;
}
function renderChart() {
  const L = [], ev = [], df = [], pc = []; TT = [];
  recs.forEach((r,i) => { if (!r) return; L.push(i); ev.push(clamp(r.sc/100,-10,10)); df.push(r.diff); TT.push(tl[i]); const c = cls[i]; pc.push(c&&c.swing>=20?'#f0883e':c&&(c.k==='Blunder'||c.k==='Mistake')?'#f85149':'#58a6ff'); });
  if (!ch) ch = new Chart($('chart'), {type:'line', data:{labels:L, datasets:[{label:'Evaluation (pawns, White)',data:ev,borderColor:'#58a6ff',pointBackgroundColor:pc,tension:.25,yAxisID:'y'},{label:'Position difficulty',data:df,borderColor:'#8b949e',borderDash:[4,4],pointRadius:0,yAxisID:'y1'}]},
    options:{animation:false,maintainAspectRatio:false,scales:{y:{min:-10,max:10},y1:{position:'right',min:0,max:100,grid:{drawOnChartArea:false}}},plugins:{tooltip:{callbacks:{afterBody:i => { const t = TT[i[0].dataIndex]; return t ? `Clocks  W ${mmss(t.w)}   B ${mmss(t.b)}` : ''; }}}}}});
  else { ch.data.labels = L; ch.data.datasets[0].data = ev; ch.data.datasets[0].pointBackgroundColor = pc; ch.data.datasets[1].data = df; ch.update(); }
}
function renderAll() { renderBoard(); renderEval(); renderLines(); renderDash(); renderMoves(); if (window.Chart) renderChart(); }

/* ---------------- Game review ---------------- */
async function review() {
  const my = gen, h = H(), sf = game.header().FEN, c = sf ? new Chess(sf) : new Chess(), fens = [c.fen()];
  if (!h.length) { $('review').innerHTML = '<p class="mut">Play or load some moves first.</p>'; return; }
  for (const m of h) { c.move(mvObj(m.from+m.to+(m.promotion||''))); fens.push(c.fen()); }
  for (let i = 0; i < fens.length; i++) {
    if (!recs[i] || recs[i].fen !== fens[i]) { $('review').innerHTML = `<p class="mut">Analysing position ${i+1} of ${fens.length}…</p>`; const r = await evalFen(fens[i], 400); if (my !== gen) return; if (!r) { $('review').innerHTML = '<p class="mut">Engine unavailable.</p>'; return; } recs[i] = r; }
    if (i > 0) classify(i);
  }
  renderAll();
  const st = {w:{},b:{}}, A = {w:[],b:[]}, ids = [];
  for (let i = 1; i < fens.length; i++) { const col = h[i-1].color, k = cls[i].k; st[col][k] = (st[col][k]||0)+1; A[col].push(cls[i].acc); ids.push(i); }
  const avg = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0, mn = (i) => `${Math.ceil(i/2)}${h[i-1].color==='w'?'.':'…'} ${h[i-1].san}`;
  const bad = ids.filter(i => ['Mistake','Blunder'].includes(cls[i].k)), turning = [...ids].sort((a,b)=>cls[b].swing-cls[a].swing).slice(0,3).filter(i=>cls[i].swing>=8);
  const missed = ids.filter(i => cls[i].loss >= 10).map(i => { const t = tacs(recs[i-1].fen)[0]; return t ? `${mn(i)}: missed – ${t}` : null; }).filter(Boolean);
  const first = ids.find(i => ['Inaccuracy','Mistake','Blunder'].includes(cls[i].k));
  const tt = bad.filter(i => tl[i] && tl[i][h[i-1].color] < 30000).length, tips = [];
  if (bad.length) tips.push('Before each move, check what the opponent\'s last move attacks or threatens.'); if (tt) tips.push(`${tt} of your serious errors came with under 30 seconds left – budget time earlier.`);
  if (missed.length) tips.push('Look for captures and checks first: tactics were available that went unplayed.'); if (!tips.length) tips.push('Clean game. Try a stronger engine level or a faster time control.');
  const row = col => `${col==='w'?'White':'Black'}: <b>${Math.round(avg(A[col]))}%</b> accuracy · ` + Object.entries(st[col]).map(([k,v])=>`${v} ${k}`).join(', ');
  const li = a => '<ul>'+(a.length?a.map(x=>`<li>${x}</li>`).join(''):'<li>None</li>')+'</ul>';
  $('review').innerHTML = `<div class="rv"><h4>Overall performance</h4><p>${row('w')}<br>${row('b')}</p>
    <h4>Mistakes and blunders</h4>${li(bad.map(i=>`${mn(i)} (${cls[i].k}) – engine preferred ${san(recs[i-1].fen,recs[i-1].lines[0].pv[0])}`))}
    <h4>Critical turning points</h4>${li(turning.map(i=>`${mn(i)}: ${fmt(recs[i-1].sc)} → ${fmt(recs[i].sc)}`))}
    <h4>Opening</h4><p>${h.slice(0,10).map(m=>m.san).join(' ')}<br>${first && first<=20 ? 'First inaccuracy or worse at move '+mn(first)+'.' : 'No inaccuracies in the opening phase.'}</p>
    <h4>Tactical opportunities missed</h4>${li(missed)}<h4>Improvement suggestions</h4>${li(tips)}</div>`;
}

/* ---------------- Position Setup editor ---------------- */
const ED = {map:{},hist:[],fut:[],pick:null}, PAL = ['wk','wq','wr','wb','wn','wp','bk','bq','br','bb','bn','bp'];
const EB = new Board($('edBoard'), {click: s => edClick(s), drop: (src,dst) => edDrop(src,dst)});
const snap = () => { ED.hist.push(JSON.stringify(ED.map)); ED.fut = []; if (ED.hist.length>100) ED.hist.shift(); };
function edFen() {
  const rows = []; for (let rk = 8; rk > 0; rk--) { let s = '', e = 0; for (const f of FILES) { const p = ED.map[f+rk]; if (!p) e++; else { if (e) { s += e; e = 0; } s += p[0]==='w'?p[1].toUpperCase():p[1]; } } if (e) s += e; rows.push(s); }
  const cs = ['cK','cQ','ck','cq'].map(i => $(i).checked?i[1]:'').join('')||'-';
  return `${rows.join('/')} ${$('edTurn').value} ${cs} ${$('edEp').value.trim().toLowerCase()||'-'} ${+$('edHm').value||0} ${+$('edFm').value||1}`;
}
function edDraw() {
  EB.draw(ED.map, ED.pick&&ED.pick.startsWith('sq:') ? {[ED.pick.slice(3)]:'sel'} : {});
  document.querySelectorAll('#pal button').forEach(b => b.classList.toggle('on', ED.pick===(b.dataset.p==='x'?'erase':'pal:'+b.dataset.p)));
  $('edFen').value = edFen();
}
function edPlace(src,dst) {
  if (src==='erase') { snap(); delete ED.map[dst]; }
  else if (src.startsWith('pal:')) { snap(); ED.map[dst] = src.slice(4); }
  else if (src.startsWith('sq:') && src.slice(3)!==dst && ED.map[src.slice(3)]) { snap(); ED.map[dst] = ED.map[src.slice(3)]; delete ED.map[src.slice(3)]; ED.pick = null; }
}
function edClick(s) {
  if (ED.pick && (ED.pick==='erase' || ED.pick.startsWith('pal:'))) edPlace(ED.pick,s);
  else if (ED.pick && ED.pick.startsWith('sq:')) { if (ED.pick.slice(3)===s) ED.pick = null; else edPlace(ED.pick,s); }
  else if (ED.map[s]) ED.pick = 'sq:'+s;
  edDraw();
}
function edDrop(src,dst) { if (src.startsWith('pal:')||src.startsWith('sq:')) edPlace(src,dst); edDraw(); }
function edLoad(fen) {
  const p = fen.trim().split(/\s+/), rows = (p[0]||'').split('/'); if (rows.length!==8) { $('edErr').innerHTML = '<li>FEN needs 8 ranks separated by “/”.</li>'; return; }
  snap(); ED.map = {};
  rows.forEach((row,i) => { let f = 0; for (const ch of row) { if (/\d/.test(ch)) f += +ch; else { ED.map[FILES[f]+(8-i)] = (ch===ch.toUpperCase()?'w':'b')+ch.toLowerCase(); f++; } } });
  $('edTurn').value = p[1]==='b'?'b':'w'; const cs = p[2]||'-';
  ['K','Q','k','q'].forEach(k => $('c'+k).checked = cs.includes(k)); $('edEp').value = !p[3]||p[3]==='-'?'':p[3]; $('edHm').value = p[4]||0; $('edFm').value = p[5]||1;
  ED.pick = null; $('edErr').innerHTML = ''; edDraw();
}
function edValidate() {
  const E = [], m = ED.map, ps = Object.entries(m), cnt = p => ps.filter(x=>x[1]===p).length, tn = $('edTurn').value, nm = {w:'White',b:'Black'};
  for (const c of 'wb') {
    const k = cnt(c+'k'), pw = cnt(c+'p'), tot = ps.filter(x=>x[1][0]===c).length;
    if (k!==1) E.push(`${nm[c]} must have exactly one king (found ${k}).`);
    if (pw>8) E.push(`${nm[c]} has ${pw} pawns (maximum 8).`); if (tot>16) E.push(`${nm[c]} has ${tot} pieces (maximum 16).`);
    if (Math.max(0,cnt(c+'q')-1)+Math.max(0,cnt(c+'r')-2)+Math.max(0,cnt(c+'b')-2)+Math.max(0,cnt(c+'n')-2) > 8-pw) E.push(`${nm[c]} has more promoted pieces than the missing pawns allow.`);
  }
  if (ps.some(([s,p]) => p[1]==='p' && /[18]/.test(s[1]))) E.push('Pawns cannot stand on the 1st or 8th rank.');
  const K = c => (ps.find(x=>x[1]===c+'k')||[])[0], a = K('w'), b = K('b');
  if (a && b && Math.abs(FILES.indexOf(a[0])-FILES.indexOf(b[0]))<=1 && Math.abs(a[1]-b[1])<=1) E.push('The two kings cannot be on adjacent squares.');
  for (const [id,k,ks,r,rs,n] of [['cK','wk','e1','wr','h1','White kingside'],['cQ','wk','e1','wr','a1','White queenside'],['ck','bk','e8','br','h8','Black kingside'],['cq','bk','e8','br','a8','Black queenside']])
    if ($(id).checked && (m[ks]!==k || m[rs]!==r)) E.push(`${n} castling needs the king on ${ks} and the rook on ${rs}.`);
  const ep = $('edEp').value.trim().toLowerCase();
  if (ep) { const rk = tn==='w'?'6':'3';
    if (!/^[a-h][36]$/.test(ep) || ep[1]!==rk) E.push(`En passant square must be on rank ${rk} when ${nm[tn]} is to move.`);
    else if (m[ep] || m[ep[0]+(tn==='w'?'7':'2')] || m[ep[0]+(tn==='w'?'5':'4')]!==(tn==='w'?'bp':'wp')) E.push('En passant target does not match the pawns on the board.'); }
  if (!E.length) { const t = new Chess(); if (!t.load(edFen())) E.push('The position could not be loaded by the rules engine.'); else if (new Chess(flipFen(edFen())).in_check()) E.push(`${nm[tn==='w'?'b':'w']} is in check while ${nm[tn]} is to move – impossible position.`); }
  return E;
}
const download = (name,text) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text],{type:'text/plain'})); a.download = name; a.click(); };
const copy = t => (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(()=>setStatus('Copied'), ()=>prompt('Copy this:',t));
const saved = () => JSON.parse(localStorage.getItem('gm.saved')||'[]');
function listSaved() { $('edSaved').innerHTML = '<option value="">Saved positions…</option>'+saved().map((s,i)=>`<option value="${i}">${s.name}</option>`).join(''); }

/* ---------------- Wiring ---------------- */
function show(v) { $('v-play').classList.toggle('hide',v!=='play'); $('v-setup').classList.toggle('hide',v!=='setup'); document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('on',b.dataset.v===v)); if (v==='setup') edDraw(); else renderAll(); }
function init() {
  eng = new Engine();
  PAL.forEach(p => { const b = document.createElement('button'); b.dataset.p = p; b.draggable = true; b.innerHTML = `<span class="pc ${p[0]}">${GLY[p[1]]}</span>`; b.onclick = () => { ED.pick = 'pal:'+p; edDraw(); }; b.ondragstart = e => e.dataTransfer.setData('text','pal:'+p); $('pal').appendChild(b); });
  const x = document.createElement('button'); x.dataset.p = 'x'; x.textContent = '✕'; x.title = 'Eraser'; x.onclick = () => { ED.pick = 'erase'; edDraw(); }; $('pal').appendChild(x);
  $('pal').ondragover = e => e.preventDefault(); $('pal').ondrop = e => { e.preventDefault(); const s = e.dataTransfer.getData('text'); if (s.startsWith('sq:')) { snap(); delete ED.map[s.slice(3)]; ED.pick = null; edDraw(); } };
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => show(b.dataset.v));
  $('theme').onclick = () => { const d = document.documentElement; d.dataset.theme = d.dataset.theme==='dark'?'light':'dark'; localStorage.setItem('gm.theme',d.dataset.theme); };
  if (localStorage.getItem('gm.theme')) document.documentElement.dataset.theme = localStorage.getItem('gm.theme');
  $('newBtn').onclick = () => newGame(); $('undoBtn').onclick = undo; $('redoBtn').onclick = redo;
  $('flipBtn').onclick = () => { flip = !flip; B.flip = flip; renderAll(); };
  $('resignBtn').onclick = () => { if (!ended() && confirm('Resign this game?')) { flagged = (mode==='play'&&user==='b'?'White':mode==='play'?'Black':game.turn()==='w'?'Black':'White')+' wins by resignation'; gen++; renderAll(); } };
  $('level').onchange = () => { level = $('level').value; };
  $('mode').onchange = () => { mode = $('mode').value; clockOn = false; renderAll(); if (mode==='play') engineMove(); };
  $('tc').onchange = () => document.querySelectorAll('.cust').forEach(e => e.classList.toggle('hide', $('tc').value!=='custom'));
  $('reviewBtn').onclick = review;
  $('copyFen').onclick = () => copy(game.fen()); $('copyPgn').onclick = () => copy(game.pgn());
  $('loadFen').onclick = () => { const f = $('io').value.trim(); if (!f) return; const t = new Chess(); if (!t.load(f)) return setStatus('That FEN is not valid', true); newGame(f); };
  $('loadPgn').onclick = () => {
    const g = new Chess(); if (!g.load_pgn($('io').value.trim())) return setStatus('That PGN could not be read', true);
    gen++; game = g; mode = 'analysis'; $('mode').value = 'analysis'; recs = []; cls = []; rdo = []; clockOn = false; flagged = null; sel = null; legal = [];
    tl = []; for (let i = 0; i <= g.history().length; i++) tl[i] = {...clk}; renderAll(); startFlow(gen);
  };
  $('cbPlay').onclick = () => { $('mode').value = 'play'; newGame(game.fen(), true); };
  $('cbCont').onclick = () => analyseCurrent(gen, 8000);
  $('cbChange').onclick = () => { edLoad(game.fen()); show('setup'); };
  $('cbCopy').onclick = () => copy(game.fen()); $('cbExport').onclick = () => download('position.fen', game.fen());
  ['edTurn','cK','cQ','ck','cq','edEp','edHm','edFm'].forEach(i => $(i).onchange = edDraw);
  $('edClear').onclick = () => { snap(); ED.map = {}; ED.pick = null; edDraw(); };
  $('edReset').onclick = () => edLoad('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  $('edRemove').onclick = () => { if (ED.pick && ED.pick.startsWith('sq:')) { snap(); delete ED.map[ED.pick.slice(3)]; ED.pick = null; edDraw(); } };
  $('edFlip').onclick = () => { EB.flip = !EB.flip; edDraw(); };
  $('edUndo').onclick = () => { if (ED.hist.length) { ED.fut.push(JSON.stringify(ED.map)); ED.map = JSON.parse(ED.hist.pop()); edDraw(); } };
  $('edRedo').onclick = () => { if (ED.fut.length) { ED.hist.push(JSON.stringify(ED.map)); ED.map = JSON.parse(ED.fut.pop()); edDraw(); } };
  $('edCopy').onclick = () => copy(edFen());
  $('edPaste').onclick = () => (navigator.clipboard ? navigator.clipboard.readText() : Promise.reject()).then(edLoad, () => edLoad($('edFen').value));
  $('edFen').onchange = () => edLoad($('edFen').value);
  $('edFromMain').onclick = () => edLoad(game.fen());
  $('edSave').onclick = () => { const n = prompt('Name for this position:'); if (!n) return; const s = saved(); s.push({name:n,fen:edFen()}); localStorage.setItem('gm.saved',JSON.stringify(s)); listSaved(); };
  $('edSaved').onchange = () => { const s = saved()[$('edSaved').value]; if (s) edLoad(s.fen); };
  $('edExport').onclick = () => download('position.fen', edFen());
  $('edAnalyse').onclick = () => { const E = edValidate(); $('edErr').innerHTML = E.map(e=>`<li>${e}</li>`).join(''); if (E.length) return; $('mode').value = 'analysis'; newGame(edFen(), true); show('play'); };
  listSaved(); edLoad('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'); ED.hist = [];
  newGame(); setInterval(tick, 200);
}
init();
