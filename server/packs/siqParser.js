/**
 * SIGame pack (.siq) parser.
 *
 * A .siq file is a ZIP archive:
 *   content.xml          – the package description (rounds → themes → questions)
 *   Images/ Audio/ Video/ Html/   – media referenced from content.xml
 *   Texts/authors.xml, Texts/sources.xml (optional, ignored here)
 *
 * Two XML dialects exist in the wild and BOTH are supported:
 *
 *  ▸ Legacy format (SIGame ≤ 7, siq_4.xsd)
 *      <question price="100">
 *        <type name="cat"><param name="theme">…</param><param name="cost">…</param></type>
 *        <scenario><atom>text</atom><atom type="image">@pic.jpg</atom><atom type="marker"/>…</scenario>
 *        <right><answer>…</answer></right>
 *      </question>
 *
 *  ▸ Modern format (SIGame 8+, siq_5.xsd)
 *      <question price="100" type="secret">
 *        <params>
 *          <param name="question" type="content"><item type="image" isRef="True">pic.jpg</item></param>
 *          <param name="answer"   type="content">…</param>
 *          <param name="theme">…</param>
 *          <param name="price" type="numberSet"><numberSet minimum="100" maximum="500" step="100"/></param>
 *        </params>
 *        <right><answer>…</answer></right>
 *      </question>
 *
 * Both are normalised into ONE model (see typedefs below) so the game engine
 * never needs to know which version a pack was authored in.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import { ensureDir, safeJoin, sanitizeSegment } from '../utils/fsx.js';

/* ------------------------------------------------------------------------- */
/* Normalised model                                                          */
/* ------------------------------------------------------------------------- */

/**
 * @typedef {'text'|'say'|'image'|'audio'|'video'|'html'} ContentType
 *
 * @typedef {object} ContentItem
 * @property {ContentType} type
 * @property {string}  value        Text, or the original media file name.
 * @property {boolean} isRef        True if `value` references a file in the archive.
 * @property {string|null} url      Public URL of the media (null for text / missing / external).
 * @property {boolean} missing      Referenced file not found in the archive.
 * @property {'screen'|'replic'|'background'} placement
 * @property {number|null} duration Seconds, if the author specified one.
 * @property {boolean} waitForFinish
 *
 * @typedef {'simple'|'secret'|'secretPublicPrice'|'secretNoQuestion'|'stake'|'noRisk'|'forAll'} QuestionType
 *
 * @typedef {object} Question
 * @property {number}  price         -1 marks an empty / removed cell.
 * @property {QuestionType} type
 * @property {object}  typeParams    e.g. { theme, price:{minimum,maximum,step}, selectionMode }
 * @property {ContentItem[]} content       What is shown/read to players.
 * @property {ContentItem[]} answerContent Extra media shown when the answer is revealed.
 * @property {string[]} right
 * @property {string[]} wrong
 * @property {Info} info
 *
 * @typedef {{ authors: string[], sources: string[], comments: string }} Info
 * @typedef {{ name: string, info: Info, questions: Question[] }} Theme
 * @typedef {{ name: string, type: 'standard'|'final', info: Info, themes: Theme[] }} Round
 *
 * @typedef {object} Package
 * @property {string} id  @property {string} name  @property {string} version
 * @property {string} date @property {string} publisher @property {number} difficulty
 * @property {string[]} tags @property {ContentItem|null} logo @property {Info} info
 * @property {Round[]} rounds
 * @property {{ rounds:number, themes:number, questions:number, mediaFiles:number, missingMedia:string[] }} stats
 */

/* ------------------------------------------------------------------------- */
/* XML helpers                                                               */
/* ------------------------------------------------------------------------- */

/** Tags that may repeat and must therefore always be arrays. */
const ARRAY_TAGS = new Set([
  'round', 'theme', 'question', 'atom', 'answer', 'param', 'item', 'author', 'source', 'tag',
]);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  removeNSPrefix: true,
  alwaysCreateTextNode: true, // every element is an object → uniform access
  parseTagValue: false, // keep "007" as a string
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const text = (node) => (node == null ? '' : typeof node === 'object' ? String(node['#text'] ?? '') : String(node));
const attr = (node, name, fallback = '') => (node && node[`@_${name}`] != null ? String(node[`@_${name}`]) : fallback);
const bool = (v, fallback = false) => (v === '' || v == null ? fallback : /^(true|1)$/i.test(String(v)));
const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Parses <info> blocks found on package / round / theme / question. */
function parseInfo(infoNode) {
  return {
    authors: asArray(infoNode?.authors?.author).map(text).filter(Boolean),
    sources: asArray(infoNode?.sources?.source).map(text).filter(Boolean),
    comments: text(infoNode?.comments),
  };
}

