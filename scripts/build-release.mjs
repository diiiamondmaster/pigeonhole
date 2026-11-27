#!/usr/bin/env node
// Build the Windows release zip: Pigeonhole-x.y.z-win-x64.zip
//   node scripts/build-release.mjs [--out DIR]
//
// Layout (matches every shipped release): the stock Electron win32-x64
// distribution with electron.exe renamed to Pigeonhole.exe, and the app
// packed as resources/app.asar (LICENSE, app/, assets/screenshots, main/,
// preload.js, package.json - no dev/, scripts/, docs/, node_modules).
// The Electron dist is downloaded once and cached in .build-cache/.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const asarBin = path.join(ROOT, 'node_modules', '@electron', 'asar', 'bin', 'asar.mjs');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;                       // e.g. 1.1.0-beta.4
const ELECTRON_VER = (require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version);
const ZIP_NAME = `Pigeonhole-${version}-win-x64.zip`;

const outDir = (process.argv.includes('--out')
  ? path.resolve(process.argv[process.argv.indexOf('--out') + 1] || '.')
  : path.join(ROOT, 'dist'));
const cacheDir = path.join(ROOT, '.build-cache');
const electronZip = path.join(cacheDir, `electron-v${ELECTRON_VER}-win32-x64.zip`);

const APP_FILES = ['LICENSE', 'preload.js', 'package.json'];
const APP_DIRS = ['app', 'assets/screenshots', 'main'];

console.log(`building ${ZIP_NAME} (electron ${ELECTRON_VER})`);
fs.mkdirSync(cacheDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

// 1. cached Electron win32-x64 dist
if (!fs.existsSync(electronZip) || fs.statSync(electronZip).size < 1000 * 1000) {
  const url = `https://github.com/electron/electron/releases/download/v${ELECTRON_VER}/electron-v${ELECTRON_VER}-win32-x64.zip`;
  console.log('downloading', url);
  execFileSync('curl', ['-sL', '-o', electronZip, url], { stdio: 'inherit' });
}

// 2. stage the app tree and pack it as app.asar
const stage = path.join(cacheDir, 'app-stage');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const f of APP_FILES) fs.copyFileSync(path.join(ROOT, f), path.join(stage, f));
for (const d of APP_DIRS) {
  fs.mkdirSync(path.join(stage, d), { recursive: true });
  fs.cpSync(path.join(ROOT, d), path.join(stage, d), { recursive: true });
}
const appAsar = path.join(cacheDir, 'app.asar');
fs.rmSync(appAsar, { force: true });
execFileSync(process.execPath, [asarBin, 'pack', stage, appAsar], { stdio: 'inherit' });

// 3. stage the win dir: electron dist + Pigeonhole.exe + our asar
const win = path.join(cacheDir, 'win-stage');
fs.rmSync(win, { recursive: true, force: true });
fs.mkdirSync(win, { recursive: true });
execFileSync('unzip', ['-q', electronZip, '-d', win], { stdio: 'inherit' });
fs.renameSync(path.join(win, 'electron.exe'), path.join(win, 'Pigeonhole.exe'));
// the exe keeps Electron's own icon unless we replace the PE resources:
// patch in the amber pigeonhole mark + a proper version stamp
execFileSync(process.execPath, [
  path.join(ROOT, 'scripts', 'patch-exe-icon.mjs'),
  path.join(win, 'Pigeonhole.exe'),
  path.join(ROOT, 'build', 'icon.ico'),
  version
], { stdio: 'inherit', cwd: ROOT });
fs.rmSync(path.join(win, 'resources', 'default_app.asar'), { force: true });
fs.renameSync(path.join(win, 'LICENSE'), path.join(win, 'LICENSE.electron.txt'));   // match shipped layout
fs.rmSync(path.join(win, 'version'), { force: true });
fs.copyFileSync(appAsar, path.join(win, 'resources', 'app.asar'));

// 4. zip it (store the big binary payload uncompressed-ish: -9 is slow for
//    ~340MB; the dist is mostly already-compressed chromium bits)
const outZip = path.join(outDir, ZIP_NAME);
fs.rmSync(outZip, { force: true });
execFileSync('zip', ['-q', '-r', '-9', outZip, '.'], { cwd: win, stdio: 'inherit' });
console.log('built', outZip, Math.round(fs.statSync(outZip).size / 1e6) + ' MB');
