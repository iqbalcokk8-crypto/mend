// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE
// blocks, V4A patches, JSON tool calls) and applies it to the tree in the
// working directory, all or nothing, as SPEC.md (version 1) says.
//
// Usage: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//   --format=NAME  unified | search-replace | v4a | json | auto (default)
//   --check        report what would change, write nothing
//   --strict       match lines exactly (tier 0 only)
//   PATCH          patch file, or "-" / absent for standard input
//
// Node 22, standard library only. When MAKEFUN_ENV_URL is set this file
// hands the trial over to runner.ts (kept as the kit ships it).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A parse fault: the patch cannot be read in its format, at this line. */
class ParseFault {
  readonly line: number;
  constructor(line: number) {
    this.line = line;
  }
}

/** One edit failed, with the code and path the report names. */
class EditFault {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function splitPatchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break, and whether it ends with one. */
interface FileParts {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(parts: FileParts): string {
  if (parts.lines.length === 0) return '';
  return parts.lines.join(parts.br) + (parts.final ? parts.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions where O matches the file's lines at one tier. */
function occurrences(lines: string[], oldLines: string[], tier: number): number[] {
  const out: number[] = [];
  if (oldLines.length === 0) return out;
  for (let i = 0; i + oldLines.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j += 1) {
      if (normLine(lines[i + j]!, tier) !== normLine(oldLines[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function tiersToTry(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** The first tier at which O occurs at least once, with its positions. */
function firstTier(lines: string[], oldLines: string[], strict: boolean): { tier: number; occ: number[] } | null {
  for (const tier of tiersToTry(strict)) {
    const occ = occurrences(lines, oldLines, tier);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** One line of a replacement: a context line names its index in O, other lines are written. */
interface NewItem {
  text: string;
  ctx: number | null;
}

/** Build the replacement lines for a match at `pos` (tier `tier`). */
function replacementLines(fileLines: string[], oldLines: string[], items: NewItem[], pos: number, tier: number): string[] {
  return items.map((it) => {
    if (it.ctx !== null) return fileLines[pos + it.ctx]!;
    if (tier !== 2) return it.text;
    const f = leadingWs(fileLines[pos]!);
    const p = leadingWs(oldLines[0]!);
    if (it.text === '' || it.text.trim() === '') return it.text;
    return it.text.startsWith(p) ? f + it.text.slice(p.length) : it.text;
  });
}

/** The tree as the edits leave it. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** File identity: current path -> the path the file started at. A move
   * carries the identity along; a delete ends it; a create starts a new
   * file with no origin. Rename reporting must follow identity, not path
   * history: after move a -> b, delete b, create b, the file at b is new,
   * so the outcome is D a + A b, never R a -> b. */
  readonly origins = new Map<string, string>();
  /** Paths whose current file was created by this patch (not an original
   * file). A move of such a file carries no origin: `origins.get(oldP) ??
   * oldP` alone cannot tell an untouched original file from a file that
   * was recreated on a path an original file used to occupy. */
  readonly created = new Set<string>();

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  /** True when the path is taken by a file in the tree, or by a directory on
   * disk. A directory has no text content (so reads as missing), but it
   * still occupies the path: creating a file there must fail with `exists`,
   * not crash the write phase. */
  occupied(p: string): boolean {
    if (this.get(p) !== null) return true;
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  }

  /** Create a new file (or overwrite a path that held nothing). */
  setFile(p: string, text: string): void {
    this.now.set(p, text);
    this.origins.delete(p);
    this.created.add(p);
  }

  /** Replace the content of an existing file; identity is unchanged. */
  editFile(p: string, text: string): void {
    this.now.set(p, text);
  }

  /** Delete a file; its identity ends with it. */
  deleteFile(p: string): void {
    this.now.set(p, null);
    this.origins.delete(p);
    this.created.delete(p);
  }

  /** Move a file, carrying its identity to the new path. A file this patch
   * created has no origin to carry, even when it sits on a path an
   * original file used to occupy. */
  moveFile(oldP: string, newP: string, text: string): void {
    const wasCreated = this.created.has(oldP);
    const origin = this.origins.get(oldP) ?? oldP;
    this.now.set(oldP, null);
    this.now.set(newP, text);
    this.origins.delete(oldP);
    this.created.delete(oldP);
    if (wasCreated) {
      this.created.add(newP);
    } else if (origin !== newP) {
      this.origins.set(newP, origin);
    }
  }

  snapshot(): { now: Map<string, string | null>; origins: Map<string, string>; created: Set<string> } {
    return { now: new Map(this.now), origins: new Map(this.origins), created: new Set(this.created) };
  }

  restore(s: { now: Map<string, string | null>; origins: Map<string, string>; created: Set<string> }): void {
    this.now.clear();
    for (const [k, v] of s.now) this.now.set(k, v);
    this.origins.clear();
    for (const [k, v] of s.origins) this.origins.set(k, v);
    this.created.clear();
    for (const v of s.created) this.created.add(v);
  }
}

type Edit = (tree: Tree) => void;

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Shared: apply hunks / chunks of old lines O replaced by new lines N.
// ---------------------------------------------------------------------------

interface BodyItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  noEol: boolean;
}

/** O lines and N items from a hunk/chunk body. */
function splitBody(items: BodyItem[]): { oldLines: string[]; newItems: NewItem[] } {
  const oldLines: string[] = [];
  const newItems: NewItem[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      oldLines.push(it.text);
      newItems.push({ text: it.text, ctx: oldLines.length - 1 });
    } else if (it.kind === 'old') {
      oldLines.push(it.text);
    } else {
      newItems.push({ text: it.text, ctx: null });
    }
  }
  return { oldLines, newItems };
}

/** The last context or new body line carries a trailing \ marker, if any. */
function lastNewNoEol(items: BodyItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i]!;
    if (it.kind === 'ctx' || it.kind === 'new') return it.noEol;
  }
  return false;
}

interface Hunk {
  a: number;
  items: BodyItem[];
}

/** Apply hunks in order to a file's text; throws EditFault on a failed hunk. */
function applyHunks(text: string, hunks: Hunk[], path: string, strict: boolean): string {
  const parts = splitFile(text);
  let lines = [...parts.lines];
  let final = parts.final;
  let d = 0;
  for (const hunk of hunks) {
    const { oldLines, newItems } = splitBody(hunk.items);
    const noEol = lastNewNoEol(hunk.items);
    if (oldLines.length > 0) {
      const found = firstTier(lines, oldLines, strict);
      if (found === null) throw new EditFault('no-match', path);
      const target = hunk.a - 1 + d;
      let pos = found.occ[0]!;
      for (const p of found.occ) {
        if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      }
      const repl = replacementLines(lines, oldLines, newItems, pos, found.tier);
      const touchesEnd = pos + oldLines.length === lines.length;
      lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + oldLines.length)];
      if (touchesEnd) final = !noEol;
    } else {
      const ins = Math.min(hunk.a + d, lines.length);
      const repl = newItems.map((it) => it.text);
      lines = [...lines.slice(0, ins), ...repl, ...lines.slice(ins)];
      if (ins === lines.length && repl.length > 0) final = !noEol;
    }
    d += newItems.length - oldLines.length;
  }
  return joinFile({ br: parts.br, lines, final });
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

function parseDiffGit(line: string, lineNo: number): { old: string; new: string } {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new ParseFault(lineNo);
  const sep = rest.indexOf(' b/');
  if (sep < 0) throw new ParseFault(lineNo);
  const old = rest.slice(2, sep);
  const nw = rest.slice(sep + 3);
  if (old === '' || nw === '') throw new ParseFault(lineNo);
  return { old, new: nw };
}

function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function headerPath(line: string): string {
  const after = line.slice(4);
  const tab = after.indexOf('\t');
  return stripAB((tab < 0 ? after : after.slice(0, tab)).trim());
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;

/** Parse one hunk starting at `i`; returns the hunk and the next line index. */
function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = HUNK_HEAD.exec(lines[i]!);
  if (m === null) throw new ParseFault(i + 1);
  const a = Number(m[1]);
  const items: BodyItem[] = [];
  let j = i + 1;
  let lastWasMarker = false;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('\\')) {
      if (items.length > 0) items[items.length - 1]!.noEol = true;
      lastWasMarker = true;
      j += 1;
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      const kind = l === '' || l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new';
      items.push({ kind, text: l === '' ? '' : l.slice(1), noEol: false });
      lastWasMarker = false;
      j += 1;
      continue;
    }
    break;
  }
  while (items.length > 0 && !lastWasMarker) {
    const last = items[items.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') items.pop();
    else break;
  }
  return { hunk: { a, items }, next: j };
}

function parseUnified(lines: string[]): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let inHeader = false;
  let pairSeen = false;
  const finish = (): void => {
    if (cur !== null) sections.push(cur);
    cur = null;
    inHeader = false;
    pairSeen = false;
  };
  const startDiff = (line: string, lineNo: number): void => {
    const p = parseDiffGit(line, lineNo);
    finish();
    cur = { oldPath: p.old, newPath: p.new, newFile: false, delFile: false, hunks: [] };
    inHeader = true;
  };
  const startBare = (i: number): number => {
    finish();
    cur = { oldPath: headerPath(lines[i]!), newPath: headerPath(lines[i + 1]!), newFile: false, delFile: false, hunks: [] };
    inHeader = true;
    pairSeen = true;
    return i + 2;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (cur === null) {
      if (l.startsWith('diff --git ')) {
        startDiff(l, i + 1);
        i += 1;
        continue;
      }
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        i = startBare(i);
        continue;
      }
      if (l.startsWith('@@')) throw new ParseFault(i + 1);
      i += 1;
      continue;
    }
    if (inHeader) {
      if (l.startsWith('@@')) {
        const r = parseHunk(lines, i);
        cur.hunks.push(r.hunk);
        i = r.next;
        inHeader = false;
        continue;
      }
      if (l.startsWith('diff --git ')) {
        startDiff(l, i + 1);
        i += 1;
        continue;
      }
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (pairSeen) {
            i = startBare(i);
            continue;
          }
          cur.oldPath = headerPath(l);
          cur.newPath = headerPath(lines[i + 1]!);
          pairSeen = true;
          i += 2;
          continue;
        }
        throw new ParseFault(i + 2);
      }
      if (l.startsWith('rename from ')) cur.oldPath = stripAB(l.slice('rename from '.length).trim());
      else if (l.startsWith('rename to ')) cur.newPath = stripAB(l.slice('rename to '.length).trim());
      else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) cur.delFile = true;
      i += 1;
      continue;
    }
    // After the first hunk: more hunks, a new section, or ignored prose.
    if (l.startsWith('@@')) {
      const r = parseHunk(lines, i);
      cur.hunks.push(r.hunk);
      i = r.next;
      continue;
    }
    if (l.startsWith('diff --git ')) {
      startDiff(l, i + 1);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      i = startBare(i);
      continue;
    }
    i += 1;
  }
  finish();
  return sections.map((s) => unifiedEdit(s));
}

