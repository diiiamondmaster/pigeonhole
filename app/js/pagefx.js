// Page tools (beta.7): reader view and picture-in-picture, executed inside
// the page being viewed (the active tab). Both are inject-and-run: the
// chrome never sees page content, only the page itself rearranges.
import * as Tabs from './tabs.js';
import * as S from './state.js';
import { toast } from './toasts.js';

const wv = () => Tabs.webviewOf(S.getActiveWsId());

// ---- reader view ----
// A compact extraction heuristic (the classic readability shape, ~1k chars):
// score candidate containers by paragraph density / text length, clone the
// winner's content into a paper-toned overlay with a comfortable measure.
// Idempotent: running it again removes the overlay.
const READER_JS = `(() => {
  const ID = '__phReader';
  const existing = document.getElementById(ID);
  if (existing) { existing.remove(); return 'off'; }
  const cand = [...document.querySelectorAll('article, main, div, section, td')]
    .map(el => {
      const ps = el.querySelectorAll('p');
      let text = 0;
      for (const p of ps) text += (p.textContent || '').trim().length;
      return { el, text, pcount: ps.length };
    })
    .filter(c => c.text > 400 && c.pcount >= 2)
    .sort((a, b) => b.text / (b.el.textContent.length + 1) - a.text / (a.el.textContent.length + 1));
  if (!cand.length) return 'no-article';
  const src = cand[0].el;
  const title = (document.querySelector('h1')?.textContent || document.title || '').trim();
  const box = document.createElement('div');
  box.id = ID;
  box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;overflow:auto;background:#f6f1e7;color:#26221a;';
  const inner = document.createElement('div');
  inner.style.cssText = 'max-width:42em;margin:0 auto;padding:48px 24px 120px;font:17px/1.75 Georgia,"Times New Roman",serif;';
  const h1 = document.createElement('h1');
  h1.textContent = title;
  h1.style.cssText = 'font:700 28px/1.25 system-ui,sans-serif;margin:0 0 8px;color:#191512;';
  const src_ = document.createElement('div');
  src_.textContent = location.hostname;
  src_.style.cssText = 'font:13px system-ui,sans-serif;color:#8a7d63;margin:0 0 32px;';
  const content = document.createElement('div');
  content.innerHTML = src.innerHTML;
  // strip the loud bits: scripts, styles, iframes, ads, forms, nav
  for (const bad of content.querySelectorAll('script,style,iframe,form,nav,aside,button,video,audio,svg')) bad.remove();
  for (const el of content.querySelectorAll('*')) {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || el.offsetWidth === 0) el.remove();
  }
  content.querySelectorAll('a').forEach(a => { a.style.color = '#8a5a19'; });
  const close = document.createElement('button');
  close.textContent = '\\u00d7  close reader';
  close.style.cssText = 'position:fixed;top:12px;right:16px;z-index:2147483648;background:#26221a;color:#f6f1e7;border:none;border-radius:99px;padding:8px 16px;font:600 13px system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25);';
  close.onclick = () => box.remove();
  inner.append(h1, src_, content);
  box.append(inner, close);
  document.body.append(box);
  window.scrollTo(0, 0);
  return 'on';
})()`;

export async function readerToggle() {
  const view = wv();
  if (!view) { toast({ title: 'No page to read', type: 'info', ic: 'info' }); return; }
  try {
    const r = await view.executeJavaScript(READER_JS, true);
    if (r === 'no-article') toast({ title: 'No article found', sub: 'This page has no readable text block.', type: 'info', ic: 'info', timeout: 3200 });
  } catch (e) {
    toast({ title: 'Reader view failed', sub: String(e.message || e).slice(0, 80), type: 'error', ic: 'warn' });
  }
}

// ---- picture-in-picture ----
// Finds the most plausible video (playing first, then largest) and pops it
// into Chromium's native always-on-top PiP window - which stays up while
// you switch workspaces, exactly the point.
const PIP_JS = `(() => {
  const vids = [...document.querySelectorAll('video')].filter(v => v.readyState > 0 && !v.disablePictureInPicture);
  if (!vids.length) return 'no-video';
  const pick = vids.find(v => !v.paused && !v.ended) || vids.sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight))[0];
  return pick.requestPictureInPicture().then(() => 'on').catch(e => 'fail:' + (e.message || e).slice(0, 60));
})()`;

export async function pipToggle() {
  const view = wv();
  if (!view) { toast({ title: 'No page playing', type: 'info', ic: 'info' }); return; }
  try {
    const r = await view.executeJavaScript(PIP_JS, true);
    if (r === 'no-video') toast({ title: 'No video on this page', sub: 'Start a video first, then pop it out.', type: 'info', ic: 'info', timeout: 3200 });
    else if (String(r).startsWith('fail:')) toast({ title: 'This site blocks picture-in-picture', sub: String(r).slice(5, 80), type: 'error', ic: 'warn' });
    else if (r === 'on') toast({ title: 'Video popped out', sub: 'The mini player stays on top while you switch workspaces.', type: 'success', ic: 'check', timeout: 3600 });
  } catch (e) {
    toast({ title: 'Picture-in-picture failed', sub: String(e.message || e).slice(0, 80), type: 'error', ic: 'warn' });
  }
}
