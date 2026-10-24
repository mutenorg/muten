// param-types: what an action or a part says it takes is a type. A state's type was checked; a parameter's was not, so
// `action go(v: txet)` or `part Box(title: txet)` passed and typed nothing. A parameter takes what a state takes, a bare
// `list`, an `action` (a part's callback), or an entity declared anywhere in the app (a part may take a store's `Service`).

import { Kw } from '#engine/shared/vocab.js';
import { closest, diag } from '#engine/shared/diagnostics.js';
import { SCALARS } from '#engine/ir/validate-schema.js';
import type { PartParam } from '#engine/shared/types.js';
import type { Found } from '#engine/project/place.js';

const LIST = 'list';

/** Who declares parameters: an action or a part, in a file. */
export interface ParamOwner { file: string; where: string; params: PartParam[] }

/** A finding for each parameter whose type is no type, with the nearest one. */
export function paramTypeDiagnostics(owners: ParamOwner[], entities: ReadonlySet<string>): Found[] {
  const element = (type: string): boolean => SCALARS.includes(type) || entities.has(type);
  const known = (type: string): boolean => element(type) || type === LIST || type === Kw.Action || (type.startsWith(LIST + '<') && type.endsWith('>') && element(type.slice(LIST.length + 1, -1)));
  const near = [...SCALARS, LIST, Kw.Action, ...entities];
  return owners.flatMap((owner) => owner.params.filter((param) => param.type && !known(param.type)).map((param) => {
    const word = param.type.startsWith(LIST + '<') ? param.type.slice(LIST.length + 1, -1) : param.type;
    return { file: owner.file, ...diag('unknown-type', `${owner.where} "${param.name}": "${word}" is not a type. Use a scalar (${SCALARS.slice(0, 5).join(', ')}…), \`list\`, an entity, or \`action\` for a callback.`, { suggestion: closest(word, near), from: word }) };
  }));
}
