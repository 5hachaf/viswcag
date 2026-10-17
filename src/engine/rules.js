/*
 * Rule catalogue. Every result the engine emits references one of these ids.
 *   type:    'error' | 'alert' | 'pass'
 *   sc:      WCAG 2.2 success criteria (see wcag.js)
 *   summary: what the finding means
 *   fix:     how to resolve it (errors/alerts) or what to keep doing (passes)
 */
const RULES = {
  /* ───────────── Errors ───────────── */
  alt_missing: {
    type: 'error', title: 'Missing alternative text', sc: ['1.1.1'],
    summary: 'An image has no alt attribute, so screen readers announce the file name or nothing at all.',
    fix: 'Add an alt attribute that conveys the image\'s content or function. Use alt="" only if the image is purely decorative.',
  },
  alt_link_missing: {
    type: 'error', title: 'Linked image missing alternative text', sc: ['1.1.1', '2.4.4'],
    summary: 'A link or button contains only an image, and that image has no usable text alternative, so the control has no name.',
    fix: 'Give the image alt text that describes where the link goes or what the button does.',
  },
  alt_input_missing: {
    type: 'error', title: 'Image button missing alternative text', sc: ['1.1.1', '4.1.2'],
    summary: 'An <input type="image"> has no alt text, so its purpose is not announced.',
    fix: 'Add an alt attribute describing the button\'s action, such as alt="Search".',
  },
  alt_area_missing: {
    type: 'error', title: 'Image map area missing alternative text', sc: ['1.1.1', '2.4.4'],
    summary: 'A clickable <area> in an image map has no alt text.',
    fix: 'Add alt text to every <area> that describes its destination.',
  },
  svg_name_missing: {
    type: 'error', title: 'SVG image has no accessible name', sc: ['1.1.1'],
    summary: 'An <svg> marked role="img" has no aria-label, aria-labelledby or <title>.',
    fix: 'Add a <title> as the first child of the SVG or an aria-label. If the graphic is decorative, use aria-hidden="true" instead of role="img".',
  },
  label_missing: {
    type: 'error', title: 'Missing form label', sc: ['1.3.1', '3.3.2', '4.1.2'],
    summary: 'A form field has no programmatic label, so assistive technology cannot tell users what to enter.',
    fix: 'Associate a visible <label for="id"> with the field, wrap the field in a <label>, or use aria-labelledby.',
  },
  label_orphaned: {
    type: 'error', title: 'Orphaned form label', sc: ['1.3.1', '2.4.6'],
    summary: 'A <label for="…"> points at an id that does not exist or is not a form field, so it labels nothing.',
    fix: 'Make the for attribute match the id of the field it describes.',
  },
  label_empty: {
    type: 'error', title: 'Empty form label', sc: ['1.3.1', '2.4.6'],
    summary: 'A <label> element contains no text.',
    fix: 'Put descriptive text inside the label.',
  },
  button_empty: {
    type: 'error', title: 'Empty button', sc: ['1.1.1', '4.1.2'],
    summary: 'A button has no text, so screen reader users hear only "button".',
    fix: 'Add visible text, an aria-label, or alt text on an image inside the button.',
  },
  link_empty: {
    type: 'error', title: 'Empty link', sc: ['2.4.4', '4.1.2'],
    summary: 'A link has no text, so its destination cannot be determined.',
    fix: 'Add link text, or an aria-label when the link is an icon.',
  },
  heading_empty: {
    type: 'error', title: 'Empty heading', sc: ['1.3.1', '2.4.6'],
    summary: 'A heading element contains no text. Screen reader users navigating by headings land on nothing.',
    fix: 'Add text to the heading, or remove the heading element if it is only used for spacing.',
  },
  th_empty: {
    type: 'error', title: 'Empty table header', sc: ['1.3.1'],
    summary: 'A <th> cell has no text, so the column or row it heads has no name.',
    fix: 'Add header text, or use <td> if the cell is not a header.',
  },
  title_missing: {
    type: 'error', title: 'Missing page title', sc: ['2.4.2'],
    summary: 'The document has no <title>, or it is empty.',
    fix: 'Add a <title> that describes the page topic or purpose.',
  },
  lang_missing: {
    type: 'error', title: 'Page language not set', sc: ['3.1.1'],
    summary: 'The <html> element has no lang attribute, so screen readers may use the wrong pronunciation.',
    fix: 'Add a lang attribute to <html>, such as lang="en".',
  },
  lang_invalid: {
    type: 'error', title: 'Invalid page language', sc: ['3.1.1'],
    summary: 'The lang attribute on <html> is not a valid BCP 47 language tag.',
    fix: 'Use a valid tag such as "en", "en-GB" or "he".',
  },
  lang_part_invalid: {
    type: 'error', title: 'Invalid language on element', sc: ['3.1.2'],
    summary: 'An element has a lang attribute that is not a valid language tag.',
    fix: 'Use a valid BCP 47 tag such as "fr" or "es-MX".',
  },
  contrast: {
    type: 'error', title: 'Very low contrast', sc: ['1.4.3'],
    summary: 'Text does not meet the minimum contrast ratio of 4.5:1 (3:1 for large text).',
    fix: 'Darken the text or lighten the background (or the reverse) until the ratio passes.',
  },
  aria_ref_broken: {
    type: 'error', title: 'Broken ARIA reference', sc: ['1.3.1', '4.1.2'],
    summary: 'aria-labelledby or aria-describedby points at an id that does not exist on the page.',
    fix: 'Make every referenced id exist, or remove the attribute.',
  },
  aria_role_invalid: {
    type: 'error', title: 'Invalid ARIA role', sc: ['4.1.2'],
    summary: 'The role attribute contains no valid WAI-ARIA role, so the element\'s purpose is misreported.',
    fix: 'Use a role defined in WAI-ARIA 1.2, or remove the attribute and use the native HTML element.',
  },
  aria_required_attr: {
    type: 'error', title: 'Missing required ARIA attribute', sc: ['4.1.2'],
    summary: 'This ARIA role requires a state or property (for example aria-checked on a checkbox) that is missing.',
    fix: 'Add the required attribute and keep it updated with script, or use the native element.',
  },
  aria_hidden_focusable: {
    type: 'error', title: 'Focusable element hidden from assistive technology', sc: ['4.1.2'],
    summary: 'A keyboard-focusable element is inside aria-hidden="true". Keyboard users reach it but screen readers announce nothing.',
    fix: 'Remove aria-hidden, or make the element unfocusable (tabindex="-1", disabled or inert).',
  },
  aria_hidden_body: {
    type: 'error', title: 'Entire page hidden from assistive technology', sc: ['4.1.2'],
    summary: 'aria-hidden="true" is set on <body> or <html>, hiding the whole page from screen readers.',
    fix: 'Remove aria-hidden from <body>/<html>; hide only the specific background content while a dialog is open.',
  },
  iframe_title_missing: {
    type: 'error', title: 'Frame missing title', sc: ['4.1.2'],
    summary: 'An <iframe> has no title or aria-label describing its contents.',
    fix: 'Add a title attribute that names the embedded content, such as title="Store location map".',
  },
  id_duplicate_ref: {
    type: 'error', title: 'Duplicate id used by a label or ARIA', sc: ['1.3.1', '4.1.2'],
    summary: 'Two or more elements share an id that a <label for>, aria-labelledby, aria-describedby or similar attribute points at. Assistive technology uses the first match, so the label or description can end up on the wrong element.',
    fix: 'Make every id on the page unique, and check the reference points at the intended element.',
  },
  viewport_zoom: {
    type: 'error', title: 'Zooming disabled', sc: ['1.4.4'],
    summary: 'The viewport meta tag blocks pinch-zoom (user-scalable=no or maximum-scale below 2).',
    fix: 'Remove user-scalable=no and maximum-scale from the viewport meta tag.',
  },
  meta_refresh: {
    type: 'error', title: 'Page refreshes or redirects automatically', sc: ['2.2.1', '3.2.5'],
    summary: 'A <meta http-equiv="refresh"> reloads or redirects the page after a delay without user control.',
    fix: 'Remove the timed refresh. Use a server-side redirect, or give users a control to refresh.',
  },
  blink_marquee: {
    type: 'error', title: 'Moving or blinking content', sc: ['2.2.2'],
    summary: '<marquee> or <blink> moves content automatically with no way to pause it.',
    fix: 'Replace it with static content, or provide a pause control.',
  },
  li_orphan: {
    type: 'error', title: 'List item outside a list', sc: ['1.3.1'],
    summary: 'An <li> is not inside a <ul>, <ol> or <menu>, so the list relationship is lost.',
    fix: 'Wrap list items in a <ul> or <ol>.',
  },
  list_invalid_child: {
    type: 'error', title: 'Invalid list structure', sc: ['1.3.1'],
    summary: 'A <ul> or <ol> contains direct children other than <li>, which breaks how screen readers count items.',
    fix: 'Make every direct child of the list an <li>.',
  },
  nested_interactive: {
    type: 'error', title: 'Interactive element nested inside another', sc: ['4.1.2'],
    summary: 'A link or button contains another focusable control. Assistive technology cannot reliably announce or operate either one.',
    fix: 'Move the inner control outside the link or button.',
  },
  autocomplete_invalid: {
    type: 'error', title: 'Invalid autocomplete value', sc: ['1.3.5'],
    summary: 'The autocomplete attribute uses a token that is not in the HTML specification, so browsers and assistive tools cannot identify the field.',
    fix: 'Use a valid token such as "email", "given-name", "tel" or "street-address".',
  },
  skip_link_broken: {
    type: 'error', title: 'Broken skip link', sc: ['2.4.1'],
    summary: 'A "skip" link points at an anchor that does not exist on the page.',
    fix: 'Point the link at the id of the main content container.',
  },
  bypass_missing: {
    type: 'error', title: 'No way to bypass repeated content', sc: ['2.4.1'],
    summary: 'The page has no skip link, no landmarks and no headings, so keyboard and screen reader users must move through every repeated item.',
    fix: 'Add a <main> landmark, headings, or a "Skip to main content" link.',
  },
  target_size: {
    type: 'error', title: 'Target too small', sc: ['2.5.8'],
    summary: 'A clickable target is smaller than 24 by 24 CSS pixels and too close to another target, so it is easy to miss or to hit the wrong one.',
    fix: 'Make the target at least 24 by 24 px (padding counts), or leave enough space that a 24 px circle centred on it touches no other target. Not needed if another control on the page does the same thing.',
  },
  focus_obscured: {
    type: 'error', title: 'Focused element hidden', sc: ['2.4.11'],
    summary: 'When this element receives keyboard focus, a fixed or sticky element (such as a header, footer or banner) covers it completely, so keyboard users cannot see where they are.',
    fix: 'Add scroll-padding-top / scroll-padding-bottom equal to the height of sticky bars, make the bar non-sticky, or move the banner so it does not cover focusable content.',
  },
  auth_paste_blocked: {
    type: 'error', title: 'Pasting blocked in a login field', sc: ['3.3.8'],
    summary: 'A password or one-time-code field cancels paste. People who rely on password managers or copy and paste must instead remember and retype the value, which is a cognitive function test.',
    fix: 'Remove the script that cancels the paste event so pasting works.',
  },
  reflow: {
    type: 'error', title: 'Content does not reflow at 320px', sc: ['1.4.10'],
    summary: 'At a viewport 320 CSS pixels wide (equivalent to 400% zoom) the page needs horizontal scrolling.',
    fix: 'Use responsive layout so content fits 320px. Find fixed widths, wide images or tables and let them shrink or scroll inside their own container.',
  },

  /* ───────────── Alerts ───────────── */
  id_duplicate: {
    type: 'alert', title: 'Duplicate id', sc: ['4.1.2'],
    summary: 'Two or more elements share the same id. Nothing on the page refers to it now, but scripts, in-page links and future labels can pick the wrong element. (Duplicate ids alone no longer fail WCAG 2.2, which removed 4.1.1 Parsing.)',
    fix: 'Make every id on the page unique.',
  },
  dragging: {
    type: 'alert', title: 'Dragging may need an alternative', sc: ['2.5.7'],
    summary: 'This element can be dragged, or is a custom slider. Anything done by dragging must also work with a single pointer without dragging, such as clicking, tapping or buttons.',
    fix: 'Provide a single-pointer alternative, for example move up and down buttons, a menu, clicking the slider track, or a text field for the value.',
  },
  auth_autocomplete_off: {
    type: 'alert', title: 'Login field turns off autocomplete', sc: ['3.3.8', '1.3.5'],
    summary: 'A password or one-time-code field has autocomplete="off". This can stop password managers and browsers filling it in, leaving people to remember and type the value.',
    fix: 'Remove autocomplete="off" and use autocomplete="current-password", "new-password" or "one-time-code".',
  },
  alt_suspicious: {
    type: 'alert', title: 'Suspicious alternative text', sc: ['1.1.1'],
    summary: 'The alt text looks like a file name or a placeholder ("image", "photo"), or starts with "image of".',
    fix: 'Describe what the image shows or does. Screen readers already announce that it is an image.',
  },
  alt_long: {
    type: 'alert', title: 'Long alternative text', sc: ['1.1.1'],
    summary: 'The alt text is longer than 125 characters. Long descriptions are hard to listen to and cannot be paused.',
    fix: 'Keep alt text short; put long descriptions in nearby text or a <figcaption>.',
  },
  alt_redundant: {
    type: 'alert', title: 'Redundant alternative text', sc: ['1.1.1'],
    summary: 'The alt text repeats text that is right next to the image, so screen reader users hear it twice.',
    fix: 'Use alt="" if the adjacent text already says the same thing, or make the alt text add information.',
  },
  alt_title_only: {
    type: 'alert', title: 'Image labelled only by title', sc: ['1.1.1'],
    summary: 'The image has no alt attribute and relies on the title tooltip, which many users never see.',
    fix: 'Move the text into an alt attribute.',
  },
  label_title_only: {
    type: 'alert', title: 'Field labelled only by title', sc: ['3.3.2', '2.4.6'],
    summary: 'The field\'s only label is a title tooltip, which is not visible to most users.',
    fix: 'Add a visible <label> associated with the field.',
  },
  label_placeholder_only: {
    type: 'alert', title: 'Field labelled only by placeholder', sc: ['3.3.2', '2.4.6'],
    summary: 'The field\'s only label is placeholder text, which disappears when users start typing and often has low contrast.',
    fix: 'Add a persistent visible <label>. Keep the placeholder for example input only.',
  },
  link_suspicious: {
    type: 'alert', title: 'Suspicious link text', sc: ['2.4.4'],
    summary: 'Link text such as "click here" or "read more" does not describe the destination when read out of context.',
    fix: 'Rewrite the link text to name the destination, or add context with aria-describedby or visually-hidden text.',
  },
  link_redundant: {
    type: 'alert', title: 'Redundant link', sc: ['2.4.4'],
    summary: 'Two adjacent links go to the same URL, so keyboard and screen reader users meet the same destination twice.',
    fix: 'Combine the image and text into a single link.',
  },
  label_in_name: {
    type: 'alert', title: 'Accessible name does not contain visible label', sc: ['2.5.3'],
    summary: 'The aria-label does not include the control\'s visible text, so speech-input users who say the visible label cannot activate it.',
    fix: 'Start the aria-label with the visible text, or remove the aria-label.',
  },
  heading_skipped: {
    type: 'alert', title: 'Skipped heading level', sc: ['1.3.1'],
    summary: 'The heading level jumps by more than one (for example H2 to H4), which suggests a gap in the outline.',
    fix: 'Use heading levels that reflect the content structure without skipping.',
  },
  h1_missing: {
    type: 'alert', title: 'Missing first-level heading', sc: ['1.3.1', '2.4.6'],
    summary: 'The page has no <h1>. A first-level heading helps users find the start of the main content.',
    fix: 'Mark up the main page heading as an <h1>.',
  },
  heading_possible: {
    type: 'alert', title: 'Possible heading', sc: ['1.3.1'],
    summary: 'Short, large or bold text is styled like a heading but is not marked up as one.',
    fix: 'If this text introduces a section, mark it up as an <h1>–<h6>.',
  },
  landmark_main_missing: {
    type: 'alert', title: 'No main landmark', sc: ['1.3.1', '2.4.1'],
    summary: 'The page has no <main> element or role="main".',
    fix: 'Wrap the primary content in a <main> element.',
  },
  tabindex_positive: {
    type: 'alert', title: 'Positive tabindex', sc: ['2.4.3'],
    summary: 'tabindex greater than 0 forces this element ahead of the natural tab order, which often confuses keyboard users.',
    fix: 'Use tabindex="0" and arrange the DOM in a logical order instead.',
  },
  fieldset_missing: {
    type: 'alert', title: 'Radio buttons not grouped', sc: ['1.3.1'],
    summary: 'A set of radio buttons with the same name is not inside a <fieldset> or role="radiogroup", so the group question is not announced.',
    fix: 'Wrap the radio buttons in a <fieldset> with a <legend> that asks the question.',
  },
  legend_missing: {
    type: 'alert', title: 'Fieldset without legend', sc: ['1.3.1'],
    summary: 'A <fieldset> has no <legend>, so the group has no name.',
    fix: 'Add a <legend> as the first child of the fieldset.',
  },
  table_no_headers: {
    type: 'alert', title: 'Table without headers', sc: ['1.3.1'],
    summary: 'A table with several rows and columns has no <th> cells. If it holds data, users cannot tell which header goes with each cell.',
    fix: 'Mark header cells with <th> (and scope). If the table is only for layout, add role="presentation" or use CSS layout.',
  },
  media_autoplay: {
    type: 'alert', title: 'Media plays automatically', sc: ['1.4.2'],
    summary: 'Audio or video starts playing on its own with sound. Sound can drown out a screen reader.',
    fix: 'Remove autoplay, add the muted attribute, or give users an obvious pause control at the start of the page.',
  },
  video_captions: {
    type: 'alert', title: 'Video may lack captions', sc: ['1.2.2'],
    summary: 'A <video> has no captions or subtitles <track>.',
    fix: 'Add <track kind="captions">, or confirm captions are burned in or provided another way.',
  },
  media_embedded: {
    type: 'alert', title: 'Embedded media player', sc: ['1.2.2', '1.2.1'],
    summary: 'This frame looks like an embedded video or audio player. Captions and transcripts cannot be verified automatically.',
    fix: 'Check the embedded media has accurate captions and, for audio-only content, a transcript.',
  },
  audio_transcript: {
    type: 'alert', title: 'Audio may need a transcript', sc: ['1.2.1'],
    summary: 'An <audio> element is present. Prerecorded audio needs a text alternative.',
    fix: 'Provide a transcript next to the audio player.',
  },
  plugin_content: {
    type: 'alert', title: 'Embedded object', sc: ['1.1.1'],
    summary: 'An <object> or <embed> is present. Its content may not be accessible.',
    fix: 'Provide fallback text or an accessible alternative for the embedded content.',
  },
  text_small: {
    type: 'alert', title: 'Very small text', sc: ['1.4.4'],
    summary: 'Text is smaller than 10 pixels, which is hard to read for many users.',
    fix: 'Increase the font size; use relative units (rem/em) so text scales with user settings.',
  },
  contrast_unknown: {
    type: 'alert', title: 'Contrast could not be determined', sc: ['1.4.3'],
    summary: 'The text sits on a background image or gradient, so its contrast cannot be measured automatically.',
    fix: 'Check the text manually against the darkest and lightest parts of the background.',
  },
  autocomplete_missing: {
    type: 'alert', title: 'Personal data field without autocomplete', sc: ['1.3.5'],
    summary: 'This field appears to collect information about the user (email, phone, name, address) but has no autocomplete attribute.',
    fix: 'Add the matching autocomplete token, such as autocomplete="email".',
  },
  focus_visible: {
    type: 'alert', title: 'Focus indicator may be missing', sc: ['2.4.7'],
    summary: 'When this element received keyboard focus, none of its outline, border, background, colour or shadow changed.',
    fix: 'Do not remove the outline without replacing it. Style :focus-visible with a clearly visible outline.',
  },

  /* ───────────── Passed ───────────── */
  alt_ok: {
    type: 'pass', title: 'Image has alternative text', sc: ['1.1.1'],
    summary: 'The image has a text alternative. Check that it conveys the same information as the image.',
    fix: 'Keep the alt text accurate if the image changes.',
  },
  alt_decorative: {
    type: 'pass', title: 'Decorative image hidden from assistive technology', sc: ['1.1.1'],
    summary: 'The image has an empty alt (or a presentation role), so screen readers skip it. Correct only if the image adds no information.',
    fix: 'Confirm the image is purely decorative.',
  },
  svg_ok: {
    type: 'pass', title: 'SVG image has an accessible name', sc: ['1.1.1'],
    summary: 'An SVG with role="img" has a name.',
    fix: 'Keep the name accurate.',
  },
  label_ok: {
    type: 'pass', title: 'Form field is labelled', sc: ['1.3.1', '3.3.2', '4.1.2'],
    summary: 'The field has a programmatic label.',
    fix: 'Keep labels visible and descriptive.',
  },
  button_ok: {
    type: 'pass', title: 'Button has an accessible name', sc: ['4.1.2'],
    summary: 'The button has text that names its action.',
    fix: 'Keep the name short and action-based.',
  },
  link_ok: {
    type: 'pass', title: 'Link has text', sc: ['2.4.4'],
    summary: 'The link has an accessible name.',
    fix: 'Make sure the text describes the destination.',
  },
  heading_ok: {
    type: 'pass', title: 'Heading', sc: ['1.3.1', '2.4.6'],
    summary: 'A heading with text marks the start of a section.',
    fix: 'Keep heading levels in a logical order.',
  },
  h1_ok: {
    type: 'pass', title: 'Page has a first-level heading', sc: ['1.3.1', '2.4.6'],
    summary: 'An <h1> identifies the main topic of the page.',
    fix: 'Keep the <h1> describing the page purpose.',
  },
  title_ok: {
    type: 'pass', title: 'Page has a title', sc: ['2.4.2'],
    summary: 'The document has a <title>. Check that it describes the page.',
    fix: 'Keep titles unique and specific.',
  },
  lang_ok: {
    type: 'pass', title: 'Page language is set', sc: ['3.1.1'],
    summary: 'The <html> element has a valid lang attribute.',
    fix: 'Make sure it matches the main language of the content.',
  },
  contrast_ok: {
    type: 'pass', title: 'Text contrast is sufficient', sc: ['1.4.3'],
    summary: 'The text meets the minimum contrast ratio for its size.',
    fix: 'Re-check if colours change.',
  },
  landmark_main_ok: {
    type: 'pass', title: 'Main landmark', sc: ['1.3.1', '2.4.1'],
    summary: 'A <main> landmark lets users jump straight to the primary content.',
    fix: 'Use exactly one visible main landmark per page.',
  },
  bypass_ok: {
    type: 'pass', title: 'Repeated content can be bypassed', sc: ['2.4.1'],
    summary: 'The page offers at least one way to skip repeated blocks: a skip link, landmarks or headings.',
    fix: 'Keep these mechanisms in place.',
  },
  skip_link_ok: {
    type: 'pass', title: 'Skip link target exists', sc: ['2.4.1'],
    summary: 'A skip link points to an element that exists on the page.',
    fix: 'Make sure the skip link becomes visible on focus.',
  },
  viewport_ok: {
    type: 'pass', title: 'Zoom is allowed', sc: ['1.4.4'],
    summary: 'The viewport meta tag does not block pinch-zoom.',
    fix: 'Keep zoom enabled.',
  },
  iframe_ok: {
    type: 'pass', title: 'Frame has a title', sc: ['4.1.2'],
    summary: 'The frame has a title describing its content.',
    fix: 'Keep the title accurate.',
  },
  table_headers_ok: {
    type: 'pass', title: 'Data table has headers', sc: ['1.3.1'],
    summary: 'The table identifies header cells.',
    fix: 'Use scope or headers attributes on complex tables.',
  },
  fieldset_ok: {
    type: 'pass', title: 'Radio buttons are grouped', sc: ['1.3.1'],
    summary: 'Radio buttons sharing a name are inside a fieldset or radiogroup.',
    fix: 'Give the group a legend or label.',
  },
  video_captions_ok: {
    type: 'pass', title: 'Video has a captions track', sc: ['1.2.2'],
    summary: 'The video includes a captions or subtitles track.',
    fix: 'Check the captions are accurate and synchronised.',
  },
  autocomplete_ok: {
    type: 'pass', title: 'Valid autocomplete purpose', sc: ['1.3.5'],
    summary: 'The field identifies its purpose with a valid autocomplete token.',
    fix: 'Keep the token matching the field.',
  },
  focus_visible_ok: {
    type: 'pass', title: 'Focus indicator changes on focus', sc: ['2.4.7'],
    summary: 'The element\'s appearance changes when it receives keyboard focus.',
    fix: 'Check the change is clearly visible against the background.',
  },
  target_size_ok: {
    type: 'pass', title: 'Targets are large enough or well spaced', sc: ['2.5.8'],
    summary: 'Clickable targets are at least 24 by 24 CSS pixels, have enough space around them, or are links within text.',
    fix: 'Keep touch and click targets at least 24 by 24 px.',
  },
  focus_obscured_ok: {
    type: 'pass', title: 'Focused elements stay visible', sc: ['2.4.11'],
    summary: 'When focused, the checked elements were at least partly visible and not covered by fixed or sticky content.',
    fix: 'Re-check when adding sticky headers, footers or banners.',
  },
  auth_ok: {
    type: 'pass', title: 'Login field allows paste and autofill', sc: ['3.3.8'],
    summary: 'The password or one-time-code field accepts pasting and does not turn off autocomplete, so password managers can help.',
    fix: 'Keep paste and autofill working; check any CAPTCHA or other step manually.',
  },
  reflow_ok: {
    type: 'pass', title: 'Content reflows at 320px', sc: ['1.4.10'],
    summary: 'At a 320 CSS pixel viewport the page does not need horizontal scrolling.',
    fix: 'Keep layouts responsive.',
  },
};

module.exports = { RULES };
