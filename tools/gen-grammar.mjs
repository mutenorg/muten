// Generates the TextMate highlight FROM the manifest + the lexical rules,
// so the highlighting is correct and never drifts from the real language.
// Run after touching the manifest:  node tools/gen-grammar.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PRIMITIVE_NAMES, KEYWORDS, MODIFIERS, ACTION_OPS, TOKEN_NAMES } from '../engine/manifest.js';

const here = dirname(fileURLToPath(import.meta.url));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alt = (arr) => arr.map(esc).join('|');
const TYPES = ['text', 'email', 'string', 'number', 'bool', 'uuid', 'list'];

const grammar = {
  $schema: 'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json',
  name: 'Muten',
  scopeName: 'source.muten',
  patterns: [
    { include: '#comment' }, { include: '#string' }, { include: '#decl' },
    { include: '#component' }, { include: '#keyword' }, { include: '#modifier' },
    { include: '#method' }, { include: '#primitive' }, { include: '#token' },
    { include: '#type' }, { include: '#param' }, { include: '#ref' },
    { include: '#number' }, { include: '#operator' },
  ],
  repository: {
    comment: { match: '#.*$', name: 'comment.line.number-sign.muten' },
    string: { name: 'string.quoted.double.muten', begin: '"', end: '"' },
    decl: {
      match: '\\b(screen|entity|part|action)\\s+([A-Za-z_][A-Za-z0-9_]*)',
      captures: { 1: { name: 'keyword.control.muten' }, 2: { name: 'entity.name.type.muten' } },
    },
    // a child component = a part instance: PascalCase name immediately followed by "("
    component: { match: '\\b[A-Z][A-Za-z0-9_]*(?=\\s*\\()', name: 'entity.name.function.muten' },
    keyword: { match: `\\b(${alt(KEYWORDS)})\\b`, name: 'keyword.control.muten' },
    modifier: { match: `\\b(${alt(MODIFIERS)})\\b`, name: 'keyword.other.muten' },
    method: { match: `\\.(${alt(ACTION_OPS)})\\b`, name: 'support.function.muten' },
    primitive: { match: `\\b(${alt(PRIMITIVE_NAMES)})\\b`, name: 'support.class.muten' },
    token: { match: `\\b(${alt(TOKEN_NAMES)})\\b`, name: 'support.constant.muten' },
    type: { match: `\\b(${alt(TYPES)})\\b`, name: 'support.type.muten' },
    param: { match: '\\$[A-Za-z_][A-Za-z0-9_]*', name: 'variable.parameter.muten' },
    ref: { match: '@[A-Za-z_][A-Za-z0-9_]*', name: 'variable.other.muten' },
    number: { match: '\\b-?[0-9]+(\\.[0-9]+)?\\b', name: 'constant.numeric.muten' },
    operator: { match: '->|<-|=>|==|\\|', name: 'keyword.operator.muten' },
  },
};

writeFileSync(join(here, 'muten-vscode', 'syntaxes', 'muten.tmLanguage.json'), JSON.stringify(grammar, null, 2) + '\n');
console.log(`✓ highlight generated (${PRIMITIVE_NAMES.length} primitives, ${KEYWORDS.length} keywords, ${TOKEN_NAMES.length} tokens, + child components)`);
