/*
 * WCAG 2.2 success criteria referenced by VisWCAG's rules.
 * Source: https://www.w3.org/TR/WCAG22/ (W3C Recommendation, 12 December 2024).
 *
 * Each entry: name, level, anchor (fragment id in the spec), spec URL, Understanding URL,
 * and `added: '2.2'` for criteria that are new in WCAG 2.2.
 *
 * 4.1.1 Parsing is obsolete and removed in WCAG 2.2, so no rule maps to it.
 */
const SPEC = 'https://www.w3.org/TR/WCAG22/#';
const UNDERSTANDING = 'https://www.w3.org/WAI/WCAG22/Understanding/';

const LIST = [
  ['1.1.1', 'Non-text Content', 'A', 'non-text-content'],
  ['1.2.1', 'Audio-only and Video-only (Prerecorded)', 'A', 'audio-only-and-video-only-prerecorded'],
  ['1.2.2', 'Captions (Prerecorded)', 'A', 'captions-prerecorded'],
  ['1.3.1', 'Info and Relationships', 'A', 'info-and-relationships'],
  ['1.3.5', 'Identify Input Purpose', 'AA', 'identify-input-purpose'],
  ['1.4.2', 'Audio Control', 'A', 'audio-control'],
  ['1.4.3', 'Contrast (Minimum)', 'AA', 'contrast-minimum'],
  ['1.4.4', 'Resize Text', 'AA', 'resize-text'],
  ['1.4.10', 'Reflow', 'AA', 'reflow'],
  ['2.2.1', 'Timing Adjustable', 'A', 'timing-adjustable'],
  ['2.2.2', 'Pause, Stop, Hide', 'A', 'pause-stop-hide'],
  ['2.4.1', 'Bypass Blocks', 'A', 'bypass-blocks'],
  ['2.4.2', 'Page Titled', 'A', 'page-titled'],
  ['2.4.3', 'Focus Order', 'A', 'focus-order'],
  ['2.4.4', 'Link Purpose (In Context)', 'A', 'link-purpose-in-context'],
  ['2.4.6', 'Headings and Labels', 'AA', 'headings-and-labels'],
  ['2.4.7', 'Focus Visible', 'AA', 'focus-visible'],
  ['2.4.11', 'Focus Not Obscured (Minimum)', 'AA', 'focus-not-obscured-minimum', '2.2'],
  ['2.5.3', 'Label in Name', 'A', 'label-in-name'],
  ['2.5.7', 'Dragging Movements', 'AA', 'dragging-movements', '2.2'],
  ['2.5.8', 'Target Size (Minimum)', 'AA', 'target-size-minimum', '2.2'],
  ['3.1.1', 'Language of Page', 'A', 'language-of-page'],
  ['3.1.2', 'Language of Parts', 'AA', 'language-of-parts'],
  ['3.2.5', 'Change on Request', 'AAA', 'change-on-request'],
  ['3.2.6', 'Consistent Help', 'A', 'consistent-help', '2.2'],
  ['3.3.2', 'Labels or Instructions', 'A', 'labels-or-instructions'],
  ['3.3.7', 'Redundant Entry', 'A', 'redundant-entry', '2.2'],
  ['3.3.8', 'Accessible Authentication (Minimum)', 'AA', 'accessible-authentication-minimum', '2.2'],
  ['4.1.2', 'Name, Role, Value', 'A', 'name-role-value'],
];

const WCAG22 = {};
for (const [code, name, level, anchor, added] of LIST) {
  WCAG22[code] = { name, level, anchor, spec: SPEC + anchor, understanding: UNDERSTANDING + anchor + '.html', ...(added ? { added } : {}) };
}

/*
 * New Level A and AA criteria in WCAG 2.2 and how far VisWCAG tests them.
 * Shown on the "What VisWCAG checks" page.
 */
const COVERAGE_22 = [
  { sc: '2.4.11', coverage: 'automated', note: 'Each focusable element is focused the way keyboard navigation would focus it; an error is reported when a fixed or sticky element (header, footer, banner) covers it completely.' },
  { sc: '2.5.7', coverage: 'partial', note: 'Draggable elements and custom sliders are flagged as alerts. Whether a single-pointer alternative exists needs a person to check.' },
  { sc: '2.5.8', coverage: 'automated', note: 'Targets smaller than 24 by 24 CSS pixels are measured with the spacing test (a 24 px circle around each). Links in sentences and unstyled browser controls are exempt. The Equivalent and Essential exceptions need a person to judge.' },
  { sc: '3.2.6', coverage: 'manual', note: 'Help mechanisms (contact details, chat, help links) must appear in the same relative order on every page. Check this across pages manually.' },
  { sc: '3.3.7', coverage: 'manual', note: 'Information the user already entered in the same process must be filled in or selectable. Check multi-step forms manually.' },
  { sc: '3.3.8', coverage: 'partial', note: 'Password and one-time-code fields that block pasting are errors; fields that turn off autocomplete (which can stop password managers) are alerts. CAPTCHAs and other cognitive tests need a person to check.' },
];

module.exports = { WCAG22, COVERAGE_22, SPEC, UNDERSTANDING };
