# GRANDMASTER AI

Chess analysis app: Stockfish in a Web Worker, chess.js rules, Chart.js timeline. No build step, no backend.

## Run locally
    cd grandmaster-ai
    python3 -m http.server 8000      # or: npx serve .
Open http://localhost:8000. Needs internet on first load for the CDN scripts (chess.js, Chart.js, Stockfish).

## Deploy
Upload the four files (index.html, style.css, app.js, README.md) to any static host: GitHub Pages, Netlify, Cloudflare Pages, Vercel.

## Engine
Default: Stockfish 10 (asm.js build, cdnjs), loaded via a blob worker so it works from any origin.
For the faster WASM build: `npm i stockfish`, copy its `stockfish*.js` and `.wasm` files next to index.html, then run
`localStorage.setItem('gm.engine','stockfish-nnue-16-single.js')` in the browser console and reload (same-origin path = loaded directly).
If loading fails, the status pill shows the error; the board still works for manual play.

## How the numbers work
- Evaluation bar, top-3 moves, PV, depth, nodes: straight from Stockfish (MultiPV 3). Clocks never change them.
- Practical advantage: separate logistic model = engine score + bounded shift from estimated human-error probability per side
  (seconds per remaining move vs what the position demands). Zero for forced mates, damped when the engine lead is large.
  Constants are hand-set, NOT fitted to game data. Treat as an estimate; tune in `practical()` in app.js.
- Position Difficulty 0-100: mobility, forcing moves, only-move gap, close candidates, balance, imbalance, check, king pressure.
- Move classes: win-probability loss between the engine's evaluation before and after the move.
- Adaptive strength: Stockfish "Skill Level" per level, nudged by position difficulty, evaluation and your/its clock. No random blunders.