function unifiedEdit(s: UnifiedSection): Edit {
  return (tree: Tree) => {
    const oldP = s.oldPath;
    const newP = s.newPath;
    const isCreate = oldP === '/dev/null' || s.newFile;
    const isDelete = !isCreate && (newP === '/dev/null' || s.delFile);
    if (isCreate) {
      const target = newP!;
      if (target !== '/dev/null' && !isSafePath(target)) throw new EditFault('unsafe', target);
      if (tree.occupied(target)) throw new EditFault('exists', target);
      const plus: BodyItem[] = [];
      for (const h of s.hunks) for (const it of h.items) if (it.kind === 'new') plus.push(it);
      const text = plus.length === 0 ? '' : plus.map((it) => it.text).join('\n') + (lastNewNoEol(plus) ? '' : '\n');
      tree.setFile(target, text);
      return;
    }
    if (isDelete) {
      const target = oldP!;
      if (!isSafePath(target)) throw new EditFault('unsafe', target);
      if (tree.get(target) === null) throw new EditFault('missing', target);
      tree.deleteFile(target);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      if (!isSafePath(oldP)) throw new EditFault('unsafe', oldP);
      if (!isSafePath(newP)) throw new EditFault('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new EditFault('missing', oldP);
      if (tree.occupied(newP)) throw new EditFault('exists', newP);
      const after = applyHunks(before, s.hunks, oldP, unifiedEditStrict);
      tree.moveFile(oldP, newP, after);
      return;
    }
    const target = oldP ?? newP!;
    if (!isSafePath(target)) throw new EditFault('unsafe', target);
    const before = tree.get(target);
    if (before === null) throw new EditFault('missing', target);
    tree.editFile(target, applyHunks(before, s.hunks, target, unifiedEditStrict));
  };
}

// Set by the caller before edits run; unified edits read it through the closure.
let unifiedEditStrict = false;

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j -= 1) {
      const cand = lines[j]!;
      if (isBlank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseFault(searchLine);
      path = prevPath;
    }
    let eq = -1;
    for (let k = i + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq < 0) throw new ParseFault(searchLine);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new ParseFault(searchLine);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree: Tree) => {
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.occupied(path)) throw new EditFault('exists', path);
      tree.setFile(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new EditFault('missing', path);
    const parts = splitFile(before);
    const found = firstTier(parts.lines, oldLines, strict);
    if (found === null) throw new EditFault('no-match', path);
    if (found.occ.length > 1) throw new EditFault('ambiguous', path);
    const pos = found.occ[0]!;
    const items: NewItem[] = newLines.map((t) => ({ text: t, ctx: null }));
    const repl = replacementLines(parts.lines, oldLines, items, pos, found.tier);
    const out = [...parts.lines.slice(0, pos), ...repl, ...parts.lines.slice(pos + oldLines.length)];
    tree.editFile(path, joinFile({ br: parts.br, lines: out, final: parts.final }));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: V4aChunk[];
  lineNo: number;
}

