// bundle-options: what every bundle of the app (dev, `muten bundle`, `muten build`'s use-bundle) adds to esbuild for
// the libraries it uses: React Native libraries on the web (native-web.ts), and with `islands { react "preact" }`,
// React itself swapped for preact/compat in every island: the same components, about 4 KB gz instead of React's 45.
// Most React libraries run on it; one that reaches into React's internals does not, which is why it is a choice.
import type { BuildOptions } from 'esbuild';
import { nativeWebOptions } from '#engine/project/native-web.js';
import { readMutenConfig } from '#engine/project/config.js';

const PREACT: { readonly [from: string]: string } = {
  react: 'preact/compat', 'react-dom': 'preact/compat', 'react-dom/client': 'preact/compat/client',
  'react/jsx-runtime': 'preact/jsx-runtime', 'react/jsx-dev-runtime': 'preact/jsx-runtime', 'react-dom/test-utils': 'preact/test-utils',
};

/** Whether the app runs its React islands on Preact. */
export function usesPreact(appRoot: string): boolean {
  try { return readMutenConfig(appRoot).islands?.react === 'preact'; } catch { return false; }   // a broken muten.config is check's to say
}

/** The esbuild options for the app's libraries. */
export function libraryOptions(appRoot: string, dev = false): Pick<BuildOptions, 'alias' | 'resolveExtensions' | 'loader' | 'define'> {
  const nativeWeb = nativeWebOptions(appRoot, dev);
  if (!usesPreact(appRoot)) return nativeWeb;
  return { ...nativeWeb, alias: { ...nativeWeb.alias, ...PREACT } };
}
