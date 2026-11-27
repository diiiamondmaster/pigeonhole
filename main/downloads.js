// Pigeonhole - downloads. Files land in the user's Downloads folder (or a custom
// one); progress is surfaced to the chrome as toasts via renderer events.
const { app, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let getWindow = () => null;
const active = new Map(); // id -> DownloadItem

function initDownloads(getWin) { getWindow = getWin; }

function send(payload) {
  const w = getWindow();
  if (w && !w.isDestroyed()) w.webContents.send('ph-event', { type: 'download', payload });
}

function uniquePath(dir, name) {
  const safe = name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 150) || 'download';
  let p = path.join(dir, safe);
  let i = 1;
  const ext = path.extname(safe);
  const base = path.basename(safe, ext);
  while (fs.existsSync(p)) {
    p = path.join(dir, `${base} (${i})${ext}`);
    i += 1;
  }
  return p;
}

function attachDownloadHandlers(ses) {
  if (ses.__phDownloads) return;
  ses.__phDownloads = true;
  ses.on('will-download', (_event, item, webContents) => {
    // mail backup capture FIRST: a backup-looking download from a workspace
    // with a mail identity never lands in the Downloads folder at all
    const { capture } = require('./backups');
    if (capture(item, webContents)) return;
    // registry lives in main; circular import avoided by lazy require
    const { store } = require('./store');
    const dir = store.state.settings.downloadsDir || app.getPath('downloads');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* fallthrough */ }
    const id = crypto.randomBytes(4).toString('hex');
    const savePath = uniquePath(dir, item.getFilename());
    item.setSavePath(savePath);
    active.set(id, item);

    send({ phase: 'start', id, name: path.basename(savePath), path: savePath, total: item.getTotalBytes() });

    item.on('updated', (_e, state) => {
      const received = item.getReceivedBytes();
      const total = item.getTotalBytes();
      send({ phase: 'progress', id, pct: total > 0 ? Math.round((received / total) * 100) : null, state });
    });
    item.once('done', (_e, state) => {
      active.delete(id);
      send({ phase: 'done', id, state, path: savePath, name: path.basename(savePath) });
      if (state === 'completed') {
        // auto-open the folder so the file is easy to find
        shell.showItemInFolder(savePath);
      }
    });
  });
}

function cancelDownload(id) {
  const item = active.get(String(id));
  if (item) { try { item.cancel(); } catch { /* already done */ } return true; }
  return false;
}

module.exports = { initDownloads, attachDownloadHandlers, cancelDownload };