function isV4aSectionStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!isBlank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (isBlank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      const collected: string[] = [];
      const rawLines: number[] = [];
      let j = i + 1;
      while (j < last && !isV4aSectionStart(lines[j]!)) {
        collected.push(lines[j]!);
        rawLines.push(j + 1);
        j += 1;
      }
      while (collected.length > 0 && isBlank(collected[collected.length - 1]!)) {
        collected.pop();
        rawLines.pop();
      }
      const fileLines: string[] = [];
      for (let k = 0; k < collected.length; k += 1) {
        const cl = collected[k]!;
        if (cl === '') fileLines.push('');
        else if (cl.startsWith('+')) fileLines.push(cl.slice(1));
        else throw new ParseFault(rawLines[k]!);
      }
      sections.push({ kind: 'add', path, moveTo: null, lines: fileLines, chunks: [], lineNo: i + 1 });
      i = j;
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < last && !isV4aSectionStart(lines[j]!)) {
        if (!isBlank(lines[j]!)) throw new ParseFault(j + 1);
        j += 1;
      }
      sections.push({ kind: 'delete', path, moveTo: null, lines: [], chunks: [], lineNo: i + 1 });
      i = j;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        j += 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      while (j < last) {
        const cl = lines[j]!;
        if (isV4aSectionStart(cl)) break;
        if (cl.trim() === '*** End of File') {
          if (cur === null) throw new ParseFault(j + 1);
          cur.eof = true;
          cur = null;
          j += 1;
          continue;
        }
        if (cl.startsWith('@@')) {
          cur = { anchor: cl.slice(2).trim(), eof: false, items: [] };
          chunks.push(cur);
          j += 1;
          continue;
        }
        if (cl === '' || cl[0] === ' ' || cl[0] === '-' || cl[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) {
              // Blank line after an "*** End of File" chunk: a blank line at
              // the end of the section, not a body line. A non-blank body
              // line here is still a parse error (next chunk needs "@@").
              if (isBlank(cl)) {
                j += 1;
                continue;
              }
              throw new ParseFault(j + 1);
            }
            cur = { anchor: null, eof: false, items: [] };
            chunks.push(cur);
          }
          const kind = cl === '' || cl[0] === ' ' ? 'ctx' : cl[0] === '-' ? 'old' : 'new';
          cur.items.push({ kind, text: cl === '' ? '' : cl.slice(1), noEol: false });
          j += 1;
          continue;
        }
        throw new ParseFault(j + 1);
      }
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        if (!lastChunk.eof) {
          while (lastChunk.items.length > 0) {
            const it = lastChunk.items[lastChunk.items.length - 1]!;
            if (it.kind === 'ctx' && it.text === '') lastChunk.items.pop();
            else break;
          }
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseFault(updateLine);
      sections.push({ kind: 'update', path, moveTo, lines: [], chunks, lineNo: updateLine });
      i = j;
      continue;
    }
    throw new ParseFault(i + 1);
  }
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(s: V4aSection, strict: boolean): Edit {
  return (tree: Tree) => {
    if (!isSafePath(s.path)) throw new EditFault('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.occupied(s.path)) throw new EditFault('exists', s.path);
      tree.setFile(s.path, s.lines.length === 0 ? '' : `${s.lines.join('\n')}\n`);
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new EditFault('missing', s.path);
      tree.deleteFile(s.path);
      return;
    }
    if (s.moveTo !== null && !isSafePath(s.moveTo)) throw new EditFault('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new EditFault('missing', s.path);
    if (s.moveTo !== null && tree.occupied(s.moveTo)) throw new EditFault('exists', s.moveTo);
    const parts = splitFile(before);
    let lines = [...parts.lines];
    let cursor = 0;
    const tiers = tiersToTry(strict);
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null && chunk.anchor !== '') {
        let foundAt: number | null = null;
        for (const tier of tiers) {
          for (let k = cursor; k < lines.length; k += 1) {
            if (normLine(lines[k]!, tier) === normLine(chunk.anchor, tier)) {
              foundAt = k;
              break;
            }
          }
          if (foundAt !== null) break;
        }
        if (foundAt === null) throw new EditFault('no-match', s.path);
        cursor = foundAt + 1;
      }
      const { oldLines, newItems } = splitBody(chunk.items);
      if (oldLines.length > 0) {
        let picked: { tier: number; pos: number } | null = null;
        for (const tier of tiers) {
          const occ = occurrences(lines, oldLines, tier).filter((p) => p >= cursor);
          if (occ.length === 0) continue;
          if (chunk.eof) {
            const atEnd = occ.find((p) => p + oldLines.length === lines.length);
            if (atEnd === undefined) continue;
            picked = { tier, pos: atEnd };
          } else {
            picked = { tier, pos: occ[0]! };
          }
          break;
        }
        if (picked === null) throw new EditFault('no-match', s.path);
        const repl = replacementLines(lines, oldLines, newItems, picked.pos, picked.tier);
        lines = [...lines.slice(0, picked.pos), ...repl, ...lines.slice(picked.pos + oldLines.length)];
        cursor = picked.pos + repl.length;
      } else {
        const ins = chunk.eof ? lines.length : cursor;
        const repl = newItems.map((it) => it.text);
        lines = [...lines.slice(0, ins), ...repl, ...lines.slice(ins)];
        cursor = ins + repl.length;
      }
    }
    const after = joinFile({ br: parts.br, lines, final: parts.final });
    if (s.moveTo !== null) {
      tree.moveFile(s.path, s.moveTo, after);
    } else {
      tree.editFile(s.path, after);
    }
  };
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafePath(p)) throw new EditFault('unsafe', p);
      if (tree.occupied(p)) throw new EditFault('exists', p);
      tree.setFile(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!isSafePath(p)) throw new EditFault('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFault('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const norm = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFault('no-match', p);
      if (count > 1) throw new EditFault('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.editFile(p, crlf ? out.split('\n').join('\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = splitPatchLines(o.new_str);
    return (tree) => {
      if (!isSafePath(p)) throw new EditFault('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFault('missing', p);
      const parts = splitFile(before);
      if (line < 0 || line > parts.lines.length) throw new EditFault('no-match', p);
      const out = [...parts.lines];
      out.splice(line, 0, ...add);
      tree.editFile(p, joinFile({ br: parts.br, lines: out, final: parts.final }));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFault(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseFault(first + 1);
    const edits: Edit[] = [];
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new ParseFault(first + 1);
      edits.push(e);
    }
    return edits;
  }
  const edits: Edit[] = [];
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseFault(i + 1);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Command line, output, exit codes (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null || !FORMATS.includes(a.slice(9))) return { code: 2, out: ['error: usage'] };
        format = a.slice(9);
      } else if (a === '--check') {
        if (check) return { code: 2, out: ['error: usage'] };
        check = true;
      } else if (a === '--strict') {
        if (strict) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' || pos[0] === '' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  unifiedEditStrict = strict;
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new ParseFault(1);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFault[] = [];
  for (const edit of edits) {
    const before = tree.snapshot();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      tree.restore(before);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  interface Row {
    key: string;
    line: string;
    kind: 'A' | 'D' | 'M' | 'R';
    path: string;
    oldPath?: string;
  }
  const rows: Row[] = [];
  const byPath = new Map<string, Row>();
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const kind = was === null ? 'A' : now === null ? 'D' : 'M';
    const row: Row = { key: p, line: `${kind} ${p}`, kind, path: p };
    rows.push(row);
    byPath.set(p, row);
  }
  // Rename reporting follows file identity, not path history: a path's
  // current file is a rename of its origin only while that identity is
  // unbroken (move keeps it, delete ends it, create starts a new one).
  const finalAbsent = (p: string): boolean => (tree.now.has(p) ? tree.now.get(p) === null : tree.original(p) === null);
  const finalPresent = (p: string): boolean => (tree.now.has(p) ? tree.now.get(p) !== null : tree.original(p) !== null);
  for (const f of [...tree.origins.keys()]) {
    const origin = tree.origins.get(f)!;
    if (origin === f) continue;
    if (tree.original(origin) !== null && finalAbsent(origin) && tree.original(f) === null && finalPresent(f)) {
      const dRow = byPath.get(origin);
      const aRow = byPath.get(f);
      if (dRow !== undefined && dRow.kind === 'D' && aRow !== undefined && aRow.kind === 'A') {
        rows.splice(rows.indexOf(dRow), 1);
        rows.splice(rows.indexOf(aRow), 1);
        byPath.delete(origin);
        byPath.delete(f);
        rows.push({ key: f, line: `R ${origin} -> ${f}`, kind: 'R', path: f, oldPath: origin });
      }
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    // A file the final tree still holds cannot be an ancestor of a file
    // being written (a path cannot be both a file and a directory). The
    // edits all succeeded on the virtual tree, but the result has no
    // representation on disk: fail the run without writing anything.
    const parentBlocked = (p: string): boolean => {
      const parts = p.split('/');
      let prefix = '';
      for (let k = 0; k < parts.length - 1; k += 1) {
        prefix = prefix === '' ? parts[k]! : `${prefix}/${parts[k]!}`;
        if (tree.get(prefix) !== null) return true;
      }
      return false;
    };
    const blocked = rows.find((r) => r.kind !== 'D' && parentBlocked(r.path));
    if (blocked !== undefined) return { code: 1, out: [`error: exists ${blocked.path}`] };
    // Two phases, so the order of the output rows never matters: first
    // remove every file that disappears, then create directories and write
    // every file that appears. A rename source reused as a directory for a
    // new file (move a -> z, add a/b) works because a is already gone.
    for (const r of rows) {
      if (r.kind === 'D') rmSync(r.path, { force: true });
      else if (r.kind === 'R') rmSync(r.oldPath!, { force: true });
    }
    for (const r of rows) {
      if (r.kind === 'D') continue;
      mkdirSync(dirname(r.path), { recursive: true });
      writeFileSync(r.path, tree.now.get(r.path)!);
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
