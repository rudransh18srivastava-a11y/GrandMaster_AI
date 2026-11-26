/* GRANDMASTER AI — pieces.js
   Self-contained SVG piece set (no external image files, identical on every device).
   Colours come from CSS (.pc-w / .pc-b), so themes can restyle them. */

const BASE = '<rect x="24" y="80" width="52" height="11" rx="4"/>';

const SHAPES = {
  P: `<g class="body">
        <path d="M43 42 H57 C57 50 63 55 66 62 C69 68 68 75 71 81 H29 C32 75 31 68 34 62 C37 55 43 50 43 42 Z"/>
        <rect x="35" y="38" width="30" height="8" rx="4"/>
        <circle cx="50" cy="28" r="12.5"/>
        ${BASE}
      </g>`,
  R: `<g class="body">
        <path d="M33 42 H67 L70 80 H30 Z"/>
        <path d="M28 42 V22 H39 V29 H45 V22 H55 V29 H61 V22 H72 V42 Z"/>
        ${BASE}
      </g>
      <path class="detail" d="M32 52 H68"/>`,
  B: `<g class="body">
        <path d="M40 66 H60 C60 73 64 77 69 81 H31 C36 77 40 73 40 66 Z"/>
        <rect x="33" y="58" width="34" height="9" rx="4.5"/>
        <path d="M50 22 C66 33 68 49 61 59 H39 C32 49 34 33 50 22 Z"/>
        <circle cx="50" cy="16" r="5.5"/>
        ${BASE}
      </g>
      <path class="detail" d="M50 32 V46 M43 39 H57"/>`,
  N: `<g class="body">
        <path d="M27 81 C27 66 30 57 39 49 C31 50 24 46 21 40 C19 35 23 30 28 27 L33 14 L42 21 C55 19 66 25 71 36 C76 47 77 66 75 81 Z"/>
        ${BASE}
      </g>
      <circle class="eye" cx="41" cy="31" r="2.8"/>
      <path class="detail" d="M22 40 L30 39"/>
      <path class="detail" d="M54 28 C62 33 66 42 66 54"/>`,
  Q: `<g class="body">
        <path d="M27 80 L19 35 L35 53 L38 27 L46 51 L50 23 L54 51 L62 27 L65 53 L81 35 L73 80 Z"/>
        <circle cx="19" cy="32" r="4.5"/><circle cx="38" cy="23" r="4.5"/><circle cx="50" cy="19" r="4.5"/>
        <circle cx="62" cy="23" r="4.5"/><circle cx="81" cy="32" r="4.5"/>
        ${BASE}
      </g>
      <path class="detail" d="M32 70 H68"/>`,
  K: `<g class="body">
        <path d="M30 81 C26 65 34 55 42 49 H58 C66 55 74 65 70 81 Z"/>
        <path d="M35 51 C33 41 40 34 50 34 C60 34 67 41 65 51 Z"/>
        <path d="M46 8 H54 V16 H62 V24 H54 V34 H46 V24 H38 V16 H46 Z"/>
        ${BASE}
      </g>
      <path class="detail" d="M34 66 H66"/>`,
};

/** Inline SVG markup for a piece code such as 'wK' or 'bN'. */
export function pieceSvg(code, extraClass = '') {
  const shape = SHAPES[code[1]];
  return `<svg class="pc pc-${code[0]} ${extraClass}" viewBox="0 0 100 100" aria-hidden="true" focusable="false">${shape}</svg>`;
}

export const PIECE_LABEL = {
  P: 'pawn', N: 'knight', B: 'bishop', R: 'rook', Q: 'queen', K: 'king',
};
