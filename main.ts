// gta6-01 entry plumbing (Node 22+, standard library only, TypeScript stripped by Node's loader).
//
// The entry is this directory's game/ (plain static files a desktop browser loads offline, game/index.html
// at its root) and screenshots/ (3 or 4 PNG or JPEG renders, the first by name the cover). This program
// checks both, copies them under the output directory, and writes dossier.json from the vendored
// make.fun library so the judge reads the same summary the gate does.
//
// Run it with `node main.ts`. The output directory is $MAKEFUN_OUTPUT_DIR, or /output inside the grader.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
//
// Anything wrong with the inputs is reported on stderr before a single byte is written.

import { closeSync, cpSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

/** The gate's screenshot caps (reference/gate.json): 3 or 4 images, each at most 256 KiB. */
const SCREENSHOT_MIN = 3;
const SCREENSHOT_MAX = 4;
const SCREENSHOT_MAX_BYTES = 262144;

/** The dossier may be at most 1.5 MiB; the gate reads this file, so oversize is our own failure. */
const DOSSIER_MAX_BYTES = 1.5 * 1024 * 1024;

/** A whole PNG or JPEG: the magic the gate checks, and nothing else, decides the type. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Stop with a clear reason and a non-zero exit, before or after writing: the entry is not ready either way. */
function fail(message: string): never {
  process.stderr.write(`main.ts: ${message}\n`);
  process.exit(1);
}

/** Whether `bytes` opens with `magic`, i.e. carries that image format's signature. */
function opensWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) return false;
  return true;
}

/** The first `count` bytes of a file (fewer when it is shorter): enough to read an image signature. */
function readHead(path: string, count: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(count);
    const got = readSync(fd, buf, 0, count, 0);
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

/** The image format a screenshot's bytes declare, or null when they carry neither signature. */
function imageFormat(bytes: Uint8Array): 'PNG' | 'JPEG' | null {
  if (opensWith(bytes, PNG_MAGIC)) return 'PNG';
  if (opensWith(bytes, JPEG_MAGIC)) return 'JPEG';
  return null;
}

/** Names a directory holds, in code-unit order, with each entry's kind: the order buildDossier uses. */
function readDir(dir: string, label: string): { name: string; isFile: boolean; isDirectory: boolean }[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .map((e) => ({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory() }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch (err) {
    return fail(`${label}: cannot be read (${(err as Error).message})`);
  }
}

/** How many plain files game/ holds and how many bytes they come to, walked recursively. */
function gameTotals(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const pending = [''];
  while (pending.length > 0) {
    const rel = pending.pop()!;
    for (const entry of readDir(rel === '' ? dir : join(dir, rel), rel === '' ? 'game/' : `game/${rel}/`)) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory) {
        pending.push(childRel);
      } else if (entry.isFile) {
        files++;
        bytes += statSync(join(dir, childRel)).size;
      } else {
        // A link or special file: buildDossier refuses it, so say so here rather than half-copy it.
        fail(`game/${childRel}: a symbolic link or special file (game/ holds plain files and directories only)`);
      }
    }
  }
  return { files, bytes };
}

// ------------------------------------------------------------------ inputs, before anything is written

const gameDir = join(here, 'game');
const screenshotsDir = join(here, 'screenshots');

let indexStat;
try {
  indexStat = statSync(join(gameDir, 'index.html'));
} catch {
  fail('game/index.html: no such file: the game is game/, a directory of static files with index.html at its root');
}
if (!indexStat.isFile()) fail('game/index.html: not a plain file');

let shotsStat;
try {
  shotsStat = statSync(screenshotsDir);
} catch {
  fail('screenshots/: no such directory: an entry hands in 3 or 4 renders of its game, the first by name the cover');
}
if (!shotsStat.isDirectory()) fail('screenshots/: not a directory');

const screenshots: { name: string; bytes: number }[] = [];
for (const entry of readDir(screenshotsDir, 'screenshots/')) {
  // buildDossier silently skips dot-named files, which would quietly shrink the entry: refuse instead.
  if (entry.name.startsWith('.')) fail(`screenshots/${entry.name}: a name may not start with a dot`);
  if (!entry.isFile) fail(`screenshots/${entry.name}: not a plain file`);
  const path = join(screenshotsDir, entry.name);
  const size = statSync(path).size;
  if (size > SCREENSHOT_MAX_BYTES) {
    fail(`screenshots/${entry.name}: ${size} bytes, over the ${SCREENSHOT_MAX_BYTES} the gate allows`);
  }
  // Read only the first bytes for the signature: the whole file is copied later, unchanged.
  const format = imageFormat(new Uint8Array(readHead(path, PNG_MAGIC.length)));
  if (format === null) fail(`screenshots/${entry.name}: neither a PNG nor a JPEG (no matching magic bytes)`);
  screenshots.push({ name: entry.name, bytes: size });
}
if (screenshots.length < SCREENSHOT_MIN || screenshots.length > SCREENSHOT_MAX) {
  fail(`screenshots/: holds ${screenshots.length} file${screenshots.length === 1 ? '' : 's'}, the gate wants ${SCREENSHOT_MIN} or ${SCREENSHOT_MAX}`);
}

const game = gameTotals(gameDir);

// ------------------------------------------------------------------ report, then copy

process.stdout.write(`output directory: ${out}\n`);
process.stdout.write(`game: ${game.files} files, ${game.bytes} bytes\n`);
for (const shot of screenshots) process.stdout.write(`screenshot ${shot.name} (${shot.bytes} bytes)\n`);

mkdirSync(out, { recursive: true });
// Clear the destination copies first: a rerun must never leave a file the source no longer has.
for (const name of ['game', 'screenshots']) rmSync(join(out, name), { recursive: true, force: true });
cpSync(gameDir, join(out, 'game'), { recursive: true });
cpSync(screenshotsDir, join(out, 'screenshots'), { recursive: true });

// ------------------------------------------------------------------ the dossier, as the gate builds it

// The scorer's own caps (reference/gate.json), passed exactly as buildDossier documents: only
// text_max_bytes shapes the bytes; the rest refuse an entry the gate would refuse.
const dossierBytes = buildDossier(out, {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
  game_path_max_bytes: 1000,
});
writeFileSync(join(out, 'dossier.json'), dossierBytes);

// Re-read what actually landed: the judge reads the file, not the in-memory buffer.
const written = readFileSync(join(out, 'dossier.json'));
if (written.byteLength > DOSSIER_MAX_BYTES) {
  fail(`dossier.json: ${written.byteLength} bytes, over the ${DOSSIER_MAX_BYTES} the entry may hand in`);
}

let doc: unknown;
try {
  doc = JSON.parse(written.toString('utf8'));
} catch (err) {
  fail(`dossier.json: not valid JSON (${(err as Error).message})`);
}
if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) fail('dossier.json: not a JSON object');

const images = (doc as { images?: unknown }).images;
if (!Array.isArray(images)) fail('dossier.json: no "images" array');
if (images.length !== screenshots.length) {
  fail(`dossier.json: ${images.length} images for ${screenshots.length} screenshots`);
}
images.forEach((image, i) => {
  const name = typeof image === 'object' && image !== null ? (image as { name?: unknown }).name : undefined;
  if (name !== screenshots[i]!.name) fail(`dossier.json: images[${i}] is ${String(name)}, not ${screenshots[i]!.name}`);
});

const text = (doc as { text?: unknown }).text;
if (typeof text !== 'string') fail('dossier.json: no "text" string');

process.stdout.write(
  `entry ready: ${game.files} game files, ${screenshots.length} screenshots, dossier ${written.byteLength} bytes\n`,
);
