/** Static files referenced by pack HTML; unknown references stay inaccessible. */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Package } from './siqParser.ts';
import { safeJoin } from '../utils/fsx.ts';

const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_ASSETS = 100;

function visibleHtml(source: string): string {
  // Inert markup must not authorize files that a player could request directly.
  return source.replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(script|template|textarea)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
}

function activeCss(source: string): string {
  return source.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '');
}

export function canonicalMediaPath(url: string | null | undefined): string | null {
  if (!url?.startsWith('/media/')) return null;
  try { return new URL(url, 'http://local').pathname.split('/').map(decodeURIComponent).join('/'); }
  catch { return null; }
}

/** A conservative static dependency graph avoids granting access to an entire HTML folder. */
export async function collectHtmlAssets(pack: Package, cacheDir: string, packId: string): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  const rootPath = `/media/${packId}/`;

  for (const round of pack.rounds) for (const theme of round.themes) for (const question of theme.questions) {
    for (const item of [...question.content, ...question.answerContent]) {
      if (item.type !== 'html') continue;
      const htmlPath = canonicalMediaPath(item.url);
      if (!htmlPath?.startsWith(rootPath) || result.has(htmlPath)) continue;
      const assets = new Set<string>();
      const scanned = new Set<string>();

      const visit = async (sourcePath: string, css: boolean): Promise<void> => {
        if (scanned.has(sourcePath) || scanned.size >= MAX_ASSETS) return;
        scanned.add(sourcePath);
        const file = safeJoin(cacheDir, ...sourcePath.slice(rootPath.length).split('/'));
        const stat = await fsp.stat(file).catch(() => null);
        if (!stat?.isFile() || stat.size > MAX_SOURCE_BYTES) return;
        const source = await fsp.readFile(file, 'utf8');
        const refs: string[] = [];
        const cssSources = css ? [source] : [];
        if (!css) {
          const html = visibleHtml(source);
          for (const tag of html.matchAll(/<(?:img|audio|video|source|track|link)\b[^>]*>/gi)) {
            if (/^<link\b/i.test(tag[0]) && !/\brel\s*=\s*["']?stylesheet\b/i.test(tag[0])) continue;
            for (const attr of tag[0].matchAll(/\b(?:src|href|poster)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) {
              refs.push(attr[1] ?? attr[2]);
            }
          }
          for (const style of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) cssSources.push(style[1]);
          for (const style of html.matchAll(/\bstyle\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) {
            cssSources.push(style[1] ?? style[2]);
          }
        }
        for (const cssSource of cssSources) {
          const active = activeCss(cssSource);
          for (const match of active.matchAll(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)]+))\s*\)/gi)) {
            refs.push(match[1] ?? match[2] ?? match[3]);
          }
          for (const match of active.matchAll(/@import\s+["']([^"']+)["']/gi)) refs.push(match[1]);
        }

        for (const ref of refs) {
          // Relative references only; remote and root URLs do not receive room tickets.
          if (!ref || ref.startsWith('/') || ref.startsWith('#') || ref.includes('\\') || /^[a-z][\w+.-]*:/i.test(ref)) continue;
          let candidate: string | null;
          try { candidate = canonicalMediaPath(new URL(ref, `http://local${sourcePath}`).pathname); }
          catch { continue; }
          if (!candidate?.startsWith(rootPath) || assets.size >= MAX_ASSETS) continue;
          let target: string;
          try { target = safeJoin(cacheDir, ...candidate.slice(rootPath.length).split('/')); }
          catch { continue; }
          if (!(await fsp.stat(target).catch(() => null))?.isFile()) continue;
          assets.add(candidate);
          if (path.extname(candidate).toLowerCase() === '.css') await visit(candidate, true);
        }
      };

      await visit(htmlPath, false);
      result.set(htmlPath, assets);
    }
  }
  return result;
}
