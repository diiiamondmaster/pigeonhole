// Client state: the last snapshot from the main process, the active workspace,
// and a tiny event bus used to decouple modules (tabs, sidebar, toolbar,
// wizard, vault all talk through it).
let snapshot = null;
let activeWsId = null;

export const bus = {
  _m: new Map(),
  on(type, fn) { (this._m.get(type) || this._m.set(type, []).get(type)).push(fn); return () => this.off(type, fn); },
  off(type, fn) { const a = this._m.get(type); if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
  emit(type, data) { (this._m.get(type) || []).forEach(f => { try { f(data); } catch (e) { console.error('[bus]', type, e); } }); }
};

export const PH = () => window.pigeonhole;

export async function refresh() {
  snapshot = await PH().state();
  if (!activeWsId || !workspaces().some(w => w.id === activeWsId)) {
    activeWsId = snapshot.ui.activeWsId && workspaces().some(w => w.id === snapshot.ui.activeWsId)
      ? snapshot.ui.activeWsId
      : (workspaces()[0]?.id || null);
  }
  return snapshot;
}

export const snap = () => snapshot;
export const workspaces = () => snapshot?.workspaces || [];
export const ws = (id) => workspaces().find(w => w.id === id) || null;
export const wsByNum = (n) => workspaces().find(w => w.num === n) || null;
export const settings = () => snapshot?.settings || {};
export const historyFor = (id) => (snapshot?.history?.[id] || []);
export const tabsFor = (id) => snapshot?.tabs?.[id] || [];
export const getActiveWsId = () => activeWsId;
export const setActiveWsId = (id) => { activeWsId = id; };
export const activeWs = () => ws(activeWsId);
