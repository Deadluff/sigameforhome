// Contrast gate for the studio palette: reads the hex tokens in tokens.css and checks the pairs the UI
// actually draws (text on panels, digits on cells, played cells on the table bed). Exits 1 on a failure.
// A token that does not exist yet is reported as missing; pass --strict to fail on missing tokens too.
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../client/src/styles/tokens.css', import.meta.url), 'utf8');
const root = css.match(/:root\s*{([\s\S]*?)}/)?.[1] ?? '';
const tokens = Object.fromEntries([...root.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1], m[2]]));

const luminance = (hex) => {
  const [r, g, b] = hex.slice(1).match(/../g).map((x) => parseInt(x, 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// [foreground, background, min, max]. Body text needs 4.5:1, large digits and icons 3:1.
// Played cells are deliberately faint: visible against their cell, but clearly spent.
const pairs = [
  ['paper', 'set', 4.5], ['paper', 'theme-cell', 4.5], ['paper', 'set-raised', 4.5],
  ['mist', 'set', 4.5], ['mist', 'studio', 4.5], ['mist', 'set-raised', 4.5],
  ['on-lamp', 'lamp', 4.5], ['on-talk', 'talk', 4.5], ['on-go', 'go', 4.5],
  ['lamp', 'board', 3], ['lamp', 'set-sunk', 3], ['go', 'set-raised', 3], ['stop', 'set-raised', 3],
  ['ghost', 'cell-played', 1.4, 2], ['cell-played', 'board-spent', 1.2], ['theme-cell', 'board-spent', 1.2],
];

const strict = process.argv.includes('--strict');
let failed = 0;
let missing = 0;
for (const [fg, bg, min, max = Infinity] of pairs) {
  const label = `${fg} / ${bg}`.padEnd(28);
  if (!tokens[fg] || !tokens[bg]) {
    missing++;
    console.log(`${label} missing`);
    continue;
  }
  const value = ratio(tokens[fg], tokens[bg]);
  const ok = value >= min && value <= max;
  if (!ok) failed++;
  console.log(`${label} ${value.toFixed(2).padStart(6)}  ${ok ? 'ok' : `FAIL (needs ${max === Infinity ? `>= ${min}` : `${min}-${max}`})`}`);
}
if (failed || (strict && missing)) {
  console.error(`\n${failed} pair(s) failed${strict && missing ? `, ${missing} missing` : ''}.`);
  process.exit(1);
}
