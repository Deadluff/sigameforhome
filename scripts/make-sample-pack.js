/**
 * Generates two tiny demo packs in /packs so the app can be tried without downloading anything:
 *   - "Demo pack (v5 format).siq"     modern siq_5 format, includes special question types
 *   - "Demo pack (legacy v4).siq"     legacy siq_4 format with atoms/markers
 * Both contain an image whose archive name is URI-escaped (as SIGame writes it) to exercise media resolution.
 *   npm run make-sample
 */
import path from 'node:path';
import AdmZip from 'adm-zip';
import { config } from '../server/config.js';
import { ensureDir } from '../server/utils/fsx.js';

// 1×1 orange PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);
const IMAGE_NAME = 'кот.png';
const IMAGE_ENTRY = `Images/${encodeURIComponent(IMAGE_NAME)}`;

const themeV5 = (name, n) => `
      <theme name="${name}">
        <questions>
          ${[1, 2, 3, 4, 5]
            .map(
              (i) => `
          <question price="${i * 100 * n}"${i === 3 ? ' type="secret"' : i === 5 ? ' type="stake"' : ''}>
            <params>
              ${i === 3 ? '<param name="theme">Secret theme</param><param name="price" type="numberSet"><numberSet minimum="100" maximum="500" step="100" /></param>' : ''}
              <param name="question" type="content">
                <item>${name}: question for ${i * 100 * n}. What is ${i} + ${i}?</item>
                ${i === 2 ? `<item type="image" isRef="True">${IMAGE_NAME}</item>` : ''}
              </param>
            </params>
            <right><answer>${i + i}</answer></right>
          </question>`,
            )
            .join('')}
        </questions>
      </theme>`;

const contentV5 = `<?xml version="1.0" encoding="utf-8"?>
<package name="Demo pack (v5)" version="5" id="demo-v5" date="29.10.2026" difficulty="3" logo="@${IMAGE_NAME}"
         xmlns="https://github.com/VladimirKhil/SI/blob/master/assets/siq_5.xsd">
  <info><authors><author>SIGame Local</author></authors></info>
  <rounds>
    <round name="Round 1"><themes>${themeV5('Math', 1)}${themeV5('More math', 1)}${themeV5('Even more', 1)}</themes></round>
    <round name="Round 2"><themes>${themeV5('Doubles', 2)}${themeV5('Triples', 2)}</themes></round>
    <round name="Final" type="final"><themes>
      <theme name="Final theme"><questions>
        <question price="0"><params><param name="question" type="content"><item>Capital of France?</item></param></params>
          <right><answer>Paris</answer></right></question>
      </questions></theme>
    </themes></round>
  </rounds>
</package>`;

const contentV4 = `<?xml version="1.0" encoding="utf-8"?>
<package name="Demo pack (legacy v4)" version="4" date="29.10.2026" difficulty="5"
         xmlns="http://vladimirkhil.com/ygpackage3.0.xsd">
  <info><authors><author>SIGame Local</author></authors></info>
  <rounds>
    <round name="Legacy round"><themes>
      <theme name="Animals"><questions>
        <question price="100"><scenario><atom>Who is this?</atom><atom type="image">@${IMAGE_NAME}</atom></scenario>
          <right><answer>A cat</answer></right></question>
        <question price="200"><type name="cat"><param name="theme">Cats</param><param name="cost">300</param></type>
          <scenario><atom>Cat in a poke: how many lives does a cat have?</atom></scenario>
          <right><answer>9</answer></right></question>
        <question price="300"><type name="bagcat"><param name="theme">Dogs</param><param name="cost">[100;500]</param><param name="self">true</param><param name="knows">before</param></type>
          <scenario><atom>Best friend of a human?</atom><atom type="marker"/><atom type="image">@${IMAGE_NAME}</atom></scenario>
          <right><answer>Dog</answer></right></question>
        <question price="400"><type name="auction"/><scenario><atom>Largest land animal?</atom></scenario>
          <right><answer>Elephant</answer></right></question>
        <question price="500"><type name="sponsored"/><scenario><atom>Fastest land animal?</atom></scenario>
          <right><answer>Cheetah</answer></right><wrong><answer>Horse</answer></wrong></question>
      </questions></theme>
    </themes></round>
  </rounds>
</package>`;

async function writePack(fileName, xml) {
  const zip = new AdmZip();
  zip.addFile('content.xml', Buffer.from(xml, 'utf8'));
  zip.addFile(IMAGE_ENTRY, PNG);
  const out = path.join(config.packsDir, fileName);
  zip.writeZip(out);
  console.log(`Created ${out}`);
}

await ensureDir(config.packsDir);
await writePack('Demo pack (v5 format).siq', contentV5);
await writePack('Demo pack (legacy v4).siq', contentV4);
