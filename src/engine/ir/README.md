# ir — IR transforms & validation

The middle of the pipeline: it reshapes the parser's nested IR into the canonical flat `Doc` that
gets validated, mutated and compiled.

| File | What it does |
|---|---|
| `compose.ts` | Inlines every part instance with its tree, substituting `$param`s with the call args. Parts **disappear** at build time, so the IR stays flat and all-primitives (composition, not runtime components). Substitution is explicit per value shape — no generic `any`. |
| `flatten.ts` | Nested authoring tree → **flat `Doc`, addressable by id** (`n1`, `n2`, … in pre-order). Mutations happen on the flat doc by id; it is the only thing validated and compiled. |
| `validate.ts` | Structured diagnostics over the `Doc`. Because it knows the whole vocabulary (types, tokens, ops, parts) **and** `each`-item scope, every error is specific and proposes the closest candidate. |
