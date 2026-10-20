// server-packages: npm packages that belong on a server, never in the app. They run with a secret key (Stripe, OpenAI,
// Twilio) or talk to a database, and whatever a page imports ships to every visitor: the key with it. `use stripe`
// used to pass check, bundle, and put the secret in the browser. Known ones say what the app uses instead; an unknown
// package that needs Node's own modules (http, fs, net…) and offers no browser build is caught by what it imports.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageDir } from '#engine/project/theme-library.js';

const SECRET = 'it runs with your secret key, and a page ships what it imports to every visitor. Call it from your API (`post "/…"`) instead';
const DATABASE = 'a database driver: the app talks to your API, which talks to the database';

// what each one is, and what the app does instead
const KNOWN: ReadonlyMap<string, string> = new Map([
  ['stripe', `Stripe's server SDK: ${SECRET}. In the app, \`@stripe/stripe-js\` opens Checkout and Elements; your API creates the session and the app goes to its url`],
  ['openai', `OpenAI's SDK: ${SECRET}`],
  ['@anthropic-ai/sdk', `Anthropic's SDK: ${SECRET}`],
  ['groq-sdk', `Groq's SDK: ${SECRET}`],
  ['@google/generative-ai', `Gemini's SDK: ${SECRET}`],
  ['twilio', `Twilio's SDK: ${SECRET}`],
  ['@sendgrid/mail', `SendGrid's SDK: ${SECRET}`],
  ['resend', `Resend's SDK: ${SECRET}`],
  ['@getbrevo/brevo', `Brevo's SDK: ${SECRET}`],
  ['nodemailer', `a mail sender: ${SECRET}`],
  ['mercadopago', `Mercado Pago's server SDK: ${SECRET}. In the app, \`@mercadopago/sdk-js\` opens its checkout`],
  ['firebase-admin', `Firebase's admin SDK: ${SECRET}. In the app, \`firebase\` (the web SDK) reads and writes under your security rules`],
  ['@prisma/client', DATABASE], ['pg', DATABASE], ['mysql2', DATABASE], ['mongodb', DATABASE], ['mongoose', DATABASE],
  ['redis', DATABASE], ['ioredis', DATABASE], ['better-sqlite3', DATABASE],
  ['jsonwebtoken', `a token signer: ${SECRET}`], ['bcrypt', 'a password hasher: hashing belongs on the server'],
]);

const NODE_ONLY = /(?:require\(\s*|from\s+)["'](?:node:)?(?:fs|http|https|net|tls|child_process|cluster|dgram|worker_threads)["']/;

interface Manifest { browser?: string | object; main?: string; module?: string }

function manifestOf(dir: string): Manifest {
  try {
    const raw: Manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

/** Why a package cannot be in the app, or '' when it can. */
export function serverOnly(from: string, appRoot: string): string {
  const pkg = from.startsWith('@') ? from.split('/').slice(0, 2).join('/') : from.split('/')[0];
  const known = KNOWN.get(pkg);
  if (known) return `"${pkg}" is ${known}.`;
  const dir = packageDir(appRoot, pkg);
  if (!dir) return '';
  const manifest = manifestOf(dir);
  if (manifest.browser) return '';   // it ships a browser build
  const entry = join(dir, manifest.module || manifest.main || 'index.js');
  if (!existsSync(entry)) return '';
  return NODE_ONLY.test(readFileSync(entry, 'utf8')) ? `"${pkg}" needs Node's own modules (http, fs…) that a browser does not have: it is for a server. Call it from your API (\`post "/…"\`) instead.` : '';
}
