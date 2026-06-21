# The `.muten` language

> The authoritative source of the **syntax**. The **vocabulary** (primitives, their props, the style
> tokens, the keywords) lives in the manifest ([`src/engine/lang/manifest.ts`](../src/engine/lang/manifest.ts))
> and the enums ([`src/engine/shared/vocab.ts`](../src/engine/shared/vocab.ts)) — the other half of the
> rules. From these derive the lexer/parser (`src/engine/lang/`), the validator (`src/engine/ir/`), and
> the editor's highlight + autocomplete. **Changing the language = changing these rules + the vocabulary.**

## 1. Lexical (tokens)

```
comment     = "#" … (to end of line)              # ignored
string      = '"' … '"'
ref         = "@" ident                           # a state reference:      @users
param       = "$" ident                           # a part-param reference: $title
number      = "-"? digit+ ( "." digit+ )?
ident       = (letter | "_") (letter | digit | "_")*
operators   = "->"  "<-"  "=>"  "=="  "!="  "<="  ">="
punctuation = { } ( ) [ ] , | : = < > . / + * ? -
```

## 2. File structure

A file is a sequence of top-level declarations, in any order:

```
file        = declaration* ;
declaration = screen | entity | state | store | get | effect | const | theme
            | action | mock | sources | routes | shell | part | node ;
```

- A **page** (`src/pages/<route>/<route>.muten`): `screen` + state/entity/action/const/… + one **root node** (the tree).
- The **app root** (`src/app.muten`): `routes` (+ an optional persistent `shell`).
- A **store slice** (`*.store`): `store` / `get` / `action` / `effect` — app-global state, no tree.
- A **part** (`src/**/parts/*.muten`): `part` (+ its own entity/state/mock, *hoisted* when used).
- The **theme** (`theme.muten`): a single `theme` block (the token scale).

## 3. Declarations

```
screen   = "screen" ident ;

entity   = "entity" ident "{" field* "}" ;            # implicit `id uuid`
field    = ident type constraint* ;                   # `role admin | member` = enum
type     = ident ( "<" ident ">" )? ;                 # text|number|bool|email|uuid | EntityName | list<T>
constraint = "required" | "min" ":" number | "max" ":" number ;

state    = "state" "{" binding* "}" ;                 # `store { … }` is identical, but app-global
binding  = ident "=" ( "query" ident | value ) ":" type ;   # query → async { data, loading, error }

get      = "get" ident "=" expr ;                     # .store derived/memoized value
effect   = "effect" actionBody ;                      # .store reactive side-effect
const    = "const" ident "=" scalar ;                 # compile-time immutable (scalars only)

action     = "action" ident "mutates" ident ( "," ident )* "<-" ident actionBody ;
actionBody = "{" statement* "}" ;
statement  = ident "." "push"  "(" expr ")"
           | ident "." "set"   "(" expr ")"
           | ident "." "reset" "(" ")"
           | ident "." "remove" "(" ident "=>" expr ")"
           | "if" expr actionBody ( "else" actionBody )? ;

mock     = "mock"    "{" ( ident ":" value )* "}" ;
sources  = "sources" "{" ( ident ":" value )* "}" ;   # value = "url"  or  { url: "…", at: "…" }
value    = scalar | array | object ;
scalar   = string | number | "true" | "false" | "null" | ident ;   # a bare ident = an enum value
array    = "[" ( value ( "," value )* )? "]" ;
object   = "{" ( ( ident | string ) ":" value ( "," … )* )? "}" ;

routes   = "routes" "{" route* "}" ;                  # one route per line
route    = path "->" ident ( "guard" "not"? dotted "else" path )? ;
path     = ( "/" ident? )+ ;                          # /  ·  /cart  ·  /

shell    = "shell" "{" node* "}" ;                    # persistent chrome; must contain a `slot`
theme    = "theme" "{" ( ident "{" ( ident string )* "}" )* "}" ;   # space { md "16px" } …
part     = "part" ident "(" ( param ( "," param )* )? ")" "{" node* "}" ;
param    = ident ":" type ;
```

