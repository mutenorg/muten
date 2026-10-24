// coverage: every muten primitive and what the native output does with it, one table. The coverage test fails when a
// primitive is added to the language (vocab.ts) without a line here, so "how much of muten reaches the phone" is a
// number read from this table, never a guess. tree.ts takes its gap messages from it.
import { Nt } from '#engine/shared/vocab.js';
import type { ProfileNote } from '#engine/shared/types-native.js';

const drawn = (note = ''): ProfileNote => ({ level: 'exact', note });
const close = (note: string): ProfileNote => ({ level: 'approx', note });
const missing = (note: string): ProfileNote => ({ level: 'none', note });

export const PRIMITIVES: { readonly [type: string]: ProfileNote } = {
  [Nt.Page]: drawn('a ScrollView inside the safe area'),
  [Nt.Stack]: drawn('a View'), [Nt.Section]: drawn('a View'), [Nt.Header]: drawn('a View'), [Nt.Footer]: drawn('a View'),
  [Nt.Nav]: drawn('a View'), [Nt.Article]: drawn('a View'), [Nt.Sidebar]: drawn('a View'), [Nt.List]: drawn('a View'),
  [Nt.Row]: drawn('a View'), [Nt.Cell]: drawn('a View'),
  [Nt.Details]: close('drawn as a box, always open: opening and closing need a state and a `when`'),
  [Nt.Text]: drawn('a Text'), [Nt.Title]: drawn('a Text with the heading\'s size'), [Nt.Span]: drawn('a Text'),
  [Nt.Image]: drawn('expo-image; a fixed /path is packed from public/'),
  [Nt.Button]: drawn('a Pressable with its label'), [Nt.Link]: drawn('a Pressable that navigates (expo-router)'),
  [Nt.SearchField]: drawn('a TextInput bound to its state'), [Nt.Password]: drawn('a TextInput that hides what is typed'),
  [Nt.Textarea]: drawn('a multi-line TextInput'), [Nt.Number]: drawn('a TextInput with the number keyboard'),
  [Nt.Checkbox]: drawn('the kit\'s Check'),
  [Nt.Each]: drawn('a keyed map, redrawn alone'), [Nt.When]: drawn('drawn or not, alone'),
  [Nt.Icon]: drawn('the same SVG as the web (its Iconify set), drawn by react-native-svg at the CSS size or 1em, in the inherited color'),
  [Nt.Select]: missing('a list to pick from needs a native picker (next step): a row of Buttons does it today'),
  [Nt.Date]: missing('a date picker needs @react-native-community/datetimepicker (next step)'),
  [Nt.Range]: missing('a slider needs @react-native-community/slider (next step)'),
  [Nt.Form]: missing('a Form drawn from an entity: write its fields as standalone inputs'),
  [Nt.Table]: missing('a table: lay its rows out as Stack rows'),
  [Nt.DataTable]: missing('a data table: lay its rows out with `each`'), [Nt.RowAction]: missing('part of a DataTable'),
  [Nt.Video]: missing('video needs expo-video'), [Nt.Audio]: missing('sound needs expo-audio'),
  [Nt.File]: missing('picking files needs expo-document-picker'), [Nt.Canvas]: missing('a canvas needs a native drawing surface (Skia)'),
  [Nt.Custom]: missing('a Custom is JavaScript for the DOM: it needs its own native version (a .native.jsx beside it)'),
  [Nt.Chart]: missing('charts need react-native-svg (next step, with icons)'),
  [Nt.Svg]: missing('vector drawing needs react-native-svg'), [Nt.Rect]: missing('part of an Svg'), [Nt.Line]: missing('part of an Svg'),
  [Nt.Circle]: missing('part of an Svg'), [Nt.Path]: missing('part of an Svg'), [Nt.Group]: missing('part of an Svg'), [Nt.Arc]: missing('part of an Svg'),
  [Nt.Shell]: drawn('the app\'s frame, drawn around every route (app/_layout.jsx)'), [Nt.Layout]: missing('named layouts (`-> page in pro`) are not drawn on the phone yet'),
  [Nt.Slot]: drawn('the shell\'s outlet: expo-router\'s navigator'),
};
