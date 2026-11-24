// Pigeonhole - self-update from GitHub Releases.
// The app ships as a portable zip: the program lives in one folder, every bit
// of user data (workspaces, vault, settings, per-workspace browser profiles)
// lives in the OS app-data folder. Swapping the program folder therefore never
// touches user data - that is the entire data-safety story.
//
// Flow: GET /releases/latest -> semver compare -> background download into
// %TEMP% -> the update "applies on quit": when the user quits (or clicks
// Restart & update) a detached PowerShell helper waits for this process to
// exit, unzips the new build over the program folder and relaunches it.
const { app, net } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const RELEASES_API = process.env.PH_UPDATE_API ||
  'https://api.github.com/repos/diiiamondmaster/pigeonhole/releases/latest';
const ASSET_RE = /^pigeonhole-(\d+(?:\.\d+)*)-win-x64\.zip$/i;

function parseVer(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}
function isNewer(a, b) {
  const x = parseVer(a), y = parseVer(b);
  return x[0] !== y[0] ? x[0] > y[0] : x[1] !== y[1] ? x[1] > y[1] : x[2] > y[2];
}
const psq = (s) => String(s).replace(/'/g, "''");   // powershell single-quote escape

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url });
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
    const chunks = [];
    req.on('response', (res) => {
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

// streamed download with progress (no full-file buffering: the zip is ~130 MB)
function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url });
    req.setHeader('User-Agent', 'pigeonhole-updater');
    const out = fs.createWriteStream(dest);
    let received = 0, total = 0, done = false;
    const bail = (err) => {
      if (done) return; done = true;
      try { out.close(); } catch { }
      try { fs.unlinkSync(dest); } catch { }   // never keep a partial zip
      reject(err);
    };
    req.on('response', (res) => {
      total = Number(res.headers['content-length'] || 0);
      if (res.statusCode !== 200) {
        try { res.destroy(); } catch { }
        bail(new Error('Download answered HTTP ' + res.statusCode));
        return;
      }
      res.on('data', (c) => {
        received += c.length;
        out.write(c);
        if (total && onProgress) onProgress(Math.min(100, Math.round(received / total * 100)));
      });
      res.on('aborted', () => bail(new Error('Download interrupted')));
      res.on('end', () => out.end(() => { if (!done) { done = true; resolve({ bytes: received }); } }));
    });
    req.on('error', bail);
    req.end();
  });
}

