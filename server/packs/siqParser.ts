/**
 * SIGame pack (.siq) parser.
 *
 * A .siq file is a ZIP archive:
 *   content.xml          – the package description (rounds → themes → questions)
 *   Images/ Audio/ Video/ Html/   – media referenced from content.xml
 *   Texts/authors.xml, Texts/sources.xml (optional, ignored here)
 *
 * Two XML dialects exist in the wild and BOTH are supported:
 *  ▸ Legacy format (SIGame ≤ 7, siq_4.xsd)
 *  ▸ Modern format (SIGame 8+, siq_5.xsd)
 *
 * Both are normalised into ONE TypeScript model so the game engine
 * never needs to know which version a pack was authored in.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import AdmZip, { type IZipEntry } from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import { ensureDir, safeJoin, sanitizeSegment } from '../utils/fsx.ts';

/* ------------------------------------------------------------------------- */
/* Normalised TypeScript Model                                               */
/* ------------------------------------------------------------------------- */

export type ContentType = 'text' | 'say' | 'image' | 'audio' | 'video' | 'html';
export type ContentPlacement = 'screen' | 'replic' | 'background';

export interface ContentItem {
  type: ContentType;
  value: string;
  isRef: boolean;
  url: string | null;
  missing: boolean;
  placement: ContentPlacement;
  duration: number | null;
  waitForFinish: boolean;
}

export type QuestionType =
  | 'simple'
  | 'secret'
  | 'secretPublicPrice'
  | 'secretNoQuestion'
  | 'stake'
  | 'noRisk'
  | 'forAll';

export interface NumberSet {
  minimum: number;
  maximum: number;
  step: number;
}

export interface QuestionTypeParams {
  [key: string]: unknown;
  price?: NumberSet;
  selectionMode?: string;
}

export interface Info {
  authors: string[];
  sources: string[];
  comments: string;
}

export interface Question {
  /** -1 marks an empty / removed cell. */
  price: number;
  type: QuestionType;
  typeParams: QuestionTypeParams;
  content: ContentItem[];
  answerContent: ContentItem[];
  right: string[];
  wrong: string[];
  info: Info;
}

export interface Theme {
  name: string;
  info: Info;
  questions: Question[];
}

export type RoundType = 'standard' | 'final';

export interface Round {
  name: string;
  type: RoundType;
  info: Info;
  themes: Theme[];
}

export interface PackageStats {
  rounds: number;
  themes: number;
  questions: number;
  mediaFiles: number;
  missingMedia: string[];
}

export interface Package {
  id: string;
  name: string;
  version: string;
  date: string;
  publisher: string;
  difficulty: number;
  language: string;
  tags: string[];
  logo: ContentItem | null;
  info: Info;
  rounds: Round[];
  stats: PackageStats;
}

export interface PackHeader {
  name: string;
  rounds: number | null;
  difficulty?: number;
  version?: string;
  error?: string;
}

/* ------------------------------------------------------------------------- */
/* XML helpers                                                               */
/* ------------------------------------------------------------------------- */

type XmlNode = Record<string, any>;

const ARRAY_TAGS = new Set([
  'round', 'theme', 'question', 'atom', 'answer', 'param', 'item', 'author', 'source', 'tag',
]);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  removeNSPrefix: true,
  alwaysCreateTextNode: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  isArray: (name: string) => ARRAY_TAGS.has(name),
});

const asArray = <T = XmlNode>(v: T | T[] | null | undefined): T[] =>
  v == null ? [] : Array.isArray(v) ? v : [v];
const text = (node: unknown): string =>
  node == null ? '' : typeof node === 'object' ? String((node as XmlNode)['#text'] ?? '') : String(node);
const attr = (node: XmlNode | null | undefined, name: string, fallback = ''): string =>
  node && node[`@_${name}`] != null ? String(node[`@_${name}`]) : fallback;
const bool = (v: unknown, fallback = false): boolean =>
  v === '' || v == null ? fallback : /^(true|1)$/i.test(String(v));
const num = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

