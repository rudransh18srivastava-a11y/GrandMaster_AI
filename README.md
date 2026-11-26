# GRANDMASTER AI — Chess Position Analysis Engine

A lightweight, browser-only chess **analysis** tool. You set up or play any position by hand; Stockfish (WebAssembly, in a Web Worker) shows the **four best moves** with evaluation, principal variation, depth and a short explanation, plus a live evaluation bar and editable chess clocks.

**Analysis only.** There is no opponent, no bot, no auto-play and no "play vs AI" mode. Every move on the board is made by you.

## Quick start

Requires Node.js 18+ (only for fetching the engine files and serving locally).

```bash
npm install          # downloads stockfish + chess.js
npm run setup        # copies the Stockfish .js/.wasm into engine/ and chess.js into lib/
npm start            # serves the app at http://localhost:8080
```

Open <http://localhost:8080>. The status pill (top right) turns green when Stockfish is ready.

> The app must be served over HTTP(S) — opening `index.html` with a double-click (`file://`) cannot load ES modules, Web Workers or WebAssembly.

Want the strongest build? `npm run setup -- --full` uses the full single-threaded Stockfish (~94 MB instead of ~1.7 MB "lite"). Lite is the default: it loads instantly and is plenty for analysis.

## What's inside

```
index.html            page layout
css/style.css         light/dark themes, responsive grid
js/core.js            pure logic: FEN, validation, score maths, UCI parser, Clock model, heuristics   (unit-tested)
js/rules.js           chess.js adapter (legal moves, check/mate/stalemate, replaying engine lines)
js/engine.js          Stockfish Web Worker wrapper: UCI, MultiPV 4, stop/restart handling, limits
js/board.js           board rendering + mouse/touch drag-and-drop (Pointer Events), arrows
js/pieces.js          built-in SVG piece set (no image files)
js/app.js             application: timeline, clocks, analysis pipeline, panels, editor, saved positions
scripts/setup-engine.js   copies engine + chess.js out of node_modules
scripts/serve.js          zero-dependency static server (correct MIME types incl. application/wasm)
tests/core.test.js        unit tests  →  npm test
engine/  lib/         created by `npm run setup` (generated, not hand-written)
```

## How it works

* **Engine:** `engine.js` starts the Stockfish worker, sets `MultiPV 4`, and sends `position fen …` + `go`. Everything shown — scores, moves, PVs, depth, nodes, speed — is parsed from Stockfish's `info` lines. Nothing is generated or estimated. A result is shown only once all four lines have reported for the same depth, so the list never mixes depths.
* **Scores** are converted to White's point of view for display. Mate scores show as `M3` / `-M3`.
* **Explanations** are short summaries built from facts: the engine score gap to the other candidates, captures/checks/castling/promotion in the move, and material change along the engine's own line. They are not extra engine output.
* **Clocks never touch evaluation.** The right-hand "Position & time context" card keeps the objective position (material, Stockfish-derived positional edge, difficulty, tactical complexity) separate from the practical clock info (time left, difference, increment, time-pressure, who has more time).
* **Position difficulty** comes from the real spread between the engine's candidate scores (an "only move" position is hard). **Tactical complexity** counts captures, checks and pieces en prise in the position.
* **Clock rules:** clocks are optional. Click a time to type it (`5:00`, `1:30:00`, `90`, `5m`, `1h30m`). While a clock is running, a move adds the increment to the mover and starts the opponent's clock. If the clocks are stopped, moves do not change time (tick "Add increment on every move…" if you want them to). Undo/redo/jump never change time.
* **Saved positions** and settings use `localStorage`.

## Using it

| Action | How |
|---|---|
| Move | Drag a piece, or click it then click a target square (legal squares are dotted). Works with mouse and touch. |
| Undo / Redo / Flip | Buttons, or ← / → / F keys. Click any move in the history to jump to it. |
| Custom position | **Edit position**: tap a palette piece then squares (tap again to remove), drag pieces from the palette, drag board pieces around, use the eraser or right-click to remove. Set side to move, castling and en passant, then **Apply & analyse**. The editor rejects impossible positions (missing king, pawn on back rank, side not to move in check, too many pieces). |
| Clear / Reset | **Clear** opens the editor on an empty board; **Reset** returns to the start position. |
| FEN | Current FEN is always shown with a Copy button; paste into **Import FEN** to load. |
| Analysis | Automatic mode re-analyses after every change; Manual mode analyses only when you press **Start**. Limits: depth (none/10–40/custom) and time (1, 3, 5, 10, 30 s, unlimited, custom); the first limit reached ends the search. |

## Deployment

The app is 100% static files. Run `npm install && npm run setup` once, then upload the folder **including `engine/` and `lib/`** (you can leave out `node_modules/`, `tests/` and `scripts/`).

**GitHub Pages**
1. Run the setup commands locally.
2. Remove `engine/` and `lib/` from `.gitignore` if you add one — they must be committed.
3. Push to GitHub → *Settings → Pages* → deploy from the `main` branch, root folder.
4. Open `https://<user>.github.io/<repo>/`.

**Netlify / Vercel / Cloudflare Pages / any static host:** publish the project root as a static site (no build command; output directory `.`).

**Nginx / Apache:** serve the folder and make sure `.wasm` is sent as `application/wasm` and `.js` as `text/javascript`.

No special headers are needed: the single-threaded Stockfish build does not use `SharedArrayBuffer`, so it works on GitHub Pages as-is. HTTPS is recommended (needed only for clipboard "Copy" on some browsers).

## Troubleshooting

* **"Stockfish files not found in /engine"** — run `npm run setup`, and make sure `engine/engine.json` is deployed.
* **Status stays on "Starting Stockfish…"** — the `.wasm` file must sit next to the engine `.js` file and be served as `application/wasm`.
* **"chess.js is missing" screen** — run `npm run setup` (it creates `lib/chess.js`). If `lib/` is absent the app falls back to loading chess.js from the jsDelivr CDN.
* **Setup says no single-threaded build found** — the Stockfish npm package layout may have changed. Look in `node_modules/stockfish/` for a file named like `stockfish-*-lite-single.js` plus its `.wasm`, copy both into `engine/`, and create `engine/engine.json` containing `{"script": "<that .js file name>", "label": "Stockfish"}`.
* **Slow on a phone** — pick a time limit (3–5 s) and a lower depth limit.

## Tests

```bash
npm test
```
Runs the unit tests for FEN handling, setup validation, score maths, UCI parsing, the clock model and the heuristics.

## Licence

Stockfish is GPL-3.0; the app bundles/links it, so distribute the app under GPL-3.0-or-later and keep `engine/LICENSE-stockfish.txt` (copied by the setup script). chess.js is BSD-2-Clause.
