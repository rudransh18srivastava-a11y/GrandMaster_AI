#!/usr/bin/env node
/* GRANDMASTER AI — scripts/setup-engine.js
   Copies the Stockfish WebAssembly engine and chess.js out of node_modules into the
   project folders the browser loads from:

     engine/   Stockfish .js + .wasm (+ engine.json telling the app which file to start)
     lib/      chess.js (ES module build)

   Usage:  npm install && npm run setup
           npm run setup -- --full      use the strongest single-threaded build (~94 MB) instead of "lite"
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nm = path.join(root, 'node_modules');
const full = process.argv.includes('--full');

const fail = (msg) => { console.error('\n✖ ' + msg + '\n'); process.exit(1); };
const ok = (msg) => console.log('✔ ' + msg);
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

/* ------------------------------------------------------------- Stockfish -- */

const sfDir = path.join(nm, 'stockfish');
if (!fs.existsSync(sfDir)) fail('node_modules/stockfish not found. Run "npm install" first.');

const sfPkg = JSON.parse(fs.readFileSync(path.join(sfDir, 'package.json'), 'utf8'));
const searchDirs = ['bin', 'src', 'build', 'dist', '.'].map((d) => path.join(sfDir, d)).filter((d) => fs.existsSync(d));

/** Candidate engine scripts, best first. We need a single-threaded build: it runs on any static host
    without the COOP/COEP headers that multi-threaded builds require. */
const wanted = full
  ? [/^stockfish-[\d.]+-single\.js$/, /^stockfish.*-single\.js$/, /^stockfish.*lite-single\.js$/]
  : [/^stockfish-[\d.]+-lite-single\.js$/, /^stockfish.*lite-single\.js$/, /^stockfish.*-single\.js$/];

let chosen = null;
for (const re of wanted) {
  for (const dir of searchDirs) {
    const hit = fs.readdirSync(dir).filter((f) => re.test(f)).sort().reverse()[0];
    if (hit) { chosen = { dir, file: hit }; break; }
  }
  if (chosen) break;
}
if (!chosen) {
  const seen = searchDirs.flatMap((d) => fs.readdirSync(d).filter((f) => /\.(js|wasm)$/.test(f)).map((f) => path.relative(sfDir, path.join(d, f))));
  fail(`No single-threaded Stockfish build found in node_modules/stockfish (v${sfPkg.version}).\nFound: ${seen.join(', ') || 'nothing'}\nSee the README → "Troubleshooting".`);
}

const base = chosen.file.replace(/\.js$/, '');
const engineOut = path.join(root, 'engine');
fs.rmSync(engineOut, { recursive: true, force: true });
fs.mkdirSync(engineOut, { recursive: true });

const parts = fs.readdirSync(chosen.dir).filter((f) => f === chosen.file || (f.startsWith(base) && f.endsWith('.wasm')) || (f.startsWith(base) && /\.(wasm|nnue|data)$/.test(f)));
if (!parts.some((f) => f.endsWith('.wasm'))) {
  console.warn(`! No .wasm file next to ${chosen.file} — assuming a pure JavaScript (asm.js) build.`);
}
let total = 0;
for (const f of parts) {
  fs.copyFileSync(path.join(chosen.dir, f), path.join(engineOut, f));
  total += fs.statSync(path.join(engineOut, f)).size;
}
fs.writeFileSync(path.join(engineOut, 'engine.json'), JSON.stringify({
  script: chosen.file,
  label: `Stockfish ${sfPkg.version} (${full ? 'full' : 'lite'}, WebAssembly, single-thread)`,
  version: sfPkg.version,
}, null, 2) + '\n');
// GPL: ship the licence with the binaries
for (const lic of ['Copying.txt', 'COPYING.txt', 'LICENSE', 'LICENSE.md', 'COPYING']) {
  if (fs.existsSync(path.join(sfDir, lic))) { fs.copyFileSync(path.join(sfDir, lic), path.join(engineOut, 'LICENSE-stockfish.txt')); break; }
}
ok(`Stockfish ${sfPkg.version}: copied ${parts.join(', ')} (${mb(total)}) → engine/`);

/* --------------------------------------------------------------- chess.js -- */

const cjDir = path.join(nm, 'chess.js');
if (!fs.existsSync(cjDir)) fail('node_modules/chess.js not found. Run "npm install" first.');
const cjPkg = JSON.parse(fs.readFileSync(path.join(cjDir, 'package.json'), 'utf8'));
const esm = path.join(cjDir, 'dist', 'esm');
if (!fs.existsSync(path.join(esm, 'chess.js'))) fail(`chess.js ${cjPkg.version}: dist/esm/chess.js not found. This app needs chess.js 1.x.`);
const libOut = path.join(root, 'lib');
fs.rmSync(libOut, { recursive: true, force: true });
fs.mkdirSync(libOut, { recursive: true });
for (const f of fs.readdirSync(esm).filter((n) => n.endsWith('.js'))) fs.copyFileSync(path.join(esm, f), path.join(libOut, f));
ok(`chess.js ${cjPkg.version} → lib/`);

console.log('\nDone. Start the app with:  npm start   (then open http://localhost:8080)\n');
