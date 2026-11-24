// Renderer side of the self-updater: reacts to update-* events from the main
// process (toast notifications + one-click restart) and offers a manual check.
// window.__upd mirrors the events so the E2E suite can assert on them.
import { toast } from './toasts.js';
import { PH } from './state.js';

window.__upd = window.__upd || [];

let progToast = null;

function progressToast(pct) {
  if (!progToast) {
    progToast = toast({
      title: 'Downloading update', sub: 'Runs in the background - keep browsing.',
      ic: 'download', type: 'info', progress: 0, timeout: 0
    });
  }
  progToast.setProgress(pct);
}
function closeProgress() {
  try { progToast?.dismiss(); } catch { }
  progToast = null;
}

export function handleUpdateEvent(type, payload) {
  window.__upd.push({ type, payload });
  if (type === 'update-available') {
    const mb = payload.size ? ' - ' + (payload.size / 1048576).toFixed(0) + ' MB' : '';
    toast({
      title: `Pigeonhole v${payload.latest} is out`,
      sub: `Downloading in the background${mb}. Your workspaces, vault and tabs stay untouched.`,
      ic: 'download', type: 'info', timeout: 7000
    });
  } else if (type === 'update-download-progress') {
    progressToast(payload.pct);
  } else if (type === 'update-ready') {
    closeProgress();
    toast({
      title: `v${payload.latest} is ready to install`,
      sub: 'It applies itself when you quit Pigeonhole - restart now if you like; tabs and workspaces come back exactly as they were.',
      ic: 'check', type: 'success', timeout: 30000,
      actions: [
        { label: 'Later' },
        { label: 'Restart & update', primary: true, onClick: () => PH().updates.install('restart') }
      ]
    });
  } else if (type === 'update-error') {
    closeProgress();
    toast({
      title: 'Update problem', sub: payload.message,
      ic: 'warn', type: 'error', timeout: 8000
    });
  }
}

export async function checkUpdates({ manual = false } = {}) {
  const r = await PH().updates.check();
  if (r?.error) {
    toast({ title: 'Could not check for updates', sub: r.error, ic: 'warn', type: 'error', timeout: 8000 });
  } else if (r && !r.hasUpdate) {
    toast({ title: 'Pigeonhole is up to date', sub: `v${r.current} matches the latest release.`, ic: 'check', type: 'success', timeout: 5000 });
  } else if (r && r.hasUpdate) {
    // the update-available event already toasted; start pulling the zip now
    await PH().updates.download();
  }
  return r;
}
