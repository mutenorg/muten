// native-web: React Native libraries on the web (gluestack, Tamagui, NativeBase…) by convention. When the app has
// react-native-web installed, every `react-native` import is it, the `.web.*` files a library ships win, and the
// globals React Native code expects exist. No config: installing react-native-web is the switch.
import type { BuildOptions } from 'esbuild';
import { packageDir } from '#engine/project/theme-library.js';

const WEB_FIRST = ['.web.tsx', '.web.ts', '.web.jsx', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.mjs', '.css', '.json'];

/** What a bundle adds for React Native libraries, or nothing when the app has no react-native-web. */
export function nativeWebOptions(appRoot: string, dev = false): Pick<BuildOptions, 'alias' | 'resolveExtensions' | 'loader' | 'define'> {
  if (!packageDir(appRoot, 'react-native-web')) return {};
  return {
    alias: { 'react-native': 'react-native-web' },
    resolveExtensions: WEB_FIRST,
    loader: { '.js': 'jsx' },   // React Native packages often ship JSX in .js files
    define: { __DEV__: dev ? 'true' : 'false', global: 'globalThis' },
  };
}
