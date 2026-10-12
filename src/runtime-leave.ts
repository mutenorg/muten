// THE WAY OUT — take out every node between two block markers (a `when` or an `each` that no longer shows them).
// An element the app gives an animation on `.mu-leave` stays until that animation ends, so a hidden block can fade or
// collapse instead of vanishing; `--mu-h` carries its height for a collapse. Anything without one goes at once.
//
// Asking a node for its animations or its height makes the browser restyle (and lay out) the whole page first. Every
// leaving node used to be asked: on a large page with a large stylesheet each leave cost a tenth of a second on an
// ordinary phone, nearly always for nodes no rule animates. So the page's stylesheets are read once for the rules that
// name `.mu-leave`, and a leave none of whose nodes they match goes at once with nothing measured. A leave where one
// may animate goes the whole way, exactly as before.

const LEAVE_CLASS = 'mu-leave';
const HEIGHT_VAR = '--mu-h';
// The selector that stands for «cannot tell from here»: every leaving node is asked, as before.
const ANY_NODE = '*';

// THE LEAVES OF ONE UPDATE GO TOGETHER. Each asks the page for heights and animations, and every question asked
// after another block's class changed makes the browser recompute all styles again: an editor opening with
// thirteen blocks swapped paid twenty-six full recalculations. Queued to the end of the update, they cost two.
// The nodes are listed now (the markers are about to receive the new content) and stay in place until then.
let leaving: ChildNode[] | null = null;

// The rules that give a node its exit (an animation on `.mu-leave`), read from the stylesheets they were read from (a stylesheet added or changed,
// as the dev server's hot reload does, reads them again).
let exitsReadFrom = '';
let exitSelector = '';

function isHtml(node: ChildNode): node is HTMLElement {
  return typeof HTMLElement !== 'undefined' && node instanceof HTMLElement;
}

function isCssAnimation(animation: Animation): boolean {
  return typeof CSSAnimation !== 'undefined' && animation instanceof CSSAnimation;
}

/** Does this rule give what it matches an animation? (`.mu-leave { transition: none }` names the class but is no exit.) */
function animates(rule: CSSStyleRule): boolean {
  const name = rule.style.getPropertyValue('animation-name').trim();
  return name !== '' && name !== 'none';
}

/** Every selector in these rules (and the rules nested in them) that animates `.mu-leave`; ANY_NODE when one can't be read alone. */
function exitSelectorsIn(rules: CSSRuleList, found: string[]): void {
  for (const rule of rules) {
    if (rule instanceof CSSStyleRule) {
      if (rule.selectorText.includes(LEAVE_CLASS) && animates(rule)) {
        // a rule nested in another (`&.mu-leave`) only means something with its parent's selector: ask every node
        found.push(rule.parentRule instanceof CSSStyleRule ? ANY_NODE : rule.selectorText);
      }
      if (rule.cssRules.length > 0) exitSelectorsIn(rule.cssRules, found);
    } else if (rule instanceof CSSGroupingRule) {
      exitSelectorsIn(rule.cssRules, found);
    }
  }
}

/** The page's exits as one selector: '' when no rule names `.mu-leave`, ANY_NODE when it can't be told. */
function exitsOfThePage(): string {
  if (typeof document === 'undefined' || typeof CSSStyleRule === 'undefined') return ANY_NODE;
  const sheets = [...document.styleSheets];
  const readable: CSSRuleList[] = [];
  for (const sheet of sheets) {
    // another site's stylesheet (a web font's) can't be read, and can't name muten's own class either: passed over
    try { readable.push(sheet.cssRules); } catch { continue; }
  }
  const signature = `${sheets.length}:${readable.reduce((sum, rules) => sum + rules.length, 0)}`;
  if (signature === exitsReadFrom) return exitSelector;
  const found: string[] = [];
  for (const rules of readable) exitSelectorsIn(rules, found);
  exitsReadFrom = signature;
  exitSelector = found.includes(ANY_NODE) ? ANY_NODE : found.join(', ');
  return exitSelector;
}

/** Could any of these elements animate on its way out? Asked with `matches`, which never makes the page restyle. */
function mayAnimate(elements: HTMLElement[]): boolean {
  if (elements.length === 0) return false;
  const selector = exitsOfThePage();
  if (selector === '') return false;
  if (selector === ANY_NODE) return true;
  // all marked together, as the leave does (the CSS tells a lone element from a whole block by `:has(.x.mu-leave)`),
  // asked, and unmarked before anything reads a style: the class comes and goes without a restyle
  const marked = elements.filter((element) => !element.classList.contains(LEAVE_CLASS));
  marked.forEach((element) => element.classList.add(LEAVE_CLASS));
  try {
    return elements.some((element) => element.matches(selector));
  } catch {
    return true; // a selector this browser can't evaluate: ask every node, as before
  } finally {
    marked.forEach((element) => element.classList.remove(LEAVE_CLASS));
  }
}

export function __leave(start: Node, end: Node): void {
  const nodes: ChildNode[] = [];
  for (let node = start.nextSibling; node && node !== end; node = node.nextSibling) nodes.push(node);
  if (!leaving) {
    leaving = [];
    queueMicrotask(leaveTogether);
  }
  leaving.push(...nodes);
}

function leaveTogether(): void {
  const nodes = leaving ?? [];
  leaving = null;
  const elements = nodes.filter(isHtml);
  // NOTHING HERE HAS AN EXIT: out at once, nothing measured
  if (!mayAnimate(elements)) {
    nodes.forEach((node) => node.remove());
    return;
  }
  // Only an animation that STARTS with the leave counts: one already running (a looping shimmer) would never
  // end, and waiting on it would leave the node on screen for good.
  const before = new Set(elements.flatMap((element) => element.getAnimations()));
  // Measure, then mark ALL of them before asking which animate: the CSS can then tell a lone element leaving
  // from a whole block leaving together (`:has(.x.mu-leave)`), and skip the animation for the latter.
  const heights = elements.map((element) => element.offsetHeight);
  elements.forEach((element, index) => {
    element.style.setProperty(HEIGHT_VAR, `${heights[index]}px`);
    element.classList.add(LEAVE_CLASS);
  });
  // Ask every node before removing any: removing one first would change what the others' CSS matches.
  // And only a CSS ANIMATION the app put on `.mu-leave` holds the node: a transition the class change happens to start
  // (a button's `scrollbar-color`, an inherited color) is not a way out, and waiting on it left the old button on
  // screen beside its replacement.
  const endsOnItsOwn = (animation: Animation): boolean =>
    isCssAnimation(animation) && !before.has(animation) && animation.effect?.getComputedTiming().iterations !== Infinity;
  const running = nodes.map((node) => isHtml(node) ? node.getAnimations().filter(endsOnItsOwn) : []);
  nodes.forEach((node, index) => {
    const animations = running[index];
    if (!animations.length) { node.remove(); return; }
    Promise.all(animations.map((animation) => animation.finished)).then(() => node.remove(), () => node.remove());
  });
}
