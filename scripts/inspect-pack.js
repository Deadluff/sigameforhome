/**
 * CLI: parse a .siq and print a summary – handy for checking packs without starting the server.
 *   npm run inspect-pack -- packs/MyPack.siq [--json]
 */
import path from 'node:path';
import { parseSiq } from '../server/packs/siqParser.js';

const [file, flag] = process.argv.slice(2);
if (!file) {
  console.error('Usage: npm run inspect-pack -- <path-to.siq> [--json]');
  process.exit(1);
}

const pack = await parseSiq(path.resolve(file), { mediaBaseUrl: '/media/preview' });

if (flag === '--json') {
  console.log(JSON.stringify(pack, null, 2));
  process.exit(0);
}

console.log(`\n${pack.name}  (format v${pack.version}, difficulty ${pack.difficulty})`);
if (pack.info.authors.length) console.log(`Authors: ${pack.info.authors.join(', ')}`);
console.log(`${pack.stats.rounds} rounds, ${pack.stats.themes} themes, ${pack.stats.questions} questions, ${pack.stats.mediaFiles} media files\n`);

for (const round of pack.rounds) {
  console.log(`■ ${round.name}${round.type === 'final' ? '  [FINAL]' : ''}`);
  for (const theme of round.themes) {
    const qs = theme.questions.map((q) => (q.type === 'simple' ? q.price : `${q.price}(${q.type})`));
    console.log(`   • ${theme.name}: ${qs.join(', ')}`);
  }
}
if (pack.stats.missingMedia.length) {
  console.log(`\n⚠ Missing media (${pack.stats.missingMedia.length}):`);
  for (const m of pack.stats.missingMedia.slice(0, 20)) console.log(`   ${m}`);
}