## 4. Expressions

Used in `when` / `each` conditions, `if`, `get`, and `{ }` string interpolation. Precedence, lowest
binding first (each level parses the level below, then folds left while its operator keeps appearing):

```
expr     = ternary ;
ternary  = or ( "?" ternary ":" ternary )? ;
or       = and ( "or" and )* ;
and      = cmp ( "and" cmp )* ;
cmp      = add ( ( "==" | "!=" | "<" | ">" | "<=" | ">=" | "contains" ) add )* ;
add      = mul ( ( "+" | "-" ) mul )* ;
mul      = unary ( ( "*" | "/" ) unary )* ;
unary    = "not" unary | primary ;
primary  = "(" ternary ")" | string | number | "true" | "false" | "null" | refName ;
refName  = ( ident | param ) ( "." ident )* ;        # user.name · cart.total · $item.field
```

`contains` is list-membership OR case-insensitive substring (one operator, both meanings).

## 5. Nodes (the UI tree)

```
node         = control | primitive | partInstance ;
control      = "when" expr "{" node* "}"
             | "each" expr "as" ident "{" node* "}" ;
primitive    = TYPE nodePart* block? ;                # TYPE ∈ manifest PRIMITIVES
partInstance = ident "(" ( ident ":" argValue ( "," … )* )? ")" ;   # ident is NOT a primitive
argValue     = string | number | ref | param | dotted ;

nodePart  = positional | "->" target | modifier | level ;
positional = string | ref | param ;                  # → the primitive's string-prop / `data`
target     = path                                     # Link -> /route
           | dotted ( "(" expr? ")" )? ;              # action -> add(arg)
level     = "h1" | "h2" | … | "h6" ;                  # Title only (heading level, not style)
modifier  = "bind" ( ref | dotted )                   # bind @draft  ·  bind cart.query
          | "submit" dotted
          | "where"   "(" clause* ")"                 # where(role == admin, name contains @q)
          | "columns" "(" ident* ")"
          | "style"   "(" token* ")"                  # analyzable layout/typography tokens
          | "class"   "(" ( string | ident )* ")"     # raw look classes (your CSS / Tailwind)
          | "alt" string                              # Image (required, a11y/SEO)
          | "inputs" "(" arg* ")" | "on" "(" arg* ")" ;   # Custom
block     = "{" node* "}" ;
```

- A **style token** is `family.step` or an atom, with an optional breakpoint prefix: `cols.3`, `gap.md`,
  `padding.x.lg`, `md:cols.4`. Shapes come from the engine; the step values come from `theme.muten`.
- A positional string **interpolates** `{expr}` on Text/Title/Span/Image/Button/Link.

**Disambiguation:** if `(` comes right after the `TYPE`, it's a **part instance**; otherwise it's a
**primitive** with its parts. Primitives never take `(args)` after the name.

## 6. From rules to IR

- A node → `{ type, props, children?, loc }`; a part instance → `{ type, args, loc }`.
- The positional string is assigned to the prop named by the manifest's `string` for that primitive.
- `compose` inlines part instances (substituting `$param` with the args) **before** `flatten`, so the
  part disappears and a tree of primitives remains; `flatten` numbers it into the flat `Doc`.
- `validate` requires: known types/parts, declared `@refs`, accepted style tokens, required props, and
  actions that mutate only what `mutates` declares.

## 7. One source, many tools

```
        these rules  +  the manifest (vocabulary)  +  vocab (tokens · keywords)
                                  │
     ┌────────────┬──────────────┼──────────────┬───────────────┐
  lexer/parse   validate      highlight        linter         autocomplete
   (lang/)        (ir/)      (extension)      (project/)        (project/)
```

Everything reads the same two sources. Adding a primitive, a token or a keyword = edit the manifest /
vocab (and its codegen in `compile/`); the parser, validator and editor stay consistent on their own.