function createUpdater(send, hooks = {}) {
  const st = {
    phase: 'idle', current: app.getVersion(),
    latest: null, hasUpdate: false, size: 0,
    assetName: '', assetUrl: '', zipPath: null, error: null, _applied: false
  };
  const pendingFile = () => path.join(app.getPath('userData'), 'pending-update.json');
  const snap = () => ({ current: st.current, latest: st.latest, hasUpdate: st.hasUpdate, size: st.size, phase: st.phase, error: st.error, zipReady: !!(st.zipPath && fs.existsSync(st.zipPath)) });

  // ---- detached helper: waits for exit, unzips over the program folder ----
  function spawnHelper(appDir, zip, relaunch, pid) {
    const scriptPath = path.join(os.tmpdir(), 'pigeonhole-update.cmd');
    const log = path.join(os.tmpdir(), 'pigeonhole-update.log');
    const exe = path.join(appDir, 'Pigeonhole.exe');
    const ps =
      `$p=${pid}; $log='${psq(log)}'; $zip='${psq(zip)}'; $dir='${psq(appDir)}'; ` +
      `try { while (Get-Process -Id $p -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 700 }; ` +
      `$ok=$false; foreach ($i in 1..5) { try { Expand-Archive -LiteralPath $zip -DestinationPath $dir -Force; $ok=$true; break } catch { Start-Sleep -Seconds 2 } }; ` +
      `if ($ok) { Set-Content $log ('updated to ${psq(String(st.latest || ''))} at ' + (Get-Date)); Remove-Item $zip -ErrorAction SilentlyContinue; ` +
      `${relaunch ? `Start-Process -FilePath '${psq(exe)}'; ` : ''}` +
      `} else { Set-Content $log 'extract failed after 5 attempts' } ` +
      `} catch { Set-Content $log $_.Exception.Message }`;
    const cmd = [
      '@echo off',
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps.replace(/"/g, '')}"`,
      '(goto) 2>nul & del "%~f0"'
    ].join('\r\n') + '\r\n';
    fs.writeFileSync(scriptPath, cmd, 'utf8');
    const child = spawn('cmd.exe', ['/c', scriptPath], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return scriptPath;
  }

  // ---- check GitHub for a newer release ----
  async function check({ silent = false } = {}) {
    st.phase = 'checking'; st.error = null;
    try {
      const res = await get(RELEASES_API, { 'User-Agent': 'pigeonhole-updater', 'Accept': 'application/vnd.github+json' });
      if (res.status !== 200) throw new Error('GitHub answered HTTP ' + res.status + (res.status === 403 ? ' (rate limited?)' : ''));
      const rel = JSON.parse(res.body.toString('utf8'));
      const tag = String(rel.tag_name || '').replace(/^v/, '');
      const asset = (rel.assets || []).find(a => ASSET_RE.test(a.name || ''));
      if (!tag || !asset) throw new Error('The latest release has no Windows zip asset');
      st.latest = tag;
      st.assetName = asset.name;
      st.assetUrl = asset.browser_download_url;
      st.size = asset.size || 0;
      st.hasUpdate = isNewer(tag, st.current);
      if (st.hasUpdate) send('update-available', { current: st.current, latest: st.latest, size: st.size });
    } catch (e) {
      st.error = e.message; st.hasUpdate = false;
      if (!silent) send('update-error', { message: e.message });
    }
    st.phase = 'idle';
    return snap();
  }

  // ---- background download; arms apply-on-quit ----
  async function download() {
    if (st.phase === 'downloading') return snap();
    if (st.zipPath && fs.existsSync(st.zipPath)) return snap();
    if (!st.hasUpdate || !st.assetUrl) { st.error = 'Nothing to download'; return snap(); }
    st.phase = 'downloading'; st.error = null;
    const dest = path.join(os.tmpdir(), 'pigeonhole-' + st.assetName);
    try {
      send('update-download-progress', { pct: 0 });
      await downloadFile(st.assetUrl, dest, (pct) => send('update-download-progress', { pct }));
      st.zipPath = dest; st.phase = 'ready';
      fs.writeFileSync(pendingFile(), JSON.stringify({ zip: dest, version: st.latest, size: st.size, at: Date.now() }), 'utf8');
      send('update-ready', { current: st.current, latest: st.latest, size: st.size });
    } catch (e) {
      st.phase = 'idle'; st.error = e.message;
      send('update-error', { message: e.message });
    }
    return snap();
  }

  // ---- apply: write helper script, spawn it detached, exit (restart mode) ----
  function install(mode = 'restart') {
    if (st._applied) return { ok: true };
    let zip = st.zipPath;
    if (!zip || !fs.existsSync(zip)) {
      try {
        const p = JSON.parse(fs.readFileSync(pendingFile(), 'utf8'));
        if (p.zip && fs.existsSync(p.zip)) { zip = p.zip; st.latest = st.latest || p.version; }
      } catch { }
    }
    if (!zip) return { ok: false, error: 'No update has been downloaded yet' };
    if (!app.isPackaged) return { ok: false, error: 'Dev builds do not self-install - download the release zip instead' };
    if (process.platform !== 'win32') return { ok: false, error: 'Self-update currently supports Windows only' };
    const appDir = path.dirname(process.execPath);
    try { fs.accessSync(appDir, fs.constants.W_OK); } catch {
      return { ok: false, error: 'No write access to the program folder - extract the release zip by hand' };
    }
    st._applied = true;
    try { hooks.beforeExit?.(); } catch { }        // flush the store before exit
    spawnHelper(appDir, zip, mode === 'restart', process.pid);
    try { fs.rmSync(pendingFile(), { force: true }); } catch { }
    if (mode === 'restart') app.exit(0);
    return { ok: true };
  }

  // boot: a pending update from an earlier session (crash / quit never ran)
  function reconcilePending() {
    try {
      if (!fs.existsSync(pendingFile())) return;
      const p = JSON.parse(fs.readFileSync(pendingFile(), 'utf8'));
      if (!p.zip || !fs.existsSync(p.zip) || !isNewer(p.version, st.current)) {
        fs.rmSync(pendingFile(), { force: true });   // already applied or zip gone
        return;
      }
      st.zipPath = p.zip; st.latest = p.version; st.size = p.size || 0; st.hasUpdate = true; st.phase = 'ready';
      send('update-ready', { current: st.current, latest: st.latest, size: st.size });
    } catch { try { fs.rmSync(pendingFile(), { force: true }); } catch { } }
  }

  // quit path: apply quietly, no relaunch (the user is leaving anyway)
  function applyPendingOnQuit() {
    if (st._applied) return;
    try {
      if (!fs.existsSync(pendingFile())) return;
      const p = JSON.parse(fs.readFileSync(pendingFile(), 'utf8'));
      if (p.zip && fs.existsSync(p.zip)) install('quit');
      else fs.rmSync(pendingFile(), { force: true });
    } catch { }
  }

  async function autoCheck() {
    try { const r = await check({ silent: true }); if (r.hasUpdate) await download(); } catch { }
  }

  return { check, download, install, autoCheck, reconcilePending, applyPendingOnQuit, snap };
}

module.exports = { createUpdater, parseVer, isNewer };
