# Publishing `@muten/core`

`@muten/core` is on the public npm registry. `prepare` builds `dist/` before a publish, and `files` ships `dist` +
`spec` + `README` + `LICENSE`. A registry refuses to overwrite a version: bump `version` in `package.json` first.

## A release, in order

1. **The engine** (from `muten/`):

   ```sh
   npm test          # the whole list in package.json, green
   npm publish
   ```

2. **The scaffolder** (from `create-muten/`), when it changed. Its `template/package.json` asks for
   `"@muten/core": "^0.0.X"`: on a 0.0.x version a caret is that exact version, so point it at the engine just
   published, or every new app installs an older muten than the docs it ships describe.

   ```sh
   node test/combos.mjs
   npm publish
   ```

3. **The editor extension** (from `muten-vscode/`): `node sync-engine.mjs` copies the engine in, then
   `npm run package` makes the `.vsix`.

4. **The apps** that use the published engine move to it one by one (`npm i @muten/core@0.0.X`), each checked with
   its own suite. The ones linked by path (`toma`, `candhrly`, `plugins/playground`) already run the workspace's.