/* ------------------------------------------------------------------------- */
/* Media resolution                                                          */
/* ------------------------------------------------------------------------- */

/** Media folder per content type (SIGame's canonical folder names). */
const MEDIA_FOLDERS = { image: 'images', audio: 'audio', video: 'video', html: 'html' };

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Normalised lookup key: SIGame stores names URI-escaped, authors reference them unescaped (or vice versa). */
const mediaKey = (name) => safeDecode(String(name)).normalize('NFC').toLowerCase();

/**
 * Builds a resolver from archive entries to public URLs.
 * @param {AdmZip.IZipEntry[]} entries
 * @param {string} mediaBaseUrl e.g. "/media/ab12cd34"
 */
function createMediaResolver(entries, mediaBaseUrl) {
  const byFolder = new Map(); // "images/foo.jpg" → url
  const byName = new Map(); // "foo.jpg" → url  (fallback when author put a file in the wrong folder)
  let mediaFiles = 0;

  for (const e of entries) {
    if (e.isDirectory) continue;
    const parts = e.entryName.split('/');
    if (parts.length < 2) continue; // content.xml & friends
    const folder = parts[0].toLowerCase();
    if (!Object.values(MEDIA_FOLDERS).includes(folder)) continue;

    mediaFiles++;
    const url = `${mediaBaseUrl}/${entryDiskSegments(e.entryName).map(encodeURIComponent).join('/')}`;
    const fileName = parts.slice(1).join('/');
    byFolder.set(`${folder}/${mediaKey(fileName)}`, url);
    if (!byName.has(mediaKey(fileName))) byName.set(mediaKey(fileName), url);
  }

  const missing = new Set();

  return {
    mediaFiles,
    missing,
    /** @returns {string|null} */
    resolve(type, ref) {
      const name = String(ref).replace(/^@/, '');
      const folder = MEDIA_FOLDERS[type];
      const key = mediaKey(name);
      const url = (folder && byFolder.get(`${folder}/${key}`)) ?? byName.get(key) ?? null;
      if (!url) missing.add(`${folder ?? '?'}/${name}`);
      return url;
    },
  };
}

/**
 * Maps a zip entry name to the sanitised on-disk path segments used when extracting.
 * SIGame stores names URI-escaped ("%D0%BA%D0%BE%D1%82.png"); we decode them so files on disk
 * (and URLs) use the real name ("кот.png").
 */
function entryDiskSegments(entryName) {
  return entryName.split('/').filter(Boolean).map((s) => sanitizeSegment(safeDecode(s)));
}

/** Creates a ContentItem, resolving file references. */
function makeItem(resolver, { type, value, isRef, placement, duration, waitForFinish }) {
  const external = isRef && /^https?:\/\//i.test(value);
  const url = isRef ? (external ? value : resolver.resolve(type, value)) : null;
  return {
    type,
    value: isRef ? value.replace(/^@/, '') : value,
    isRef,
    url,
    missing: isRef && !url,
    placement: placement || (type === 'audio' ? 'background' : 'screen'),
    duration: duration ?? null,
    waitForFinish: waitForFinish ?? true,
  };
}

/* ------------------------------------------------------------------------- */
/* Legacy (v4) question parsing                                              */
/* ------------------------------------------------------------------------- */

/** Legacy atom type → normalised type. */
const LEGACY_ATOM_TYPES = { '': 'text', text: 'text', say: 'say', image: 'image', voice: 'audio', audio: 'audio', video: 'video', html: 'html' };

/** Parses "[100;500]", "100", "0" style legacy cost strings into a number set. */
function parseLegacyCost(raw) {
  const s = String(raw ?? '').trim();
  const range = s.match(/^\[\s*(\d+)\s*[;,]\s*(\d+)\s*\](?:\s*\/\s*(\d+))?$/);
  if (range) return { minimum: num(range[1]), maximum: num(range[2]), step: num(range[3], 0) };
  const n = num(s, 0);
  return { minimum: n, maximum: n, step: 0 };
}

