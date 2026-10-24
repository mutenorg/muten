// runtime-hints: what the usual errors of a muten app mean, under the error in `muten dev`'s overlay. The browser's own
// words say what broke («x is not a function») but not why it happens in a muten app nor what to change; these do, for
// the handful that make up nearly every runtime error: a name a package does not export, an answer that is a web page
// and not data, a request that never got an answer, a field read off nothing, a global that is not there yet, an
// endless loop, a page's code gone after a restart, and storage that is full. One table, first match wins.

interface Hint { test: RegExp; say: (match: RegExpMatchArray) => string }

const HINTS: ReadonlyArray<Hint> = [
  { test: /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/,
    say: () => 'A page\'s code could not be loaded. After the dev server restarts, the files the open tab asks for have new names: reload the page.' },
  { test: /\b([\w$.]+) is not a function/,
    say: (m) => `\`${m[1]}\` is not a function here. When it comes from a \`use\` line, the package exports it under another name, or as its default (a \`use\` with one name takes the default). \`muten add <package>\` prints what a package exports.` },
  { test: /Unexpected token '<'|is not valid JSON|JSON\.parse: unexpected character/,
    say: () => 'A request was answered with a web page instead of data: the address is wrong, or it reached the dev server\'s own page. Check the source\'s url; the devtools\' Data tab shows what came back.' },
  { test: /Failed to fetch|NetworkError when attempting to fetch|Load failed/,
    say: () => 'A request got no answer: the API is not running, the address is wrong, or the server does not let this page ask it (CORS). On a phone, `localhost` is the phone itself: use the computer\'s address on the wifi.' },
  { test: /Cannot read propert(?:y|ies) of (undefined|null)(?: \(reading '([^']+)'\))?/,
    say: (m) => `Something was ${m[1]} where ${m[2] ? `\`.${m[2]}\`` : 'a field'} was read. In a Custom: an input not passed (inputs arrive at mount; return an updater for live ones) or an element not found. In a \`use\` function: the value it was given was empty, like a query that has not arrived.` },
  { test: /\b([\w$]+) is not defined/,
    say: (m) => `\`${m[1]}\` does not exist where it is used: a global a \`<script>\` leaves that has not loaded (write \`use ${m[1]} from script "…"\` so muten waits for it), or a name a Custom expects and nothing defines.` },
  { test: /Maximum call stack size exceeded|too much recursion/,
    say: () => 'An endless loop: an effect that changes what it reads, or an action that calls itself. Find the effect or action at this line and break the circle.' },
  { test: /QuotaExceededError|exceeded the quota/,
    say: () => 'The browser\'s storage is full: a `persist` state holds too much (photos, a long list). Persist less, or keep the big part on the server.' },
];

/** What the error means in a muten app and what to change, or '' when it is not one of the usual ones. */
export function runtimeHint(message: string): string {
  for (const hint of HINTS) { const match = message.match(hint.test); if (match) return hint.say(match); }
  return '';
}