function parseInfo(infoNode: XmlNode | undefined): Info {
  return {
    authors: asArray(infoNode?.authors?.author).map(text).filter(Boolean),
    sources: asArray(infoNode?.sources?.source).map(text).filter(Boolean),
    comments: text(infoNode?.comments),
  };
}

/* ------------------------------------------------------------------------- */
/* Media resolution                                                          */
/* ------------------------------------------------------------------------- */

const MEDIA_FOLDERS: Record<string, string> = {
  image: 'images',
  audio: 'audio',
  video: 'video',
  html: 'html',
};

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const mediaKey = (name: string): string => safeDecode(String(name)).normalize('NFC').toLowerCase();

interface MediaResolver {
  mediaFiles: number;
  missing: Set<string>;
  resolve(type: ContentType, ref: string): string | null;
}

function createMediaResolver(entries: IZipEntry[], mediaBaseUrl: string): MediaResolver {
  const byFolder = new Map<string, string>();
  const byName = new Map<string, string>();
  let mediaFiles = 0;

  for (const e of entries) {
    if (e.isDirectory) continue;
    const parts = e.entryName.split('/');
    if (parts.length < 2) continue;
    const folder = parts[0].toLowerCase();
    if (!Object.values(MEDIA_FOLDERS).includes(folder)) continue;

    mediaFiles++;
    const url = `${mediaBaseUrl}/${entryDiskSegments(e.entryName).map(encodeURIComponent).join('/')}`;
    const fileName = parts.slice(1).join('/');
    byFolder.set(`${folder}/${mediaKey(fileName)}`, url);
    if (!byName.has(mediaKey(fileName))) byName.set(mediaKey(fileName), url);
  }

  const missing = new Set<string>();

  return {
    mediaFiles,
    missing,
    resolve(type: ContentType, ref: string): string | null {
      const name = String(ref).replace(/^@/, '');
      const folder = MEDIA_FOLDERS[type];
      const key = mediaKey(name);
      const url = (folder && byFolder.get(`${folder}/${key}`)) ?? byName.get(key) ?? null;
      if (!url) missing.add(`${folder ?? '?'}/${name}`);
      return url;
    },
  };
}

function entryDiskSegments(entryName: string): string[] {
  return entryName.split('/').filter(Boolean).map((s) => sanitizeSegment(safeDecode(s)));
}

interface MakeItemInput {
  type: ContentType;
  value: string;
  isRef: boolean;
  placement?: ContentPlacement;
  duration?: number | null;
  waitForFinish?: boolean;
}