function parseLegacyQuestion(q, resolver) {
  const content = [];
  const answerContent = [];
  let target = content;

  for (const atom of asArray(q.scenario?.atom)) {
    const rawType = attr(atom, 'type').toLowerCase();
    if (rawType === 'marker') {
      target = answerContent; // everything after a marker belongs to the answer
      continue;
    }
    const type = LEGACY_ATOM_TYPES[rawType] ?? 'text';
    const value = text(atom);
    const isRef = type !== 'text' && type !== 'say' && value.startsWith('@');
    const time = attr(atom, 'time');
    target.push(makeItem(resolver, { type, value, isRef, duration: time ? num(time) : null }));
  }

  // Legacy question "type" block.
  const typeName = attr(q.type, 'name', 'simple').toLowerCase();
  const legacyParams = Object.fromEntries(asArray(q.type?.param).map((p) => [attr(p, 'name'), text(p)]));
  let type = 'simple';
  let typeParams = {};

  switch (typeName) {
    case 'cat':
      type = 'secret';
      typeParams = { theme: legacyParams.theme ?? '', price: parseLegacyCost(legacyParams.cost), selectionMode: 'exceptCurrent' };
      break;
    case 'bagcat': {
      const knows = (legacyParams.knows ?? 'after').toLowerCase();
      type = knows === 'never' ? 'secretNoQuestion' : knows === 'before' ? 'secretPublicPrice' : 'secret';
      typeParams = {
        theme: legacyParams.theme ?? '',
        price: parseLegacyCost(legacyParams.cost),
        selectionMode: bool(legacyParams.self) ? 'any' : 'exceptCurrent',
      };
      break;
    }
    case 'auction':
      type = 'stake';
      break;
    case 'sponsored':
      type = 'noRisk';
      break;
    default:
      type = 'simple';
  }

  return { type, typeParams: { ...typeParams, legacy: { name: typeName, ...legacyParams } }, content, answerContent };
}

/* ------------------------------------------------------------------------- */
/* Modern (v5) question parsing                                              */
/* ------------------------------------------------------------------------- */

function parseContentParam(param, resolver) {
  return asArray(param?.item).map((it) => {
    const type = (attr(it, 'type', 'text').toLowerCase() || 'text');
    const isRef = bool(attr(it, 'isRef'));
    const duration = attr(it, 'duration');
    return makeItem(resolver, {
      type: LEGACY_ATOM_TYPES[type] ?? type,
      value: text(it),
      isRef,
      placement: attr(it, 'placement').toLowerCase() || undefined,
      duration: duration ? parseDuration(duration) : null,
      waitForFinish: bool(attr(it, 'waitForFinish'), true),
    });
  });
}

