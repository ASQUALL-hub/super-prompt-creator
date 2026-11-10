// Inline SVG icons (24×24, stroke-based).
const P = {
  spark: '<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z"/><path d="M19 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  wand: '<path d="M4 20L15 9"/><path d="M13.5 7.5l3 3"/><path d="M18 3v3M16.5 4.5h3M20 9v2M19 10h2M10 3v2M9 4h2"/>',
  library: '<path d="M4.5 4.5h4v15h-4z"/><path d="M10.5 4.5h4v15h-4z"/><path d="M15.6 5.6l3.7-1 3.2 14.4-3.7 1z" transform="translate(-1.5 0)"/>',
  chat: '<path d="M20.5 12a8.5 8.5 0 0 1-12.3 7.6L4 20.5l1-4.1A8.5 8.5 0 1 1 20.5 12z"/><path d="M12 8.2l.9 2.2 2.2.9-2.2.9-.9 2.2-.9-2.2-2.2-.9 2.2-.9z"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  copy: '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.2"/><path d="M15.5 8.5V6.2A2.2 2.2 0 0 0 13.3 4H6.2A2.2 2.2 0 0 0 4 6.2v7.1a2.2 2.2 0 0 0 2.2 2.2h2.3"/>',
  send: '<path d="M21 3L10.5 13.5"/><path d="M21 3l-6.5 18-4-7.5L3 9.5z"/>',
  play: '<path d="M7 4.5l12 7.5-12 7.5z"/>',
  edit: '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M14.5 7.5l3 3"/>',
  download: '<path d="M12 4v11"/><path d="M7 10.5l5 5 5-5"/><path d="M5 20h14"/>',
  star: '<path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>',
  trash: '<path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l1 13h9l1-13"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4.5v5h-5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  key: '<circle cx="8" cy="15" r="4.2"/><path d="M11 12l8.5-8.5"/><path d="M16.5 6l2.5 2.5"/><path d="M14.5 8l2 2"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v4.8a1.2 1.2 0 0 1-1.2 1.2H5.2A1.2 1.2 0 0 1 4 18.8V7.2A1.2 1.2 0 0 1 5.2 6H10"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><circle cx="9" cy="10" r="1.8"/><path d="M20.5 16l-5-5-9.5 8.5"/>',
  video: '<rect x="3.5" y="6" width="12.5" height="12" rx="2.2"/><path d="M16 10.2l4.5-2.7v9l-4.5-2.7z"/>',
  doc: '<path d="M6.5 3.5h8l4 4v13h-12z"/><path d="M14 3.5V8h4.5"/><path d="M9.5 12.5h6M9.5 16h4"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.2"/>',
  folder: '<path d="M3.5 7.2A1.7 1.7 0 0 1 5.2 5.5H9l2 2h7.8a1.7 1.7 0 0 1 1.7 1.7v8.6a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7z"/>',
  logout: '<path d="M14.5 4.5h4a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-4"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h10"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.3a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.6"/><path d="M12 16.8v.1"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4.5"/><path d="M12 17.5v.1"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.3 2.3 3.4 5.2 3.4 8.5s-1.1 6.2-3.4 8.5c-2.3-2.3-3.4-5.2-3.4-8.5S9.7 5.8 12 3.5z"/>',
  feather: '<path d="M19.5 4.5c-4.5 0-11 3-11 11v4"/><path d="M8.5 15.5h6.5c3-2 4.5-5.5 4.5-11"/><path d="M8.5 11.5h8"/>',
  bubble: '<path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5z"/>',
  book: '<path d="M4.5 5.5c2.8-1.2 5.3-1 7.5.8v13c-2.2-1.8-4.7-2-7.5-.8z"/><path d="M19.5 5.5c-2.8-1.2-5.3-1-7.5.8v13c2.2-1.8 4.7-2 7.5-.8z"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M4 7l8 6 8-6"/>',
  code: '<path d="M8.5 7.5L4 12l4.5 4.5"/><path d="M15.5 7.5L20 12l-4.5 4.5"/><path d="M13.3 5l-2.6 14"/>',
  bot: '<rect x="4.5" y="8" width="15" height="11" rx="3"/><path d="M12 4.5V8"/><circle cx="12" cy="4" r="1"/><path d="M9 13v1.2M15 13v1.2"/><path d="M2.5 12.5v3M21.5 12.5v3"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  arrow: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3.1-3.1a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3.1 3.1a4 4 0 0 0 5.7 5.7l1-1"/>',
  user: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5"/>',
};

export function icon(name, cls = '') {
  const body = P[name] || P.spark;
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

let logoSeq = 0;
/** The app logo; each copy gets its own gradient id so hidden copies never break visible ones. */
export function logo() {
  const id = `spc-lg-${++logoSeq}`;
  return `<svg class="logo" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff963c"/><stop offset=".5" stop-color="#ff4d8d"/><stop offset="1" stop-color="#7c5cff"/></linearGradient></defs><rect x="2" y="2" width="60" height="60" rx="15" fill="url(#${id})"/><path d="M17 21.5l11.5 10.5L17 42.5" fill="none" stroke="#fff" stroke-width="5.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M34.5 42.5h12.5" stroke="#fff" stroke-width="5.6" stroke-linecap="round"/><path d="M46.4 11l2.1 5.3 5.3 2.1-5.3 2.1-2.1 5.3-2.1-5.3-5.3-2.1 5.3-2.1z" fill="#fff"/></svg>`;
}
