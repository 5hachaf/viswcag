/*
 * VisWCAG in-page audit engine.
 *
 * This file is injected into the rendered page (after CSS and JavaScript have run)
 * and evaluates the live DOM — including open shadow roots and same-origin iframes —
 * against WCAG 2.2 checks. It is plain browser JavaScript with no dependencies, so it
 * can also be pasted into DevTools or used as a browser-extension content script.
 *
 * It leaves the page as it found it, with these temporary exceptions:
 *   - focusCheck() moves keyboard focus through controls and lets the page scroll
 *     (2.4.7 Focus Visible, 2.4.11 Focus Not Obscured), pausing CSS transitions
 *     while it does; focus and scroll position are restored afterwards;
 *   - scan() sends a synthetic paste event to password and one-time-code fields
 *     (3.3.8 Accessible Authentication) and restores their value if a script changed it.
 *
 * Exposes: window.__viswcag.scan()       → { results, meta }
 *          window.__viswcag.focusCheck() → { results }
 * Each result: { rule, message, selector, snippet, rect:{x,y,w,h}|null, order, extra }
 */
(function () {
  'use strict';
  if (window.__viswcag) return;

  const topWin = window;
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const lc = (s) => norm(s).toLowerCase();

  /* ───────────────────────── DOM traversal ───────────────────────── */

  const frameOffsets = new Map(); // Document -> {x, y} offset in the top document
  const orderOf = new WeakMap(); // Element -> document order index

  function collectElements() {
    const out = [];
    const roots = [];
    (function walk(root, offset) {
      roots.push(root);
      const doc = root.ownerDocument || root;
      if (!frameOffsets.has(doc)) frameOffsets.set(doc, offset);
      for (const el of root.querySelectorAll('*')) {
        orderOf.set(el, out.length);
        out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot, offset);
        if (el.localName === 'iframe' || el.localName === 'frame') {
          let inner = null;
          try { inner = el.contentDocument; } catch (e) { inner = null; } // cross-origin
          if (inner && inner.documentElement) {
            const r = el.getBoundingClientRect();
            const s = cs(el);
            walk(inner, {
              x: offset.x + r.left + px(s.borderLeftWidth) + px(s.paddingLeft),
              y: offset.y + r.top + px(s.borderTopWidth) + px(s.paddingTop),
            });
          }
        }
      }
    })(document, { x: 0, y: 0 });
    return { elements: out, roots };
  }

  function cs(el) { return el.ownerDocument.defaultView.getComputedStyle(el); }
  function px(v) { return parseFloat(v) || 0; }

  function parentOf(el) {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode && el.getRootNode();
    if (root && root.host) return root.host;
    const win = el.ownerDocument && el.ownerDocument.defaultView;
    try { if (win && win.frameElement) return win.frameElement; } catch (e) { /* ignore */ }
    return null;
  }

  function byId(el, id) {
    if (!id) return null;
    const root = el.getRootNode();
    let found = null;
    if (root && typeof root.getElementById === 'function') found = root.getElementById(id);
    return found || el.ownerDocument.getElementById(id);
  }

  function isVisible(el) {
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return false;
    } else {
      const s = cs(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  function isAriaHidden(el) {
    for (let n = el; n; n = parentOf(n)) {
      if (n.nodeType === 1 && n.getAttribute('aria-hidden') === 'true') return true;
      if (n.nodeType === 1 && n.hasAttribute('inert')) return true;
    }
    return false;
  }

  const exposed = (el) => isVisible(el) && !isAriaHidden(el);

  function rectOf(el) {
    const r = el.getBoundingClientRect();
    const o = frameOffsets.get(el.ownerDocument) || { x: 0, y: 0 };
    return {
      x: Math.round(r.left + o.x + topWin.scrollX),
      y: Math.round(r.top + o.y + topWin.scrollY),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  }

  /* ───────────────────────── Reporting ───────────────────────── */

  function selectorWithin(el) {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && parts.length < 6) {
      let p = n.localName;
      const root = n.getRootNode();
      if (n.id && /^[A-Za-z][\w-]*$/.test(n.id)) {
        let unique = false;
        try { unique = root.querySelectorAll('#' + CSS.escape(n.id)).length === 1; } catch (e) { /* ignore */ }
        if (unique) { parts.unshift(p + '#' + n.id); return parts.join(' > '); }
      }
      const parent = n.parentElement;
      if (parent) {
        const same = Array.prototype.filter.call(parent.children, (c) => c.localName === n.localName);
        if (same.length > 1) p += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
      }
      parts.unshift(p);
      n = parent;
    }
    return parts.join(' > ');
  }

  function selectorOf(el) {
    let sel = selectorWithin(el);
    const root = el.getRootNode();
    if (root && root.host) sel = selectorOf(root.host) + ' ›shadow› ' + sel;
    else {
      try {
        const fe = el.ownerDocument.defaultView.frameElement;
        if (fe && el.ownerDocument !== document) sel = selectorOf(fe) + ' ›frame› ' + sel;
      } catch (e) { /* ignore */ }
    }
    return sel;
  }

  const VOID = new Set(['img', 'input', 'br', 'hr', 'meta', 'link', 'area', 'source', 'track', 'embed', 'col', 'wbr', 'base', 'param']);
  function snippetOf(el) {
    let open = el.cloneNode(false).outerHTML;
    const close = '</' + el.localName + '>';
    if (open.endsWith(close)) open = open.slice(0, -close.length);
    open = open.replace(/="([^"]{70})[^"]*"/g, '="$1…"');
    if (open.length > 260) open = open.slice(0, 257) + '…>';
    if (VOID.has(el.localName)) return open;
    let txt = norm(el.textContent);
    if (txt.length > 70) txt = txt.slice(0, 67) + '…';
    return open + txt + close;
  }

  let results = [];
  function report(rule, el, message, extra) {
    const rec = { rule, message: message || null, selector: null, snippet: null, rect: null, order: -1, extra: extra || null };
    if (el) {
      rec.selector = selectorOf(el);
      rec.snippet = snippetOf(el);
      rec.order = orderOf.has(el) ? orderOf.get(el) : -1;
      if (el.localName === 'area') rec.rect = areaRect(el);
      else if (isVisible(el)) rec.rect = rectOf(el);
    }
    results.push(rec);
  }

  /* ───────────────────────── Roles & names ───────────────────────── */

  const VALID_ROLES = new Set(('alert alertdialog application article banner blockquote button caption cell checkbox code columnheader ' +
    'combobox comment complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic ' +
    'grid gridcell group heading image img insertion link list listbox listitem log main mark marquee math menu menubar menuitem ' +
    'menuitemcheckbox menuitemradio meter navigation none note option paragraph presentation progressbar radio radiogroup region ' +
    'row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript suggestion superscript ' +
    'switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem').split(' '));
  const isValidRole = (r) => VALID_ROLES.has(r) || /^doc-[a-z]+$/.test(r) || /^graphics-(document|object|symbol)$/.test(r);

  function explicitRole(el) {
    const raw = lc(el.getAttribute('role'));
    if (!raw) return null;
    for (const t of raw.split(' ')) if (isValidRole(t)) return t;
    return null;
  }

  function implicitRole(el) {
    const ln = el.localName;
    const type = lc(el.getAttribute('type'));
    switch (ln) {
      case 'a': case 'area': return el.hasAttribute('href') ? 'link' : null;
      case 'button': return 'button';
      case 'input':
        if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        if (type === 'search') return 'searchbox';
        if (type === 'hidden') return null;
        return 'textbox';
      case 'select': return (el.multiple || el.size > 1) ? 'listbox' : 'combobox';
      case 'textarea': return 'textbox';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      case 'img': return el.getAttribute('alt') === '' ? 'presentation' : 'img';
      case 'nav': return 'navigation';
      case 'main': return 'main';
      case 'aside': return 'complementary';
      case 'ul': case 'ol': case 'menu': return 'list';
      case 'li': return 'listitem';
      case 'table': return 'table';
      case 'summary': return 'button';
      case 'dialog': return 'dialog';
      case 'progress': return 'progressbar';
      case 'meter': return 'meter';
      case 'option': return 'option';
      case 'hr': return 'separator';
      case 'fieldset': case 'details': return 'group';
      default: return null;
    }
  }

  const roleOf = (el) => explicitRole(el) || implicitRole(el);

  const NAME_FROM_CONTENT = new Set(['button', 'cell', 'checkbox', 'columnheader', 'gridcell', 'heading', 'link', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'row', 'rowheader', 'switch', 'tab', 'tooltip', 'treeitem', 'term']);

  function hiddenForName(el) {
    const s = cs(el);
    return s.display === 'none' || s.visibility === 'hidden' || el.getAttribute('aria-hidden') === 'true';
  }

  function textAlt(node, ctx) {
    if (node.nodeType === 3) return node.nodeValue;
    if (node.nodeType !== 1) return '';
    const el = node;
    if (ctx.visited.has(el)) return '';
    ctx.visited.add(el);
    const ln = el.localName;
    if (ln === 'script' || ln === 'style' || ln === 'noscript' || ln === 'template') return '';
    if (!ctx.includeHidden && el !== ctx.root && hiddenForName(el)) return '';
    if (el !== ctx.root) {
      const lb = el.getAttribute('aria-labelledby');
      if (lb) {
        const t = norm(lb.split(/\s+/).map((id) => { const r = byId(el, id); return r ? textAlt(r, { visited: ctx.visited, includeHidden: true, root: r }) : ''; }).join(' '));
        if (t) return ' ' + t + ' ';
      }
      const al = el.getAttribute('aria-label');
      if (al && norm(al)) return ' ' + norm(al) + ' ';
    }
    if (ln === 'img' || ln === 'area') return ' ' + (el.getAttribute('alt') || (el.hasAttribute('alt') ? '' : el.getAttribute('title') || '')) + ' ';
    if (ln === 'input') {
      const t = lc(el.getAttribute('type'));
      if (t === 'image') return ' ' + (el.getAttribute('alt') || '') + ' ';
      if (t === 'hidden') return '';
      return ' ' + (el.value || '') + ' ';
    }
    if (ln === 'select') { const o = el.selectedOptions && el.selectedOptions[0]; return ' ' + (o ? o.textContent : '') + ' '; }
    if (ln === 'textarea') return ' ' + el.value + ' ';
    if (ln === 'svg') {
      const t = el.querySelector('title');
      if (t && norm(t.textContent)) return ' ' + t.textContent + ' ';
    }
    let kids;
    if (el.shadowRoot) kids = el.shadowRoot.childNodes;
    else if (ln === 'slot') { const a = el.assignedNodes({ flatten: true }); kids = a.length ? a : el.childNodes; }
    else kids = el.childNodes;
    let s = '';
    for (const k of kids) s += textAlt(k, ctx);
    const d = cs(el).display;
    if (d && d !== 'inline' && d !== 'contents') s = ' ' + s + ' ';
    if (!norm(s) && el !== ctx.root && el.getAttribute('title')) s = ' ' + el.getAttribute('title') + ' ';
    return s;
  }

  function visibleText(el) {
    return norm(textAlt(el, { visited: new Set(), includeHidden: false, root: el }));
  }

  function accName(el) {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = norm(lb.split(/\s+/).map((id) => {
        const r = byId(el, id);
        return r ? textAlt(r, { visited: new Set(r === el ? [] : [el]), includeHidden: true, root: r }) : '';
      }).join(' '));
      if (t) return { name: t, source: 'aria-labelledby' };
    }
    const al = el.getAttribute('aria-label');
    if (al && norm(al)) return { name: norm(al), source: 'aria-label' };

    const ln = el.localName;
    const type = lc(el.getAttribute('type'));
    if (ln === 'img' || ln === 'area' || (ln === 'input' && type === 'image')) {
      if (el.hasAttribute('alt')) {
        const a = norm(el.getAttribute('alt'));
        if (a) return { name: a, source: 'alt' };
        if (ln !== 'input') return { name: '', source: 'alt-empty' };
      }
    }
    if (ln === 'input' && ['submit', 'reset', 'button'].includes(type)) {
      const v = el.getAttribute('value');
      if (v !== null && norm(v)) return { name: norm(v), source: 'value' };
      if (v === null && type !== 'button') return { name: type === 'submit' ? 'Submit' : 'Reset', source: 'default' };
    } else if (['input', 'select', 'textarea', 'meter', 'progress', 'output', 'button'].includes(ln)) {
      const labels = el.labels ? Array.from(el.labels) : [];
      const t = norm(labels.map((l) => textAlt(l, { visited: new Set([el]), includeHidden: true, root: l })).join(' '));
      if (t) return { name: t, source: 'label' };
    }
    if (ln === 'fieldset') { const lg = el.querySelector(':scope > legend'); if (lg && norm(lg.textContent)) return { name: norm(lg.textContent), source: 'legend' }; }
    if (ln === 'svg') { const t = el.querySelector(':scope > title'); if (t && norm(t.textContent)) return { name: norm(t.textContent), source: 'svg-title' }; }

    const role = roleOf(el);
    if (NAME_FROM_CONTENT.has(role) || /^(a|button|summary|h[1-6]|th|td|label|legend|caption)$/.test(ln)) {
      const t = visibleText(el);
      if (t) return { name: t, source: 'contents' };
    }
    const title = el.getAttribute('title');
    if (title && norm(title)) return { name: norm(title), source: 'title' };
    const ph = el.getAttribute('placeholder');
    if (ph && norm(ph) && (ln === 'input' || ln === 'textarea')) return { name: norm(ph), source: 'placeholder' };
    return { name: '', source: 'none' };
  }

  function isTabbable(el) {
    if (el.disabled) return false;
    const ti = el.getAttribute('tabindex');
    if (ti !== null && ti.trim() !== '' && !isNaN(parseInt(ti, 10))) return parseInt(ti, 10) >= 0;
    const ln = el.localName;
    if ((ln === 'a' || ln === 'area') && el.hasAttribute('href')) return true;
    if (ln === 'button' || ln === 'select' || ln === 'textarea' || ln === 'iframe') return true;
    if (ln === 'input') return lc(el.getAttribute('type')) !== 'hidden';
    if (ln === 'summary') return !!el.parentElement && el.parentElement.localName === 'details';
    if ((ln === 'audio' || ln === 'video') && el.hasAttribute('controls')) return true;
    return el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable);
  }

  function areaRect(area) {
    const map = area.closest('map');
    if (!map || !map.name) return null;
    const img = (area.getRootNode().querySelector || document.querySelector).call(area.getRootNode(), 'img[usemap="#' + CSS.escape(map.name) + '"]');
    if (!img || !isVisible(img)) return null;
    const base = rectOf(img);
    const c = (area.getAttribute('coords') || '').split(',').map((v) => parseFloat(v));
    const shape = lc(area.getAttribute('shape')) || 'rect';
    if (c.some(isNaN) || !c.length) return base;
    if (shape.startsWith('circ') && c.length >= 3) return { x: Math.round(base.x + c[0] - c[2]), y: Math.round(base.y + c[1] - c[2]), w: Math.round(c[2] * 2), h: Math.round(c[2] * 2) };
    if (shape.startsWith('poly') && c.length >= 4) {
      const xs = c.filter((_, i) => i % 2 === 0), ys = c.filter((_, i) => i % 2 === 1);
      const x0 = Math.min(...xs), y0 = Math.min(...ys);
      return { x: Math.round(base.x + x0), y: Math.round(base.y + y0), w: Math.round(Math.max(...xs) - x0), h: Math.round(Math.max(...ys) - y0) };
    }
    if (c.length >= 4) return { x: Math.round(base.x + c[0]), y: Math.round(base.y + c[1]), w: Math.round(c[2] - c[0]), h: Math.round(c[3] - c[1]) };
    return base;
  }

  /* ───────────────────────── Colour ───────────────────────── */

  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = colorCanvas.height = 1;
  const cctx = colorCanvas.getContext('2d', { willReadFrequently: true });
  const colorCache = new Map();

  function parseColor(str) {
    if (colorCache.has(str)) return colorCache.get(str);
    let c;
    const m = str.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
    if (m) {
      const a = m[4] === undefined ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
      c = [+m[1], +m[2], +m[3], a];
    } else if (str === 'transparent') {
      c = [0, 0, 0, 0];
    } else {
      // Modern colour spaces (oklch, color(), lab…) — let the canvas convert to sRGB.
      cctx.clearRect(0, 0, 1, 1);
      cctx.fillStyle = '#000';
      cctx.fillStyle = str;
      cctx.fillRect(0, 0, 1, 1);
      const d = cctx.getImageData(0, 0, 1, 1).data;
      c = [d[0], d[1], d[2], d[3] / 255];
    }
    colorCache.set(str, c);
    return c;
  }

  function blend(top, bottom) {
    const a = top[3] + bottom[3] * (1 - top[3]);
    if (a === 0) return [0, 0, 0, 0];
    const ch = (i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a;
    return [ch(0), ch(1), ch(2), a];
  }

  function luminance(c) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  }

  function contrastRatio(a, b) {
    const l1 = luminance(a), l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

  function backgroundBehind(el) {
    const layers = [];
    let opacity = 1;
    for (let n = el; n; n = parentOf(n)) {
      const s = cs(n);
      opacity *= parseFloat(s.opacity);
      if (s.backgroundImage && s.backgroundImage !== 'none') return { unknown: true, reason: 'background image or gradient' };
      const bg = parseColor(s.backgroundColor);
      if (bg[3] > 0) { layers.push(bg); if (bg[3] >= 1) break; }
    }
    let color = [255, 255, 255, 1]; // browser canvas default
    for (let i = layers.length - 1; i >= 0; i--) color = blend(layers[i], color);
    return { color, opacity };
  }

  /* ───────────────────────── Checks ───────────────────────── */

  const SUSPICIOUS_ALT = /^(image|img|picture|pic|photo|photograph|graphic|icon|spacer|placeholder|blank|untitled|logo image|banner|alt|null|undefined|\*|-|_)$/i;
  const FILENAME_ALT = /\.(png|jpe?g|gif|svg|webp|avif|bmp|tiff?)$/i;
  const REDUNDANT_PREFIX = /^(an? )?(image|picture|photo|graphic|photograph) (of|showing)\b/i;
  const SUSPICIOUS_LINK = /^(click|click here|here|more|read more|learn more|more info|more information|continue|details|link|this|this link|go|start|info|see more|view more|find out more|tap here)[.!…:]*$/i;

  const AUTOCOMPLETE_FIELDS = new Set(('name honorific-prefix given-name additional-name family-name honorific-suffix nickname username ' +
    'new-password current-password one-time-code organization-title organization street-address address-line1 address-line2 ' +
    'address-line3 address-level4 address-level3 address-level2 address-level1 country country-name postal-code cc-name ' +
    'cc-given-name cc-additional-name cc-family-name cc-number cc-exp cc-exp-month cc-exp-year cc-csc cc-type ' +
    'transaction-currency transaction-amount language bday bday-day bday-month bday-year sex url photo tel tel-country-code ' +
    'tel-national tel-area-code tel-local tel-local-prefix tel-local-suffix tel-extension email impp').split(' '));
  const AUTOCOMPLETE_CONTACT = new Set(['tel', 'tel-country-code', 'tel-national', 'tel-area-code', 'tel-local', 'tel-local-prefix', 'tel-local-suffix', 'tel-extension', 'email', 'impp']);

  function autocompleteValid(value) {
    const tokens = lc(value).split(' ').filter(Boolean);
    if (!tokens.length) return true;
    if (tokens.length === 1 && (tokens[0] === 'on' || tokens[0] === 'off')) return true;
    let i = 0;
    if (tokens[i] && tokens[i].startsWith('section-')) i++;
    if (tokens[i] === 'shipping' || tokens[i] === 'billing') i++;
    if (['home', 'work', 'mobile', 'fax', 'pager'].includes(tokens[i])) {
      i++;
      if (!AUTOCOMPLETE_CONTACT.has(tokens[i])) return false;
    }
    if (!AUTOCOMPLETE_FIELDS.has(tokens[i])) return false;
    i++;
    if (tokens[i] === 'webauthn') i++;
    return i === tokens.length;
  }

  function validLang(tag) {
    try { return Intl.getCanonicalLocales(tag).length === 1; } catch (e) { return false; }
  }

  /* ───────────── WCAG 2.2 helpers ───────────── */

  // Does a script cancel pasting into this field? Dispatches a synthetic paste event and
  // checks whether it was cancelled without the script inserting the text itself.
  function pasteBlocked(el) {
    const win = el.ownerDocument.defaultView;
    let ev;
    try {
      const data = new win.DataTransfer();
      data.setData('text/plain', 'viswcag-paste-test');
      ev = new win.ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true, clipboardData: data });
    } catch (e) {
      try { ev = new win.Event('paste', { bubbles: true, cancelable: true, composed: true }); } catch (e2) { return false; }
    }
    const before = el.value;
    try { el.dispatchEvent(ev); } catch (e) { return false; }
    const handled = el.value !== before;
    if (handled) el.value = before; // a script inserted text itself: pasting works, undo it
    return ev.defaultPrevented && !handled;
  }

  const TARGET_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'slider', 'spinbutton', 'combobox', 'treeitem', 'searchbox', 'textbox']);

  function isTarget(el) {
    const ln = el.localName;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    if (ln === 'a' && el.hasAttribute('href')) return true;
    if (ln === 'button' || ln === 'select' || ln === 'textarea' || ln === 'summary') return true;
    if (ln === 'input') return lc(el.getAttribute('type')) !== 'hidden';
    const role = explicitRole(el);
    return !!role && TARGET_ROLES.has(role);
  }

  // User agent controls (unstyled checkboxes, radio buttons, ranges…) are exempt.
  function isUserAgentControl(el) {
    if (el.localName !== 'input') return false;
    const type = lc(el.getAttribute('type'));
    if (!['checkbox', 'radio', 'range', 'color', 'file', 'date', 'time', 'datetime-local', 'month', 'week'].includes(type)) return false;
    const s = cs(el);
    return (s.appearance || s.webkitAppearance) !== 'none';
  }

  // Inline exception: the target sits in a sentence, sized by the line-height of the text.
  function isInline(el) {
    const display = cs(el).display;
    if (!/^inline/.test(display) || (display === 'inline-block' && el.localName !== 'a')) return false;
    let block = parentOf(el);
    while (block && /^inline/.test(cs(block).display)) block = parentOf(block);
    if (!block) return false;
    let other = '';
    const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const host = t.parentElement && t.parentElement.closest('a[href], button, [role="link"], [role="button"], input, select, textarea, summary');
      if (!host || !block.contains(host)) other += t.nodeValue;
    }
    return norm(other).replace(/[|·•,;:()\[\]\/–—-]/g, '').trim().length >= 10;
  }

  // The part of an element that is actually shown: its box clipped by every ancestor
  // that hides overflow (scroll areas, carousels). Null when nothing is shown.
  function shownRect(el) {
    const b = el.getBoundingClientRect();
    let x0 = b.left, y0 = b.top, x1 = b.right, y1 = b.bottom;
    for (let a = el.parentElement; a && a !== el.ownerDocument.documentElement && a !== el.ownerDocument.body; a = a.parentElement) {
      const s = cs(a);
      if (s.position === 'fixed') break;
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const c = a.getBoundingClientRect();
      if (s.overflowX !== 'visible') { x0 = Math.max(x0, c.left); x1 = Math.min(x1, c.right); }
      if (s.overflowY !== 'visible') { y0 = Math.max(y0, c.top); y1 = Math.min(y1, c.bottom); }
      if (x1 - x0 < 1 || y1 - y0 < 1) return null;
    }
    const o = frameOffsets.get(el.ownerDocument) || { x: 0, y: 0 };
    return { x: x0 + o.x + topWin.scrollX, y: y0 + o.y + topWin.scrollY, w: x1 - x0, h: y1 - y0 };
  }

  function checkTargetSize(elements) {
    const MIN = 24;
    const R = MIN / 2;
    const targets = [];
    let inline = 0;
    let uaControls = 0;
    for (const el of elements) {
      if (!isTarget(el) || !exposed(el)) continue;
      // Skip targets nested in another target; the outer one is what gets clicked.
      const outer = parentOf(el) && targets.find((t) => t.el.contains(el));
      if (outer) continue;
      const r = shownRect(el);
      if (!r || r.w < 1 || r.h < 1) continue; // scrolled out of view or clipped away
      if (isUserAgentControl(el)) { uaControls++; continue; }
      if (isInline(el)) { inline++; continue; }
      targets.push({ el, r, cx: r.x + r.w / 2, cy: r.y + r.h / 2, small: r.w < MIN - 0.5 || r.h < MIN - 0.5, href: el.localName === 'a' ? el.href : null });
    }
    // Grid of 48 px cells so each target is compared only with its neighbours.
    const CELL = 48;
    const grid = new Map();
    const cellsFor = (t) => {
      const keys = [];
      for (let gx = Math.floor((t.r.x - MIN) / CELL); gx <= Math.floor((t.r.x + t.r.w + MIN) / CELL); gx++)
        for (let gy = Math.floor((t.r.y - MIN) / CELL); gy <= Math.floor((t.r.y + t.r.h + MIN) / CELL); gy++) keys.push(gx + ',' + gy);
      return keys;
    };
    targets.forEach((t, i) => { for (const k of cellsFor(t)) { if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); } });
    const circleHitsRect = (cx, cy, r) => {
      const nx = Math.max(r.x, Math.min(cx, r.x + r.w));
      const ny = Math.max(r.y, Math.min(cy, r.y + r.h));
      return (cx - nx) * (cx - nx) + (cy - ny) * (cy - ny) < R * R - 0.01;
    };
    let ok = 0;
    let spaced = 0;
    targets.forEach((a, i) => {
      if (!a.small) { ok++; return; }
      let clash = null;
      const near = new Set();
      for (const k of cellsFor(a)) for (const j of grid.get(k) || []) near.add(j);
      for (const j of near) {
        if (j === i) continue;
        const b = targets[j];
        if (a.href && b.href && a.href === b.href) continue; // same destination
        const hitsTarget = circleHitsRect(a.cx, a.cy, b.r);
        const hitsCircle = b.small && Math.hypot(a.cx - b.cx, a.cy - b.cy) < MIN - 0.01;
        if (hitsTarget || hitsCircle) { clash = b; break; }
      }
      if (!clash) { ok++; spaced++; return; }
      const n = accName(clash.el).name;
      report('target_size', a.el, 'Target is ' + Math.round(a.r.w) + ' × ' + Math.round(a.r.h) + ' px and too close to ' +
        (n ? '"' + n.slice(0, 50) + '"' : '<' + clash.el.localName + '>') + '.', { width: a.r.w, height: a.r.h });
    });
    if (ok) {
      report('target_size_ok', null, ok + ' of ' + targets.length + ' targets pass' + (spaced ? ' (' + spaced + ' smaller than 24 × 24 px but with enough space)' : '') + '.' +
        (inline ? ' ' + inline + ' links within text are exempt.' : '') + (uaControls ? ' ' + uaControls + ' unstyled browser controls are exempt.' : ''));
    }
  }

  function scan() {
    results = [];
    frameOffsets.clear();
    topWin.scrollTo(0, 0);
    const { elements, roots } = collectElements();
    const html = document.documentElement;

    /* Page-level: title, language, viewport, refresh */
    const title = norm(document.title);
    if (title) report('title_ok', null, 'Page title: "' + title + '"');
    else report('title_missing', null);

    const lang = (html.getAttribute('lang') || html.getAttribute('xml:lang') || '').trim();
    if (!lang) report('lang_missing', null, null, { snippet: snippetOf(html) });
    else if (!validLang(lang)) report('lang_invalid', null, 'lang="' + lang + '" is not a valid language tag.');
    else report('lang_ok', null, 'Page language: ' + lang);

    for (const el of elements) {
      const ln = el.localName;

      if (ln === 'meta') {
        const name = lc(el.getAttribute('name'));
        const equiv = lc(el.getAttribute('http-equiv'));
        const content = lc(el.getAttribute('content'));
        if (name === 'viewport') {
          const us = content.match(/user-scalable\s*=\s*([a-z0-9.]+)/);
          const ms = content.match(/maximum-scale\s*=\s*([0-9.]+)/);
          const blocked = (us && (us[1] === 'no' || us[1] === '0')) || (ms && parseFloat(ms[1]) < 2);
          report(blocked ? 'viewport_zoom' : 'viewport_ok', el, blocked ? 'Viewport: "' + el.getAttribute('content') + '"' : null);
        } else if (equiv === 'refresh') {
          const delay = parseFloat(content);
          if (!isNaN(delay) && delay > 0) report('meta_refresh', el, 'The page refreshes or redirects after ' + delay + ' seconds.');
        }
        continue;
      }

      if (el.hasAttribute('lang') && el !== html && el.ownerDocument === document) {
        const l = el.getAttribute('lang').trim();
        if (l && !validLang(l)) report('lang_part_invalid', el, 'lang="' + l + '" is not a valid language tag.');
      }

      if (ln === 'marquee' || ln === 'blink') report('blink_marquee', el, '<' + ln + '> element found.');
    }

    /* Duplicate ids (per document / shadow root) */
    for (const root of roots) {
      const seen = new Map();
      for (const el of root.querySelectorAll('[id]')) {
        const id = el.id;
        if (!id) continue;
        if (!seen.has(id)) seen.set(id, []);
        seen.get(id).push(el);
      }
      for (const [id, els] of seen) {
        if (els.length < 2) continue;
        // WCAG 2.2 removed 4.1.1 Parsing: a duplicate id fails only when something refers to it.
        const q = CSS.escape(id);
        let ref = null;
        try {
          ref = root.querySelector('label[for="' + q + '"], [aria-labelledby~="' + q + '"], [aria-describedby~="' + q + '"], ' +
            '[aria-controls~="' + q + '"], [aria-owns~="' + q + '"], [aria-activedescendant="' + q + '"], [aria-details~="' + q + '"], ' +
            '[aria-errormessage~="' + q + '"], [aria-flowto~="' + q + '"], [headers~="' + q + '"], [list="' + q + '"]');
        } catch (e) { ref = null; }
        const how = ref ? (ref.localName === 'label' ? '<label for>' : ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant', 'aria-details', 'aria-errormessage', 'aria-flowto', 'headers', 'list'].find((a) => ref.hasAttribute(a))) : null;
        els.slice(1).forEach((el) => report(ref ? 'id_duplicate_ref' : 'id_duplicate', el,
          'id="' + id + '" is used ' + els.length + ' times' + (ref ? ' and is referenced by ' + how + '.' : '.')));
      }
    }

    /* ARIA: hidden body, roles, required attributes, broken references */
    if (document.body && (document.body.getAttribute('aria-hidden') === 'true' || html.getAttribute('aria-hidden') === 'true')) {
      report('aria_hidden_body', document.body.getAttribute('aria-hidden') === 'true' ? document.body : html);
    }

    const REQUIRED = {
      checkbox: ['aria-checked'], radio: ['aria-checked'], switch: ['aria-checked'],
      menuitemcheckbox: ['aria-checked'], menuitemradio: ['aria-checked'],
      slider: ['aria-valuenow'], scrollbar: ['aria-controls', 'aria-valuenow'], meter: ['aria-valuenow'],
      combobox: ['aria-expanded'], heading: ['aria-level'],
    };
    const NATIVE_SATISFIES = (el, role) => {
      const ln = el.localName, type = lc(el.getAttribute('type'));
      if ((role === 'checkbox' || role === 'switch') && ln === 'input' && type === 'checkbox') return true;
      if (role === 'radio' && ln === 'input' && type === 'radio') return true;
      if (role === 'slider' && ln === 'input' && type === 'range') return true;
      if (role === 'heading' && /^h[1-6]$/.test(ln)) return true;
      if (role === 'meter' && ln === 'meter') return true;
      if (role === 'combobox' && (ln === 'select' || (ln === 'input' && el.hasAttribute('list')))) return true;
      return false;
    };

    for (const el of elements) {
      if (el.hasAttribute('role')) {
        const raw = norm(el.getAttribute('role'));
        if (raw && !explicitRole(el)) {
          report('aria_role_invalid', el, 'role="' + raw + '" is not a valid WAI-ARIA role.');
        } else if (raw) {
          const role = explicitRole(el);
          const need = (REQUIRED[role] || []).filter((a) => !el.hasAttribute(a));
          if (need.length && !NATIVE_SATISFIES(el, role) && exposed(el)) {
            report('aria_required_attr', el, 'role="' + role + '" requires ' + need.join(', ') + '.');
          }
        }
      }
      for (const attr of ['aria-labelledby', 'aria-describedby']) {
        if (!el.hasAttribute(attr)) continue;
        const ids = norm(el.getAttribute(attr)).split(' ').filter(Boolean);
        const missing = ids.filter((id) => !byId(el, id));
        if (missing.length) report('aria_ref_broken', el, attr + ' references missing id' + (missing.length > 1 ? 's: ' : ': ') + missing.join(', '));
      }
      if (el.getAttribute('aria-hidden') === 'true' && el !== document.body && el !== html) {
        const candidates = [el, ...el.querySelectorAll('*')];
        for (const c of candidates) {
          if (isTabbable(c) && isVisible(c) && !c.hasAttribute('inert')) {
            report('aria_hidden_focusable', c, 'This element is focusable but sits inside aria-hidden="true".');
          }
        }
      }
      const ti = el.getAttribute('tabindex');
      if (ti !== null && parseInt(ti, 10) > 0) report('tabindex_positive', el, 'tabindex="' + ti + '"');
    }

    /* Images */
    const inControl = (el) => el.closest('a[href], button, [role="link"], [role="button"]');
    for (const el of elements) {
      const ln = el.localName;
      if (ln === 'img') {
        if (!exposed(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 2 && r.height <= 2) continue; // tracking pixels
        const role = explicitRole(el);
        const ctrl = inControl(el);
        const ctrlHasOtherName = ctrl ? !!accName(ctrl).name : false;
        if (role === 'presentation' || role === 'none') { report('alt_decorative', el, 'Image marked role="' + role + '".'); continue; }
        if (!el.hasAttribute('alt')) {
          const n = accName(el);
          if (n.source === 'aria-label' || n.source === 'aria-labelledby') report('alt_ok', el, 'Image named by ' + n.source + ': "' + n.name + '"');
          else if (ctrl && !ctrlHasOtherName) continue; // reported on the link/button
          else if (n.source === 'title') report('alt_title_only', el, 'Only a title is provided: "' + n.name + '"');
          else {
            const src = el.getAttribute('src') || '';
            const file = /^data:/i.test(src) ? 'inline data image' : src.split('/').pop().split('?')[0].slice(0, 60);
            report('alt_missing', el, 'Image has no alt attribute' + (file ? ' (' + file + ')' : '') + '.');
          }
          continue;
        }
        const alt = norm(el.getAttribute('alt'));
        if (!alt) {
          if (ctrl && !ctrlHasOtherName) continue;
          report('alt_decorative', el, 'Image has alt="".');
          continue;
        }
        if (SUSPICIOUS_ALT.test(alt) || FILENAME_ALT.test(alt) || REDUNDANT_PREFIX.test(alt)) {
          report('alt_suspicious', el, 'alt="' + alt + '"');
        } else if (alt.length > 125) {
          report('alt_long', el, 'Alt text is ' + alt.length + ' characters long.');
        } else {
          let around = '';
          if (ctrl) around = lc(textAlt(ctrl, { visited: new Set([el]), includeHidden: false, root: ctrl }));
          const fig = el.closest('figure');
          const cap = fig && fig.querySelector('figcaption');
          if (cap) around += ' | ' + lc(cap.textContent);
          const sib = el.nextSibling;
          if (sib && sib.nodeType === 3) around += ' | ' + lc(sib.nodeValue);
          else if (sib && sib.nodeType === 1 && cs(sib).display === 'inline') around += ' | ' + lc(sib.textContent);
          if (around && around.split(' | ').some((t) => t && t === lc(alt))) report('alt_redundant', el, 'alt="' + alt + '" repeats adjacent text.');
          else report('alt_ok', el, 'alt="' + (alt.length > 90 ? alt.slice(0, 87) + '…' : alt) + '"');
        }
      } else if (ln === 'input' && lc(el.getAttribute('type')) === 'image') {
        if (!exposed(el)) continue;
        const n = accName(el);
        if (!n.name) report('alt_input_missing', el);
        else report('alt_ok', el, 'Image button: "' + n.name + '"');
      } else if (ln === 'area' && el.hasAttribute('href')) {
        if (isAriaHidden(el)) continue;
        const n = accName(el);
        if (!n.name) report('alt_area_missing', el);
        else report('alt_ok', el, 'Image map area: "' + n.name + '"');
      } else if (ln === 'svg' && explicitRole(el) === 'img') {
        if (!exposed(el)) continue;
        const n = accName(el);
        if (!n.name) report('svg_name_missing', el);
        else report('svg_ok', el, 'SVG name: "' + n.name + '"');
      } else if ((ln === 'object' || ln === 'embed') && exposed(el)) {
        report('plugin_content', el, '<' + ln + '> element.');
      }
    }

    /* Links */
    const links = elements.filter((el) => (el.localName === 'a' && el.hasAttribute('href')) || explicitRole(el) === 'link');
    let prevLink = null;
    for (const a of links) {
      if (!exposed(a)) { continue; }
      const n = accName(a);
      const visible = visibleText(a);
      const img = a.querySelector('img');
      if (!n.name) {
        if (img && (!img.hasAttribute('alt') || !norm(img.getAttribute('alt')))) {
          report('alt_link_missing', a, 'The link contains an image with ' + (img.hasAttribute('alt') ? 'empty alt text' : 'no alt attribute') + ' and no other text.');
        } else {
          report('link_empty', a, 'The link has no text' + (a.querySelector('svg, i, span[class*="icon"]') ? ' (it appears to contain only an icon).' : '.'));
        }
      } else if (SUSPICIOUS_LINK.test(n.name)) {
        report('link_suspicious', a, 'Link text: "' + n.name + '"');
      } else {
        report('link_ok', a, 'Link: "' + (n.name.length > 80 ? n.name.slice(0, 77) + '…' : n.name) + '"');
      }
      if (n.source === 'aria-label' && visible && !lc(n.name).includes(lc(visible))) {
        report('label_in_name', a, 'Visible "' + visible + '" vs accessible name "' + n.name + '"');
      }
      // Redundant adjacent links
      if (prevLink && a.href && prevLink.href === a.href && !/#$/.test(a.getAttribute('href') || '') && a.getAttribute('href') !== '#') {
        try {
          if (prevLink.getRootNode() === a.getRootNode() && prevLink.ownerDocument === a.ownerDocument && !prevLink.contains(a)) {
            const range = a.ownerDocument.createRange();
            range.setStartAfter(prevLink);
            range.setEndBefore(a);
            if (!norm(range.toString())) report('link_redundant', a, 'Same destination as the link right before it: ' + (a.getAttribute('href') || '').slice(0, 80));
          }
        } catch (e) { /* ignore */ }
      }
      prevLink = a;
      // In-page / skip links
      const href = a.getAttribute('href') || '';
      if (href.length > 1 && href[0] === '#' && /skip|jump to|go to (main )?content|main content/i.test(n.name || visible)) {
        const id = decodeURIComponentSafe(href.slice(1));
        const target = byId(a, id) || a.ownerDocument.querySelector('[name="' + CSS.escape(id) + '"]');
        report(target ? 'skip_link_ok' : 'skip_link_broken', a, target ? 'Skip link → ' + href : 'Skip link target ' + href + ' does not exist.');
      }
    }

    /* Buttons */
    for (const el of elements) {
      const ln = el.localName;
      const type = lc(el.getAttribute('type'));
      const isBtn = ln === 'button' || (ln === 'input' && ['submit', 'reset', 'button'].includes(type)) ||
        (explicitRole(el) === 'button' && ln !== 'a');
      if (!isBtn || !exposed(el)) continue;
      const n = accName(el);
      const visible = visibleText(el);
      if (!n.name) {
        const img = el.querySelector('img');
        if (img && !norm(img.getAttribute('alt'))) report('alt_link_missing', el, 'The button contains an image without alt text and no other text.');
        else report('button_empty', el);
      } else report('button_ok', el, 'Button: "' + (n.name.length > 80 ? n.name.slice(0, 77) + '…' : n.name) + '"');
      if (n.source === 'aria-label' && visible && !lc(n.name).includes(lc(visible))) {
        report('label_in_name', el, 'Visible "' + visible + '" vs accessible name "' + n.name + '"');
      }
    }

    /* Nested interactive */
    for (const el of elements) {
      if (!((el.localName === 'a' && el.hasAttribute('href')) || el.localName === 'button')) continue;
      if (!exposed(el)) continue;
      const inner = el.querySelector('a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])');
      if (inner) report('nested_interactive', el, '<' + el.localName + '> contains <' + inner.localName + '>.');
    }

    /* Form fields */
    const FIELD_ROLES = new Set(['textbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'searchbox']);
    const PERSONAL = /e-?mail|phone|mobile|\btel\b|first.?name|last.?name|full.?name|given.?name|family.?name|surname|zip|postal|post.?code|street|address|city|birthday|\bbday\b/i;
    for (const el of elements) {
      const ln = el.localName;
      const type = lc(el.getAttribute('type'));
      const native = (ln === 'input' && !['hidden', 'submit', 'reset', 'button', 'image'].includes(type)) || ln === 'select' || ln === 'textarea';
      const aria = !native && FIELD_ROLES.has(explicitRole(el)) && !['input', 'select', 'textarea', 'button', 'a'].includes(ln);
      if (!(native || aria)) continue;
      if (!exposed(el)) continue;
      const n = accName(el);
      if (!n.name) report('label_missing', el, 'Form field' + (type ? ' (type="' + type + '")' : ' <' + ln + '>') + ' has no label.');
      else if (n.source === 'title') report('label_title_only', el, 'Labelled only by title="' + n.name + '"');
      else if (n.source === 'placeholder') report('label_placeholder_only', el, 'Labelled only by placeholder="' + n.name + '"');
      else report('label_ok', el, 'Label: "' + (n.name.length > 80 ? n.name.slice(0, 77) + '…' : n.name) + '"');

      if (native && ln !== 'select' && !['checkbox', 'radio', 'file', 'range', 'color'].includes(type)) {
        if (el.hasAttribute('autocomplete')) {
          const v = el.getAttribute('autocomplete');
          if (!autocompleteValid(v)) report('autocomplete_invalid', el, 'autocomplete="' + v + '"');
          else if (!['on', 'off', ''].includes(lc(v))) report('autocomplete_ok', el, 'autocomplete="' + v + '"');
        } else if (type === 'email' || type === 'tel' || PERSONAL.test((el.name || '') + ' ' + (el.id || '') + ' ' + n.name)) {
          if (!/search|newsletter|query/i.test((el.name || '') + ' ' + (el.id || '') + ' ' + type)) report('autocomplete_missing', el, 'Field "' + (n.name || el.name || el.id) + '" has no autocomplete attribute.');
        }
      }
    }

    /* Labels */
    const LABELABLE = new Set(['input', 'select', 'textarea', 'button', 'meter', 'output', 'progress']);
    for (const el of elements) {
      if (el.localName !== 'label' || !exposed(el)) continue;
      const f = el.getAttribute('for');
      if (f !== null) {
        const t = byId(el, f);
        if (!t) { report('label_orphaned', el, 'for="' + f + '" matches no element.'); continue; }
        if (!LABELABLE.has(t.localName) || (t.localName === 'input' && lc(t.type) === 'hidden')) { report('label_orphaned', el, 'for="' + f + '" points at a <' + t.localName + '>, which cannot be labelled.'); continue; }
      }
      const ctl = el.control;
      if (ctl && !visibleText(el).replace(norm(ctl.value || ''), '').trim() && !el.querySelector('img[alt]:not([alt=""])')) {
        report('label_empty', el);
      }
    }

    /* Radio groups and fieldsets */
    const groups = new Map();
    for (const el of elements) {
      if (el.localName === 'input' && lc(el.type) === 'radio' && el.name && exposed(el)) {
        const key = (el.form ? orderOf.get(el.form) : 'doc') + '|' + el.name;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(el);
      }
      if (el.localName === 'fieldset' && exposed(el)) {
        const lg = el.querySelector(':scope > legend');
        if (!lg || !norm(lg.textContent)) {
          if (!el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby')) report('legend_missing', el);
        }
      }
    }
    for (const radios of groups.values()) {
      if (radios.length < 2) continue;
      const container = radios[0].closest('fieldset, [role="radiogroup"], [role="group"]');
      const allIn = container && radios.every((r) => container.contains(r));
      if (allIn) report('fieldset_ok', container, 'Radio group "' + radios[0].name + '" (' + radios.length + ' options).');
      else report('fieldset_missing', radios[0], 'Radio group "' + radios[0].name + '" (' + radios.length + ' options) is not grouped.');
    }

    /* Headings */
    const headings = elements.filter((el) => (/^h[1-6]$/.test(el.localName) && !explicitRole(el)) || explicitRole(el) === 'heading').filter(exposed);
    let prevLevel = 0;
    let hasH1 = false;
    for (const h of headings) {
      const level = /^h[1-6]$/.test(h.localName) && explicitRole(h) !== 'heading' ? +h.localName[1] : (parseInt(h.getAttribute('aria-level'), 10) || 2);
      const n = accName(h);
      if (!n.name) { report('heading_empty', h, 'Empty H' + level + '.'); continue; }
      if (level === 1) hasH1 = true;
      if (prevLevel && level > prevLevel + 1) report('heading_skipped', h, 'Heading level jumps from H' + prevLevel + ' to H' + level + ': "' + n.name.slice(0, 70) + '"');
      else report('heading_ok', h, 'H' + level + ': "' + (n.name.length > 80 ? n.name.slice(0, 77) + '…' : n.name) + '"', { level });
      prevLevel = level;
    }
    if (hasH1) report('h1_ok', headings.find((h) => (/^h1$/.test(h.localName) || h.getAttribute('aria-level') === '1')) || null, null);
    else report('h1_missing', null);

    for (const p of elements) {
      if (p.localName !== 'p' || !exposed(p)) continue;
      const t = norm(p.textContent);
      if (!t || t.length >= 50 || p.closest('h1,h2,h3,h4,h5,h6,[role="heading"],li,td,th,button,a,label,blockquote,figcaption,footer,nav')) continue;
      const s = cs(p);
      const size = px(s.fontSize);
      let bold = parseInt(s.fontWeight, 10) >= 600;
      if (!bold && p.children.length === 1 && /^(b|strong)$/.test(p.children[0].localName) && norm(p.children[0].textContent) === t) bold = true;
      if (size > 20 || (bold && size > 16)) report('heading_possible', p, '"' + t + '" (' + Math.round(size) + 'px' + (bold ? ', bold' : '') + ')');
    }

    /* Landmarks and bypass blocks */
    const main = elements.find((el) => (el.localName === 'main' || explicitRole(el) === 'main') && isVisible(el));
    if (main) report('landmark_main_ok', main, null);
    else report('landmark_main_missing', null);
    const landmarks = elements.filter((el) => ['main', 'navigation', 'banner', 'contentinfo', 'complementary', 'search', 'region'].includes(explicitRole(el) || implicitRole(el) || (el.localName === 'header' ? 'banner' : el.localName === 'footer' ? 'contentinfo' : null)) && isVisible(el));
    const skip = results.some((r) => r.rule === 'skip_link_ok');
    const mechanisms = [];
    if (skip) mechanisms.push('skip link');
    if (landmarks.length) mechanisms.push(landmarks.length + ' landmark' + (landmarks.length > 1 ? 's' : ''));
    if (headings.length) mechanisms.push(headings.length + ' heading' + (headings.length > 1 ? 's' : ''));
    if (mechanisms.length) report('bypass_ok', null, 'Found: ' + mechanisms.join(', ') + '.');
    else if (links.length > 1) report('bypass_missing', null);

    /* Lists */
    for (const el of elements) {
      if (el.localName === 'li' && !explicitRole(el)) {
        const p = el.parentElement;
        const pr = p ? explicitRole(p) : null;
        if (p && !['ul', 'ol', 'menu'].includes(p.localName) && pr !== 'list' && pr !== 'directory' && !(p.localName === 'slot' || p.getRootNode().host)) report('li_orphan', el, '<li> inside <' + p.localName + '>.');
      }
      if ((el.localName === 'ul' || el.localName === 'ol') && !explicitRole(el) && exposed(el)) {
        const bad = Array.prototype.filter.call(el.children, (c) => !['li', 'script', 'template'].includes(c.localName) && explicitRole(c) !== 'listitem');
        if (bad.length) report('list_invalid_child', el, 'Direct child <' + bad[0].localName + '>' + (bad.length > 1 ? ' and ' + (bad.length - 1) + ' more' : '') + ' is not an <li>.');
      }
    }

    /* Tables */
    for (const t of elements) {
      if (t.localName !== 'table' || !exposed(t)) continue;
      const role = explicitRole(t);
      if (role === 'presentation' || role === 'none') continue;
      const ths = Array.from(t.querySelectorAll('th, [role="columnheader"], [role="rowheader"]')).filter((c) => c.closest('table') === t);
      ths.forEach((th) => { if (!accName(th).name && th.localName === 'th') report('th_empty', th); });
      const rows = t.rows ? t.rows.length : 0;
      let cols = 0;
      if (t.rows) for (const r of t.rows) cols = Math.max(cols, r.cells.length);
      if (ths.length) report('table_headers_ok', t, rows + ' rows × ' + cols + ' columns, ' + ths.length + ' header cells.');
      else if (rows >= 2 && cols >= 2) report('table_no_headers', t, rows + ' rows × ' + cols + ' columns, no <th>.');
    }

    /* Frames and media */
    for (const el of elements) {
      const ln = el.localName;
      if ((ln === 'iframe' || ln === 'frame') && exposed(el)) {
        const r = el.getBoundingClientRect();
        if (r.width < 3 || r.height < 3) continue;
        const n = accName(el);
        if (n.name) report('iframe_ok', el, 'Frame title: "' + n.name + '"');
        else report('iframe_title_missing', el);
        const src = el.getAttribute('src') || '';
        if (/youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com|wistia|soundcloud|spotify|dailymotion|brightcove|jwplayer/i.test(src)) report('media_embedded', el, 'Embedded player: ' + src.slice(0, 80));
      }
      if (ln === 'video' && isVisible(el)) {
        const track = el.querySelector('track[kind="captions"], track[kind="subtitles"]');
        report(track ? 'video_captions_ok' : 'video_captions', el, null);
      }
      if (ln === 'audio' && (isVisible(el) || el.autoplay)) report('audio_transcript', el);
      if ((ln === 'video' || ln === 'audio') && el.autoplay && !el.muted) report('media_autoplay', el, '<' + ln + '> has autoplay and is not muted.');
    }

    /* Target size (2.5.8, WCAG 2.2) */
    checkTargetSize(elements);

    /* Dragging movements (2.5.7, WCAG 2.2): draggable elements and custom sliders */
    let dragCount = 0;
    for (const el of elements) {
      const draggable = el.getAttribute('draggable') === 'true';
      const customSlider = explicitRole(el) === 'slider' && !(el.localName === 'input' && lc(el.type) === 'range');
      if (!(draggable || customSlider) || !exposed(el)) continue;
      if (draggable && el.closest('[draggable="true"]') !== el) continue; // report the outermost only
      if (++dragCount > 25) break;
      const n = accName(el).name;
      report('dragging', el, (customSlider ? 'Custom slider' : 'Draggable <' + el.localName + '>') + (n ? ' "' + n.slice(0, 60) + '"' : '') + '.');
    }

    /* Accessible authentication (3.3.8, WCAG 2.2): login fields must allow paste and autofill */
    for (const el of elements) {
      if (el.localName !== 'input' || !exposed(el)) continue;
      const type = lc(el.getAttribute('type'));
      const ac = lc(el.getAttribute('autocomplete') || (el.form && el.form.getAttribute('autocomplete')) || '');
      if (type !== 'password' && !/\b(current-password|one-time-code)\b/.test(ac)) continue;
      const what = type === 'password' ? 'Password field' : 'One-time code field';
      if (pasteBlocked(el)) report('auth_paste_blocked', el, what + ' cancels the paste event.');
      else if (ac === 'off') report('auth_autocomplete_off', el, what + ' has autocomplete="off".');
      else report('auth_ok', el, what + ' accepts paste' + (ac ? ' (autocomplete="' + ac + '")' : '') + '.');
    }

    /* Text: contrast and size */
    for (const el of elements) {
      const ln = el.localName;
      if (/^(script|style|noscript|template|option|optgroup|select|textarea|title|head|svg|math)$/.test(ln)) continue;
      let hasText = false;
      for (const k of el.childNodes) if (k.nodeType === 3 && norm(k.nodeValue)) { hasText = true; break; }
      if (!hasText) continue;
      if (!isVisible(el)) continue;
      if (el.closest('svg')) continue; // SVG text is painted with fill, not color
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue; // visually hidden text
      const s = cs(el);
      if (s.clip === 'rect(0px, 0px, 0px, 0px)' || s.clipPath === 'inset(50%)') continue;
      if (el.closest('button:disabled, fieldset:disabled, [aria-disabled="true"], select:disabled, input:disabled')) continue;
      const size = px(s.fontSize);
      if (size > 0 && size < 10) report('text_small', el, 'Font size ' + (Math.round(size * 10) / 10) + 'px.');
      const fg = parseColor(s.color);
      if (fg[3] === 0) continue; // text-fill tricks; covered by background check if any
      const bg = backgroundBehind(el);
      const weight = parseInt(s.fontWeight, 10) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const required = large ? 3 : 4.5;
      const sample = norm(Array.from(el.childNodes).filter((k) => k.nodeType === 3).map((k) => k.nodeValue).join(' ')).slice(0, 50);
      if (bg.unknown) {
        report('contrast_unknown', el, 'Text "' + sample + '" is on a ' + bg.reason + '.');
        continue;
      }
      const fgEff = [fg[0], fg[1], fg[2], fg[3] * bg.opacity];
      const fgFinal = blend(fgEff, bg.color);
      const ratio = contrastRatio(fgFinal, bg.color);
      const rounded = Math.floor(ratio * 100) / 100;
      const extra = { ratio: rounded, required, fg: hex(fgFinal), bg: hex(bg.color), fontSize: Math.round(size * 10) / 10, fontWeight: weight, large };
      const desc = rounded + ':1 — ' + hex(fgFinal) + ' on ' + hex(bg.color) + ', ' + extra.fontSize + 'px' + (weight >= 700 ? ' bold' : '') + ' ("' + sample + '")';
      if (ratio < required) report('contrast', el, 'Contrast ' + desc + '. Needs ' + required + ':1.', extra);
      else report('contrast_ok', el, 'Contrast ' + desc + '.', extra);
    }

    const de = document.documentElement;
    const body = document.body;
    return {
      results,
      meta: {
        title,
        lang,
        url: location.href,
        docWidth: Math.max(de.scrollWidth, body ? body.scrollWidth : 0, de.clientWidth),
        docHeight: Math.max(de.scrollHeight, body ? body.scrollHeight : 0, de.clientHeight),
        viewportWidth: topWin.innerWidth,
        elementCount: elements.length,
        frames: frameOffsets.size,
      },
    };
  }

  function decodeURIComponentSafe(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

  /* ───────────────────────── Focus visible (2.4.7) ───────────────────────── */

  function focusCheck(limit) {
    results = [];
    limit = limit || 120;
    if (!frameOffsets.size) collectElements();
    const all = [];
    (function walk(root) {
      for (const el of root.querySelectorAll('*')) {
        all.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    })(document);
    const PROPS = ['boxShadow', 'backgroundColor', 'color', 'borderTopColor', 'borderBottomColor', 'borderLeftColor',
      'borderBottomWidth', 'textDecorationLine', 'transform', 'opacity', 'filter'];
    // Outline properties only count when an outline is actually drawn (the UA sheet
    // changes outline-offset on :focus-visible even when the author sets outline: none).
    const snap = (el) => {
      const s = cs(el);
      const outline = s.outlineStyle !== 'none' && px(s.outlineWidth) > 0 ? [s.outlineStyle, s.outlineWidth, s.outlineColor, s.outlineOffset].join(' ') : 'no-outline';
      return outline + '|' + PROPS.map((p) => s[p]).join('|');
    };
    const pseudoSnap = (el) => { try { const a = el.ownerDocument.defaultView.getComputedStyle(el, '::after'); const b = el.ownerDocument.defaultView.getComputedStyle(el, '::before'); return [a.content, a.opacity, a.borderBottomColor, a.backgroundColor, b.content, b.opacity, b.backgroundColor].join('|'); } catch (e) { return ''; } };
    const firstChildSnap = (el) => { const c = el.firstElementChild; return c ? snap(c) : ''; };
    // Catches :focus-within patterns where the wrapper draws the focus ring.
    const parentSnap = (el) => { const p = parentOf(el); if (!p || p === document.body) return ''; const s = cs(p); return [s.outlineStyle, s.outlineWidth, s.boxShadow, s.borderTopColor, s.borderBottomColor, s.backgroundColor].join('|'); };
    const visibleOutline = (el) => { const s = cs(el); return s.outlineStyle !== 'none' && px(s.outlineWidth) > 0; };

    // Freeze transitions so computed styles show the focused end state immediately.
    const freeze = document.createElement('style');
    freeze.textContent = '*,*::before,*::after{transition:none!important;animation-play-state:paused!important}';
    (document.head || document.documentElement).appendChild(freeze);

    let checked = 0;
    let obscuredChecked = 0;
    let obscuredOk = 0;
    const prevActive = document.activeElement;
    for (const el of all) {
      if (checked >= limit) break;
      if (!isTabbable(el) || el.localName === 'iframe') continue;
      if (!exposed(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const before = snap(el) + '#' + pseudoSnap(el) + '#' + firstChildSnap(el) + '#' + parentSnap(el);
      const outlineBefore = visibleOutline(el);
      const rectBefore = rectOf(el);
      try { el.focus({ preventScroll: true, focusVisible: true }); } catch (e) { continue; }
      const root = el.getRootNode();
      if (root.activeElement !== el && document.activeElement !== el) continue;
      const after = snap(el) + '#' + pseudoSnap(el) + '#' + firstChildSnap(el) + '#' + parentSnap(el);
      const outlineAfter = visibleOutline(el);
      el.blur();
      checked++;
      // 2.4.11 Focus Not Obscured: focus again the way Tab would, letting the page scroll.
      if (el.ownerDocument === document) {
        const cover = obscuredBy(el);
        if (cover !== undefined) {
          obscuredChecked++;
          if (cover) {
            results.push({
              rule: 'focus_obscured', message: 'Covered by ' + describe(cover) + ' (position: ' + cs(cover).position + ') when focused.',
              selector: selectorOf(el), snippet: snippetOf(el), rect: rectBefore, order: orderOf.has(el) ? orderOf.get(el) : -1, extra: { coveredBy: selectorOf(cover) },
            });
          } else obscuredOk++;
        }
      }
      const changed = before !== after || (!outlineBefore && outlineAfter);
      const label = accName(el).name;
      const rec = changed ? 'focus_visible_ok' : 'focus_visible';
      results.push({
        rule: rec,
        message: (changed ? 'Focus style changes' : 'No visible change on focus') + ' for <' + el.localName + '>' + (label ? ' "' + label.slice(0, 60) + '"' : '') + '.',
        selector: selectorOf(el), snippet: snippetOf(el), rect: rectBefore, order: orderOf.has(el) ? orderOf.get(el) : -1, extra: null,
      });
    }
    try { if (prevActive && prevActive.focus) prevActive.focus({ preventScroll: true }); else document.activeElement.blur(); } catch (e) { /* ignore */ }
    freeze.remove();
    topWin.scrollTo(0, 0);
    if (obscuredOk) {
      results.push({ rule: 'focus_obscured_ok', message: obscuredOk + ' of ' + obscuredChecked + ' focused elements stayed at least partly visible.', selector: null, snippet: null, rect: null, order: -1, extra: null });
    }
    return { results, checked };
  }

  const describe = (el) => {
    let d = '<' + el.localName + (el.id ? ' id="' + el.id + '"' : (typeof el.className === 'string' && el.className.trim() ? ' class="' + el.className.trim().split(/\s+/).slice(0, 2).join(' ') + '"' : '')) + '>';
    const n = norm(el.getAttribute('aria-label') || '');
    if (n) d += ' "' + n.slice(0, 40) + '"';
    return d;
  };

  // Returns the fixed/sticky element that completely covers `el` after focusing it,
  // null when at least part of it is visible, or undefined when it cannot be judged.
  function obscuredBy(el) {
    try { el.focus({ focusVisible: true }); } catch (e) { return undefined; }
    const root = el.getRootNode();
    if ((root.activeElement || document.activeElement) !== el && document.activeElement !== el) return undefined;
    const r = el.getBoundingClientRect();
    const vw = topWin.innerWidth;
    const vh = topWin.innerHeight;
    const x0 = Math.max(r.left + 2, 0), x1 = Math.min(r.right - 2, vw - 1);
    const y0 = Math.max(r.top + 2, 0), y1 = Math.min(r.bottom - 2, vh - 1);
    el.blur();
    if (x1 <= x0 || y1 <= y0) return undefined; // not in the viewport even after focusing
    const pts = [[(x0 + x1) / 2, (y0 + y1) / 2], [x0, y0], [x1, y0], [x0, y1], [x1, y1], [(x0 + x1) / 2, y0], [(x0 + x1) / 2, y1]];
    const lookup = typeof root.elementsFromPoint === 'function' ? root : document;
    let cover = null;
    for (const [x, y] of pts) {
      const top = lookup.elementsFromPoint(x, y)[0];
      if (!top || top === el || el.contains(top) || top.contains(el)) return null;
      let f = top;
      while (f && f !== document.body && f !== document.documentElement) {
        const pos = cs(f).position;
        if (pos === 'fixed' || pos === 'sticky') break;
        f = parentOf(f);
      }
      if (!f || f === document.body || f === document.documentElement || f.contains(el)) return null;
      if (parseFloat(cs(f).opacity) < 0.1) return null;
      cover = cover || f;
    }
    return cover;
  }

  window.__viswcag = { scan, focusCheck, version: '1.1.0' };
})();