/** v5 durations are TimeSpan strings ("00:00:05") or plain seconds. */
function parseDuration(s) {
  const parts = String(s).split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

const V5_TYPES = new Set(['simple', 'secret', 'secretPublicPrice', 'secretNoQuestion', 'stake', 'noRisk', 'forAll']);
const MAX_CONTENT_XML_BYTES = 10 * 1024 * 1024;

function parseModernQuestion(q, resolver) {
  let content = [];
  let answerContent = [];
  const typeParams = {};

  for (const p of asArray(q.params?.param)) {
    const name = attr(p, 'name');
    const kind = attr(p, 'type', 'simple');
    if (name === 'question') content = parseContentParam(p, resolver);
    else if (name === 'answer') answerContent = parseContentParam(p, resolver);
    else if (kind === 'numberSet') {
      const ns = p.numberSet ?? {};
      typeParams[name] = { minimum: num(attr(ns, 'minimum')), maximum: num(attr(ns, 'maximum')), step: num(attr(ns, 'step')) };
    } else if (kind === 'content') typeParams[name] = parseContentParam(p, resolver);
    else typeParams[name] = text(p);
  }

  const rawType = attr(q, 'type', 'simple');
  const type = V5_TYPES.has(rawType) ? rawType : 'simple';
  return { type, typeParams, content, answerContent };
}

/* ------------------------------------------------------------------------- */
/* Package normalisation                                                     */
/* ------------------------------------------------------------------------- */

function parseQuestion(q, resolver) {
  const isModern = q.params != null || q.scenario == null;
  const parsed = isModern ? parseModernQuestion(q, resolver) : parseLegacyQuestion(q, resolver);
  return {
    price: num(attr(q, 'price'), 0),
    ...parsed,
    right: asArray(q.right?.answer).map(text).filter(Boolean),
    wrong: asArray(q.wrong?.answer).map(text).filter(Boolean),
    info: parseInfo(q.info),
  };
}

/**
 * Converts the raw parsed XML object into the normalised Package model.
 * @param {object} xmlRoot   output of xmlParser.parse(content.xml)
 * @param {ReturnType<typeof createMediaResolver>} resolver
 * @returns {Package}
 */
function normalizePackage(xmlRoot, resolver) {
  const pkg = xmlRoot.package;
  if (!pkg) throw new Error('content.xml has no <package> root element – not a SIGame pack?');

  let themesCount = 0;
  let questionsCount = 0;

  const rounds = asArray(pkg.rounds?.round).map((r) => ({
    name: attr(r, 'name'),
    type: attr(r, 'type').toLowerCase() === 'final' ? 'final' : 'standard',
    info: parseInfo(r.info),
    themes: asArray(r.themes?.theme).map((t) => {
      themesCount++;
      const questions = asArray(t.questions?.question).map((q) => parseQuestion(q, resolver));
      questionsCount += questions.length;
      return { name: attr(t, 'name'), info: parseInfo(t.info), questions };
    }),
  }));

  const logoRef = attr(pkg, 'logo');
  return {
    id: attr(pkg, 'id'),
    name: attr(pkg, 'name', 'Untitled pack'),
    version: attr(pkg, 'version', '4'),
    date: attr(pkg, 'date'),
    publisher: attr(pkg, 'publisher'),
    difficulty: num(attr(pkg, 'difficulty'), 5),
    language: attr(pkg, 'language'),
    tags: asArray(pkg.tags?.tag).map(text).filter(Boolean),
    logo: logoRef ? makeItem(resolver, { type: 'image', value: logoRef, isRef: true }) : null,
    info: parseInfo(pkg.info),
    rounds,
    stats: {
      rounds: rounds.length,
      themes: themesCount,
      questions: questionsCount,
      mediaFiles: resolver.mediaFiles,
      missingMedia: [...resolver.missing],
    },
  };
}

/* ------------------------------------------------------------------------- */
/* Public API                                                                */
/* ------------------------------------------------------------------------- */

/** Finds content.xml regardless of letter case (some hand-made packs differ). */
function findContentEntry(zip) {
  return zip.getEntries().find((e) => !e.isDirectory && e.entryName.toLowerCase() === 'content.xml') ?? null;
}

/** True if a file is a zip containing content.xml at its root (used to sniff unknown downloads). */
export function isSiqArchive(filePath) {
  try {
    return findContentEntry(new AdmZip(filePath)) != null;
  } catch {
    return false;
  }
}

/** Reads only the header of a pack (name, rounds count) – cheap enough for listing. */
export function readPackHeader(filePath) {
  const zip = new AdmZip(filePath);
  const entry = findContentEntry(zip);
  if (!entry) throw new Error('content.xml not found');
  // Listing is allowed before loading, so it needs the same XML bound as parseSiq.
  if (entry.header.size > MAX_CONTENT_XML_BYTES) throw new Error('Pack content.xml exceeds 10 MB');
  const root = xmlParser.parse(entry.getData().toString('utf8'));
  const pkg = root.package ?? {};
  return {
    name: attr(pkg, 'name', path.basename(filePath, '.siq')),
    rounds: asArray(pkg.rounds?.round).length,
    difficulty: num(attr(pkg, 'difficulty'), 5),
    version: attr(pkg, 'version', '4'),
  };
}

/**
 * Safely extracts the media folders of an archive to `destDir` (zip-slip safe).
 * File names are sanitised exactly like createMediaResolver() builds URLs.
 */
async function extractMedia(zip, destDir) {
  await ensureDir(destDir);
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const segments = entryDiskSegments(e.entryName);
    if (segments.length < 2 || !Object.values(MEDIA_FOLDERS).includes(segments[0].toLowerCase())) continue;
    const target = safeJoin(destDir, ...segments);
    await ensureDir(path.dirname(target));
    await fsp.writeFile(target, e.getData());
  }
}

/**
 * Parses a .siq file into the normalised model.
 *
 * @param {string} filePath  absolute path to the .siq
 * @param {object} [options]
 * @param {string} [options.mediaBaseUrl] URL prefix under which extracted media will be served
 * @param {string} [options.extractTo]    directory to extract media into (skipped if omitted)
 * @returns {Promise<Package>}
 */
export async function parseSiq(filePath, { mediaBaseUrl = '', extractTo } = {}) {
  const zip = new AdmZip(filePath);
  // Bound untrusted archive expansion before reading any entry into memory.
  const entries = zip.getEntries();
  const expanded = entries.reduce((sum, entry) => sum + (entry.header?.size ?? 0), 0);
  if (entries.length > 5000 || expanded > 1024 * 1024 * 1024) {
    throw new Error('Pack has too many files or exceeds 1 GB when extracted');
  }
  const contentEntry = findContentEntry(zip);
  if (!contentEntry) throw new Error(`"${path.basename(filePath)}" is not a valid .siq (content.xml missing)`);
  if (contentEntry.header.size > MAX_CONTENT_XML_BYTES) throw new Error('Pack content.xml exceeds 10 MB');

  // Strip a UTF-8 BOM if present; SIGame's own writer emits one.
  const xml = contentEntry.getData().toString('utf8').replace(/^\uFEFF/, '');
  const resolver = createMediaResolver(zip.getEntries(), mediaBaseUrl);
  const pack = normalizePackage(xmlParser.parse(xml), resolver);

  if (extractTo) await extractMedia(zip, extractTo);
  return pack;
}
