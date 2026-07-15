// `muten android` — the .apk toolchain preflight. The two bug-prone halves are pure on purpose (parsing a
// `java -version` banner, and judging the major), so every branch runs here without a JVM, an SDK or a spawn.
// These cases are the ones that mattered in practice: a TOO-NEW JDK fails as hard as a missing one, and the
// legacy "1.8.0" banner reports its major in a different position.
// from dist/, not src/: android.ts is CLI tooling, not engine, so it has no `#engine/*` alias — and `npm test`
// builds before it runs, so this is the same file the CLI itself loads.
import { parseJavaMajor, jdkVerdict, sdkVerdict } from '../dist/android.js';

let fails = 0;
const check = (label: string, ok: boolean, extra = '') => {
  console.log(`${ok ? '✓' : 'x'} ${label}${ok ? '' : '   ← ' + extra}`);
  if (!ok) fails++;
};

// banner -> major. The real thing prints this to stderr; these are verbatim from real JDKs.
{
  check('modern banner', parseJavaMajor('openjdk version "21.0.5" 2024-10-15') === 21);
  check('oracle banner', parseJavaMajor('java version "25.0.1" 2025-10-21 LTS') === 25);
  check('legacy 1.8.0 -> 8', parseJavaMajor('java version "1.8.0_431"') === 8, String(parseJavaMajor('java version "1.8.0_431"')));
  check('no banner (java absent)', parseJavaMajor('') === undefined);
  check('junk is not a version', parseJavaMajor('bash: java: command not found') === undefined);
}

// major -> verdict. 17..21 is the Android Gradle Plugin's range in the generated project.
{
  check('21 ok', jdkVerdict(21).ok);
  check('17 ok (lower bound)', jdkVerdict(17).ok);
  check('16 too old', !jdkVerdict(16).ok);
  check('8 too old', !jdkVerdict(8).ok);
  check('22 too new (just over)', !jdkVerdict(22).ok);
  check('25 too new', !jdkVerdict(25).ok);
  check('missing is not ok', !jdkVerdict(undefined).ok);
  // a wrong JDK must say what to RUN, not just what is wrong — that's the whole point over Gradle's own error.
  check('too-new carries a fix', jdkVerdict(25).fix.length > 0);
  check('missing carries a fix', jdkVerdict(undefined).fix.length > 0);
  check('ok carries no fix', jdkVerdict(21).fix.length === 0);
}

// the per-OS install line. The whole point of this command is handing over a command that WORKS — a broken
// `brew` line is worse than saying nothing — and a mac/linux user must not be told to run `winget`.
{
  const fixFor = (os: string) => jdkVerdict(25, os).fix.join(' ');
  check('win32 -> winget', fixFor('win32').includes('winget install Microsoft.OpenJDK.21'));
  check('darwin -> brew', fixFor('darwin').includes('brew install --cask temurin@21'));
  check('linux -> apt', fixFor('linux').includes('openjdk-21-jdk'));
  check('unknown OS -> download page', fixFor('freebsd').includes('https://adoptium.net'));
  check('mac is never told to winget', !fixFor('darwin').includes('winget'));
  check('linux is never told to brew', !fixFor('linux').includes('brew'));
}

// sdk path -> verdict
{
  check('sdk found', sdkVerdict('/home/me/Android/Sdk').ok);
  check('sdk missing', !sdkVerdict(undefined).ok);
  check('missing sdk carries a fix', sdkVerdict(undefined).fix.length > 0);
}

console.log(fails ? `\n${fails} FAILED` : '\nALL OK');
process.exit(fails ? 1 : 0);
