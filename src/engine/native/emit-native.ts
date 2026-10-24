// emit-native: a page as a React Native screen module, for the Expo app the native output writes (native-project.ts).
// The page's logic is the same code the web module runs (state, gets, actions, effects, the built-ins it calls); it
// runs once per screen inside useMuten, in a muten root that is let go when the screen leaves, and hands back the
// function that draws the screen. The runtime it imports is muten's own signals (`virtual:muten/runtime`, mapped by
// the generated metro.config.js), and the drawing kit is native-kit/native.jsx.
import type { EmitParts } from '#engine/shared/types-compile.js';
import type { RnStyle } from '#engine/shared/types-native.js';
import { prelude, runtimeImport, dataImport } from '#engine/compile/emit.js';
import { VIEW } from '#engine/native/units.js';
import { CODE } from '#engine/native/motion.js';

/** `"__view:h:46"` (a vh/vw length, from units.ts) → 46 % of the window's height, read when the app starts. */
function viewLengths(json: string): string {
  return json.replace(new RegExp(`"${CODE}(?:[^"\\\\]|\\\\.)*"`, 'g'), (whole: string) => String(JSON.parse(whole)).slice(CODE.length)).replace(new RegExp(`"${VIEW}([hw]):(-?[\\d.]+)"`, 'g'), (_whole, side: string, share: string) => `Math.round(__window.${side === 'h' ? 'height' : 'width'} * ${Number(share) / 100})`);
}

/** The screen module of a page. */
export function emitNative(parts: EmitParts, jsx: string, styles: { [name: string]: RnStyle }): string {
  const body = [parts.paramDecls, parts.stateDecls, parts.getDecls, parts.actionDecls, parts.effectDecls, jsx].join('\n');
  const pre = prelude(parts, body, true);
  // @refresh reset: the screen's logic runs once (useMuten), so a Fast Refresh that kept its state would keep the old
  // code too. On every edit the screen mounts again with the new one
  return `// @refresh reset
import React from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, Dimensions } from 'react-native';
import { Image } from 'expo-image';
import { SafeAreaView } from 'react-native-safe-area-context';
${jsx.includes('<SvgXml') ? "import { SvgXml } from 'react-native-svg';\n" : ''}${/Animated\.|AnimatedPressable/.test(jsx) ? "import Animated, { cubicBezier, steps } from 'react-native-reanimated';\n" : ''}
import { useLocalSearchParams${jsx.includes('<Stack ') ? ', Stack' : ''} } from 'expo-router';
import { useMuten, R, Field, Check, go, Grid, Cell, liveStyle, screen as __screen } from '../muten/native';
${runtimeImport(pre + body)}${dataImport(pre)}${parts.storeImports}
${parts.externImports}

${jsx.includes('AnimatedPressable') ? 'const AnimatedPressable = Animated.createAnimatedComponent(Pressable);\n' : ''}const __window = Dimensions.get('window');   // vh and vw: a share of the window when the app starts
const S = StyleSheet.create(${viewLengths(JSON.stringify(styles, null, 2))});

export default function Screen() {
  const __params = useLocalSearchParams();
  const view = useMuten(() => {
    ${pre}

    ${parts.paramDecls}

    ${parts.stateDecls}

    ${parts.getDecls}

    ${parts.actionDecls}

    ${parts.effectDecls}

    return () => (
${jsx}
    );
  });
  return view();
}
`;
}
