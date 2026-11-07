// Loads apps-script/Code.gs into Node so its functions can be tested.
// Code.gs is a plain script (no exports), so its functions are collected by name.
// Running in this context, not a new one, keeps Array and Object the same as the
// test's, which assert.deepStrictEqual needs.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const NAMES = [
  'CATEGORIES', 'COLS', 'errorResponse', 'sanitizeName', 'validateBallot', 'hasDevice',
  'checkVote', 'buildRow', 'tally', 'flagGroups', 'stateResponse', 'hostResponse',
  'normalizeSettings', 'parseBody', 'unlockedRefs',
];

export const CODE_PATH = new URL('../apps-script/Code.gs', import.meta.url);
export const source = readFileSync(CODE_PATH, 'utf8');

// `globals` are the stand-ins for Apps Script services. `extra` names more functions to return.
export function loadCode(globals = {}, extra = []) {
  const params = Object.keys(globals);
  const exported = [...NAMES, ...extra].join(', ');
  const wrapped = `(function (${params.join(', ')}) {\n${source}\nreturn { ${exported} };\n})`;
  return vm.runInThisContext(wrapped, { filename: 'Code.gs' })(...params.map((p) => globals[p]));
}
