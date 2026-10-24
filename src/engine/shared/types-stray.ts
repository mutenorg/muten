// types-stray: a name a part does not declare, marked by compose and said by validate (ir/part-params.ts).

/** A name a part's call or a part's body uses that the part does not declare: an argument, or a `$name`. */
export interface Stray {
  code: string;          // unknown-arg | unknown-param
  word: string;          // as written: `puased`, `$oepn`
  near: string | null;   // the parameter it most likely meant
  part: string;
  params: string[];
}
