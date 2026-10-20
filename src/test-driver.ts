// test-driver: the in-page half of `muten test`. Installed into each page as `window.__mutenTest`, it does what a
// person does and answers with null (it held) or why it did not, retrying while the app settles (a query loading,
// a transition). It finds things the way a person (and a screen reader) does: a control by its text, its label, its
// aria-label or title; a field by its <label>, placeholder or name; text by what is visible on screen.
//
// Kept as plain browser JS in a string: it is evaluated in the page through CDP, never bundled into the app.

/** How long a step keeps retrying before it fails. */
export const STEP_TIMEOUT_MS = 2500;

export const DRIVER_JS = `(() => {
  if (window.__mutenTest) return;
  const TIMEOUT = ${STEP_TIMEOUT_MS};
  const norm = (text) => String(text == null ? '' : text).replace(/\\s+/g, ' ').trim();
  const lower = (text) => norm(text).toLowerCase();
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  // on screen, as a person sees it: a box with size, inside the page (a skip link parked at -9999px is not), not hidden
  const visible = (el) => { const box = el.getBoundingClientRect(); return box.width > 1 && box.height > 1 && box.right > 0 && box.bottom > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  async function retry(attempt) {
    const end = Date.now() + TIMEOUT;
    for (;;) { const found = attempt(); if (found) return found; if (Date.now() > end) return null; await sleep(40); }
  }
  // the best match by name: exact first, then one that contains it (case aside)
  function byName(elements, namesOf, wanted) {
    const want = lower(wanted);
    const shown = elements.filter(visible);
    return shown.find((el) => namesOf(el).some((name) => lower(name) === want))
      || shown.find((el) => namesOf(el).some((name) => name && lower(name).includes(want)));
  }
  const listed = (elements, namesOf) => [...new Set(elements.filter(visible).map((el) => namesOf(el).find((name) => norm(name)) || '').map(norm).filter(Boolean))].slice(0, 10).map((name) => '"' + name.slice(0, 40) + '"').join(', ');

  const PRESSABLE = 'button, a[href], summary, label, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=switch], [role=checkbox], [role=radio], input[type=button], input[type=submit], input[type=checkbox], input[type=radio]';
  const pressNames = (el) => [el.getAttribute('aria-label'), el.getAttribute('title'), /^(button|submit)$/.test(el.type || '') ? el.value : null, el.innerText];
  const FIELD = 'input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable=true]';
  const labelled = (el) => { const ids = (el.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean); return ids.map((id) => document.getElementById(id)?.innerText || '').join(' '); };
  const fieldNames = (el) => [...(el.labels ? [...el.labels].map((label) => label.innerText) : []), el.getAttribute('aria-label'), labelled(el), el.getAttribute('placeholder'), el.getAttribute('name')];
  // the text a person sees: the page's rendered text without what is parked off screen or shrunk to a pixel for screen
  // readers only (a skip link, an .sr-only label)
  const screenText = () => {
    if (!document.body) return '';
    let text = norm(document.body.innerText);
    for (const el of document.body.querySelectorAll('*')) {
      if (!el.getClientRects().length || visible(el) || (el.parentElement && !visible(el.parentElement) && el.parentElement.getClientRects().length)) continue;
      const hidden = norm(el.innerText);
      if (hidden) text = norm(text.replace(hidden, ''));
    }
    return text;
  };

  async function press(name) {
    const el = await retry(() => byName([...document.querySelectorAll(PRESSABLE)], pressNames, name));
    if (!el) return 'nothing to press called "' + name + '". On screen: ' + (listed([...document.querySelectorAll(PRESSABLE)], pressNames) || 'no controls');
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return '"' + name + '" is disabled';
    el.click();
    await sleep(30);
    return null;
  }

  async function fill(name, value) {
    const el = await retry(() => byName([...document.querySelectorAll(FIELD)], fieldNames, name));
    if (!el) return 'no field called "' + name + '". On screen: ' + (listed([...document.querySelectorAll(FIELD)], fieldNames) || 'no fields');
    if (el.disabled || el.readOnly) return 'the field "' + name + '" does not take typing (disabled or read-only)';
    el.focus();
    if (el.tagName === 'SELECT') {
      const option = [...el.options].find((item) => lower(item.text) === lower(value) || item.value === value);
      if (!option) return '"' + name + '" has no option "' + value + '" (it has ' + [...el.options].map((item) => '"' + norm(item.text) + '"').join(', ') + ')';
      el.value = option.value;
    } else if (el.isContentEditable) el.textContent = value;
    else { const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set; if (setter) setter.call(el, value); else el.value = value; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
    await sleep(30);
    return null;
  }

  async function see(text, absent) {
    const want = norm(text);
    const held = await retry(() => screenText().includes(want) !== absent);
    if (held) return null;
    const shown = screenText();
    return absent ? '"' + want + '" is still on screen' : '"' + want + '" is not on screen. It shows: ' + (shown ? '"' + shown.slice(0, 280) + (shown.length > 280 ? '…' : '') + '"' : 'nothing');
  }

  window.__mutenTest = { press, fill, see };
})();`;
