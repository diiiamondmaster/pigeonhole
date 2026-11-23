// Consistent inline SVG icon set - 24x24 grid, 1.8 stroke, round caps.
// Every icon in the chrome comes from here so the visual language stays uniform.

const PATHS = {
  back: '<polyline points="14 5 7 12 14 19"/>',
  forward: '<polyline points="10 5 17 12 10 19"/>',
  reload: '<polyline points="22 4 22 10 16 10"/><path d="M20.4 14.5a8.5 8.5 0 1 1-2-8.9L22 9"/>',
  home: '<path d="M3 9.5 12 3l9 6.5V20a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 20z"/><polyline points="9 21.5 9 13.5 15 13.5 15 21.5"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  close: '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="16.2" y1="16.2" x2="21" y2="21"/>',
  globe: '<circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>',
  warn: '<path d="M12 3.5 2.5 20h19z"/><line x1="12" y1="9.5" x2="12" y2="14"/><line x1="12" y1="16.8" x2="12" y2="17.2"/>',
  key: '<circle cx="8" cy="15.5" r="4.2"/><path d="M11.2 12.3 20 3.5"/><path d="M16.6 6.9l2.6 2.6"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M19.1 14.7a1.6 1.6 0 0 0 .33 1.77l.06.06a1.9 1.9 0 1 1-2.7 2.7l-.06-.06a1.6 1.6 0 0 0-1.77-.33 1.6 1.6 0 0 0-.98 1.47v.18a1.9 1.9 0 0 1-3.8 0v-.09a1.6 1.6 0 0 0-1.05-1.47 1.6 1.6 0 0 0-1.77.33l-.06.06a1.9 1.9 0 1 1-2.7-2.7l.06-.06a1.6 1.6 0 0 0 .33-1.77 1.6 1.6 0 0 0-1.47-.98H3.9a1.9 1.9 0 0 1 0-3.8h.09a1.6 1.6 0 0 0 1.47-1.05 1.6 1.6 0 0 0-.33-1.77l-.06-.06a1.9 1.9 0 1 1 2.7-2.7l.06.06a1.6 1.6 0 0 0 1.77.33h.08a1.6 1.6 0 0 0 .98-1.47V3.9a1.9 1.9 0 0 1 3.8 0v.09a1.6 1.6 0 0 0 .98 1.47 1.6 1.6 0 0 0 1.77-.33l.06-.06a1.9 1.9 0 1 1 2.7 2.7l-.06.06a1.6 1.6 0 0 0-.33 1.77v.08a1.6 1.6 0 0 0 1.47.98h.18a1.9 1.9 0 0 1 0 3.8h-.09a1.6 1.6 0 0 0-1.47.98z"/>',
  wand: '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/><path d="M18.5 14.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3.5 7.5 12 13l8.5-5.5"/>',
  check: '<polyline points="20 6 9.5 16.5 4 11"/>',
  chevL: '<polyline points="14.5 6 8.5 12 14.5 18"/>',
  chevR: '<polyline points="9.5 6 15.5 12 9.5 18"/>',
  chevD: '<polyline points="6.5 9.5 12 15 17.5 9.5"/>',
  panel: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><line x1="9.5" y1="4.5" x2="9.5" y2="19.5"/>',
  eye: '<path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  eyeOff: '<path d="M4 4l16 16"/><path d="M10.6 6.1A9 9 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-2.4 3M6.7 6.9A16 16 0 0 0 2.5 12S6 18 12 18a8.7 8.7 0 0 0 4-.9"/><path d="M9.9 9.9a2.8 2.8 0 0 0 4 4"/>',
  copy: '<rect x="9" y="9" width="11.5" height="11.5" rx="2"/><path d="M5.5 15H4.5a1.5 1.5 0 0 1-1.5-1.5V4.5A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5v1"/>',
  trash: '<polyline points="3.5 6.5 5.5 6.5 20.5 6.5"/><path d="M18.5 6.5V19a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V6.5m3 0V4.5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v2"/>',
  download: '<path d="M21 15.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3.5"/><polyline points="7 10.5 12 15.5 17 10.5"/><line x1="12" y1="15.5" x2="12" y2="3.5"/>',
  external: '<path d="M18 13.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5.5"/><polyline points="14.5 3 21 3 21 9.5"/><line x1="10" y1="14" x2="21" y2="3"/>',
  info: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="12" y1="7.8" x2="12" y2="8.2"/>',
  user: '<path d="M20 21v-1.8a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4V21"/><circle cx="12" cy="7.2" r="4"/>',
  shield: '<path d="M12 21.5s7.5-3.3 7.5-9.4V5.3L12 2.5l-7.5 2.8v6.8c0 6.1 7.5 9.4 7.5 9.4z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><circle cx="9" cy="9" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="9" r="1.1" fill="currentColor" stroke="none"/><circle cx="9" cy="15" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="15" r="1.1" fill="currentColor" stroke="none"/>',
  arrowR: '<line x1="4" y1="12" x2="19" y2="12"/><polyline points="13 6 19 12 13 18"/>',
  inbox: '<polyline points="22 12.5 16.5 12.5 14.5 15.5 9.5 15.5 7.5 12.5 2 12.5"/><path d="M5.3 5.6 2 12.5V19a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6.5L18.7 5.6A2 2 0 0 0 16.9 4.5H7.1a2 2 0 0 0-1.8 1.1z"/>',
  docs: '<path d="M4 19.2A2.5 2.5 0 0 1 6.5 16.7H20"/><path d="M6.5 2.3H20v19.4H6.5A2.5 2.5 0 0 1 4 19.2V4.8a2.5 2.5 0 0 1 2.5-2.5z"/>',
  logo: '<rect x="3.5" y="3.5" width="7.5" height="7.5" rx="2"/><rect x="13" y="3.5" width="7.5" height="7.5" rx="2"/><rect x="3.5" y="13" width="7.5" height="7.5" rx="2"/><rect x="13" y="13" width="7.5" height="7.5" rx="2" fill="currentColor" stroke="none"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 1 2.5 6"/><polyline points="3.5 12 3.5 12"/><polyline points="3 17.5 3.5 12 9 12.5"/>',
  puzzle: '<path d="M10 3.5a1.8 1.8 0 0 1 3.6 0V5h3.4a1 1 0 0 1 1 1v3.4h1.5a1.8 1.8 0 0 1 0 3.6H18v4.5a1 1 0 0 1-1 1h-4v-1.7a1.8 1.8 0 0 0-3.6 0v1.7H5.5a1 1 0 0 1-1-1V14h1.2a1.8 1.8 0 0 0 0-3.6H4.5V6a1 1 0 0 1 1-1H10z"/>'
};

export function icon(name, size = 18) {
  const p = PATHS[name] || PATHS.info;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}