function makeItem(resolver: MediaResolver, input: MakeItemInput): ContentItem {
  const { type, value, isRef, placement, duration, waitForFinish } = input;
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

const LEGACY_ATOM_TYPES: Record<string, ContentType> = {
  '': 'text',
  text: 'text',
  say: 'say',
  image: 'image',
  voice: 'audio',
  audio: 'audio',
  video: 'video',
  html: 'html',
};

function parseLegacyCost(raw: unknown): NumberSet {
  const s = String(raw ?? '').trim();
  const range = s.match(/^\[\s*(\d+)\s*[;,]\s*(\d+)\s*\](?:\s*\/\s*(\d+))?$/);
  if (range) return { minimum: num(range[1]), maximum: num(range[2]), step: num(range[3], 0) };
  const n = num(s, 0);
  return { minimum: n, maximum: n, step: 0 };
}

function parseLegacyQuestion(q: XmlNode, resolver: MediaResolver) {
  const content: ContentItem[] = [];
  const answerContent: ContentItem[] = [];
  let target = content;

  for (const atom of asArray(q.scenario?.atom)) {
    const rawType = attr(atom, 'type').toLowerCase();
    if (rawType === 'marker') {
      target = answerContent;
      continue;
    }
    const type: ContentType = LEGACY_ATOM_TYPES[rawType] ?? 'text';
    const value = text(atom);
    const isRef = type !== 'text' && type !== 'say' && value.startsWith('@');
    const time = attr(atom, 'time');
    target.push(makeItem(resolver, { type, value, isRef, duration: time ? num(time) : null }));
  }

  const typeName = attr(q.type, 'name', 'simple').toLowerCase();
  const legacyParams = Object.fromEntries(asArray(q.type?.param).map((p) => [attr(p, 'name'), text(p)]));
  let type: QuestionType = 'simple';
  let typeParams: QuestionTypeParams = {};

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

function parseContentParam(param: XmlNode, resolver: MediaResolver): ContentItem[] {
  return asArray(param?.item).map((it) => {
    const rawType = attr(it, 'type', 'text').toLowerCase() || 'text';
    const type: ContentType = LEGACY_ATOM_TYPES[rawType] ?? (rawType as ContentType);
    const isRef = bool(attr(it, 'isRef'));
    const duration = attr(it, 'duration');
    const placementRaw = attr(it, 'placement').toLowerCase() as ContentPlacement | '';
    return makeItem(resolver, {
      type,
      value: text(it),
      isRef,
      placement: placementRaw || undefined,
      duration: duration ? parseDuration(duration) : null,
      waitForFinish: bool(attr(it, 'waitForFinish'), true),
    });
  });
}

function parseDuration(s: string): number | null {
  const parts = String(s).split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

const MAX_CONTENT_XML_BYTES = 10 * 1024 * 1024;
const V5_TYPES = new Set<QuestionType>([
  'simple',
  'secret',
  'secretPublicPrice',
  'secretNoQuestion',
  'stake',
  'noRisk',
  'forAll',
]);

function parseModernQuestion(q: XmlNode, resolver: MediaResolver) {
  let content: ContentItem[] = [];
  let answerContent: ContentItem[] = [];
  const typeParams: QuestionTypeParams = {};

  for (const p of asArray(q.params?.param)) {
    const name = attr(p, 'name');
    const kind = attr(p, 'type', 'simple');
    if (name === 'question') content = parseContentParam(p, resolver);
    else if (name === 'answer') answerContent = parseContentParam(p, resolver);
    else if (kind === 'numberSet') {
      const ns = p.numberSet ?? {};
      typeParams[name] = {
        minimum: num(attr(ns, 'minimum')),
        maximum: num(attr(ns, 'maximum')),
        step: num(attr(ns, 'step')),
      } satisfies NumberSet;
    } else if (kind === 'content') typeParams[name] = parseContentParam(p, resolver);
    else typeParams[name] = text(p);
  }

  const rawType = attr(q, 'type', 'simple') as QuestionType;
  const type: QuestionType = V5_TYPES.has(rawType) ? rawType : 'simple';
  return { type, typeParams, content, answerContent };
}

/* ------------------------------------------------------------------------- */
/* Package normalisation                                                     */
/* ------------------------------------------------------------------------- */

function parseQuestion(q: XmlNode, resolver: MediaResolver): Question {
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

function normalizePackage(xmlRoot: XmlNode, resolver: MediaResolver): Package {
  const pkg = xmlRoot.package;
  if (!pkg) throw new Error('content.xml has no <package> root element – not a SIGame pack?');

  let themesCount = 0;
  let questionsCount = 0;

  const rounds: Round[] = asArray(pkg.rounds?.round).map((r) => ({
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

function findContentEntry(zip: AdmZip): IZipEntry | null {
  return zip.getEntries().find((e) => !e.isDirectory && e.entryName.toLowerCase() === 'content.xml') ?? null;
}

export function isSiqArchive(filePath: string): boolean {
  try {
    return findContentEntry(new AdmZip(filePath)) != null;
  } catch {
    return false;
  }
}

export function readPackHeader(filePath: string): PackHeader {
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

async function extractMedia(zip: AdmZip, destDir: string): Promise<void> {
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

export interface ParseSiqOptions {
  mediaBaseUrl?: string;
  extractTo?: string;
}

export async function parseSiq(
  filePath: string,
  { mediaBaseUrl = '', extractTo }: ParseSiqOptions = {},
): Promise<Package> {
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

  const xml = contentEntry.getData().toString('utf8').replace(/^\uFEFF/, '');
  const resolver = createMediaResolver(zip.getEntries(), mediaBaseUrl);
  const pack = normalizePackage(xmlParser.parse(xml), resolver);

  if (extractTo) await extractMedia(zip, extractTo);
  return pack;
}
