// Preflight for the Android target. muten does NOT build the .apk — Capacitor generates the Gradle project and
// Gradle compiles it — but muten is what OFFERED the target (`create-muten --android`), so it owns telling you
// whether this machine can actually build one, and exactly what to run when it can't. Gradle's own failure for a
// wrong JDK is "Unsupported class file major version 69", which sends you to a search engine; this sends you to
// a command.
//
// Bare `muten android` only detects and instructs. `--install` is opt-in and does the whole thing, hermetically:
// everything lands in ~/.muten and the project is pointed at it via local.properties / gradle.properties, so
// `gradlew` needs no env vars and `rm -rf ~/.muten` is a full uninstall. Nothing touches PATH, the registry, or
// the JDKs already on the machine. `sdkmanager --licenses` is interactive by design, so --install answering it is
// the user's own consent — which is why it is a flag you type and not something that happens to you.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { bundle } from './runner.js';

// muten-managed toolchain: everything --install downloads lives HERE and nowhere else. No PATH, no registry, no
// admin — `rm -rf ~/.muten` undoes the whole thing. The doctor looks here too, so an --install'd machine reports
// ready without the user exporting anything.
const MUTEN_HOME = join(homedir(), '.muten');
const MANAGED_SDK = join(MUTEN_HOME, 'android-sdk');
const MANAGED_JDK = join(MUTEN_HOME, 'jdk-21');

/** One toolchain requirement: what we looked for, what we found, and the exact way to fix it. */
export interface Requirement {
  name: string;
  ok: boolean;
  found: string;
  fix: string[];
}

// Capacitor 8's generated project targets JDK 21 (that's the Android Gradle Plugin's range, NOT Gradle's own —
// Gradle 8.14 itself runs on up to 24). A NEWER JDK breaks just as hard as a missing one, which is the trap
// nobody expects and the reason this command exists.
const JDK_MIN = 17;
const JDK_MAX = 21;

// Per-OS install lines. Keyed by process.platform; anything unlisted falls back to the download page.
const JDK_INSTALL: { [os: string]: string } = {
  win32: 'winget install Microsoft.OpenJDK.21',
  darwin: 'brew install --cask temurin@21',
  linux: 'sudo apt install openjdk-21-jdk      (or your distro\'s equivalent)',
};
const JDK_PAGE = 'https://adoptium.net/temurin/releases/?version=21';
const SDK_PAGE = 'https://developer.android.com/studio';

/** The major out of a `java -version` banner. Old JDKs report "1.8.0", modern ones "21.0.1". Pure: the whole
 *  reason this is split from the spawn is so it can be tested without a JVM on the machine. */
export function parseJavaMajor(banner: string): number | undefined {
  const match = /version "(\d+)(?:\.(\d+))?/.exec(banner);
  if (!match) return undefined;
  const first = Number(match[1]);
  return first === 1 ? Number(match[2]) : first; // "1.8.0" -> 8, "21.0.1" -> 21
}

/** A JDK home's `bin/java`, or bare `java` to mean "whatever is on the PATH". */
const javaBin = (home: string | undefined): string =>
  home ? join(home, 'bin', platform() === 'win32' ? 'java.exe' : 'java') : 'java';

function majorOf(home: string | undefined): number | undefined {
  // With a home we exec the absolute path and must NOT use a shell: the usual home is under "Program Files", and
  // cmd splits an unquoted path at the space. Bare `java` needs the shell to resolve java.exe off the PATH.
  const run = spawnSync(javaBin(home), ['-version'], { encoding: 'utf8', shell: !home && platform() === 'win32' });
  if (run.error || run.status !== 0) return undefined;
  return parseJavaMajor(`${run.stderr ?? ''}${run.stdout ?? ''}`);
}

/** The JDK home Gradle will ACTUALLY use, mirroring Gradle's own resolution order EXACTLY:
 *  `org.gradle.java.home` (the project's gradle.properties) > JAVA_HOME > the PATH.
 *  Get this order wrong and the doctor reports a JDK Gradle isn't going to use — saying "can't build" about a
 *  build that works, which is worse than saying nothing. Ours is a last resort, only if nothing else answers. */
function jdkHome(root?: string): string | undefined {
  const wired = root ? readProperty(join(root, 'android', 'gradle.properties'), 'org.gradle.java.home') : undefined;
  if (wired) return wired;
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  // A PATH java only settles it if Gradle could actually USE it — "there is a java" isn't the question, "is there
  // a java that builds" is. An out-of-range one (the JDK 25 everybody has) loses to the managed one, which
  // --install put there and --build wires into gradle.properties before Gradle ever runs.
  const onPath = majorOf(undefined);
  if (onPath !== undefined && onPath >= JDK_MIN && onPath <= JDK_MAX) return undefined;
  return existsSync(javaBin(MANAGED_JDK)) ? MANAGED_JDK : undefined;
}

function javaMajor(root?: string): number | undefined {
  return majorOf(jdkHome(root));
}

/** The SDK is wherever ANDROID_HOME says, the one --install put in ~/.muten, or where Android Studio installs it. */
function androidSdk(): string | undefined {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    MANAGED_SDK,
    platform() === 'win32' ? join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk')
      : platform() === 'darwin' ? join(homedir(), 'Library', 'Android', 'sdk')
        : join(homedir(), 'Android', 'Sdk'),
  ];
  return candidates.find((dir): dir is string => !!dir && existsSync(join(dir, 'platforms')));
}

/** Judge a JDK major. Pure, so every branch is checkable without installing eight JDKs — and `os` is a parameter
 *  so the per-OS install line is checkable without three machines. */
export function jdkVerdict(major: number | undefined, os: string = platform()): Requirement {
  const install = JDK_INSTALL[os];
  const fix = [install ?? `Download a JDK ${JDK_MAX}: ${JDK_PAGE}`];
  if (major === undefined) return { name: 'JDK', ok: false, found: process.env.JAVA_HOME ? 'JAVA_HOME is set but has no working bin/java' : 'not found on PATH', fix };
  if (major > JDK_MAX) return {
    name: 'JDK',
    ok: false,
    found: `${major} — too new (the generated Android project targets ${JDK_MAX}; it fails before compiling)`,
    fix: [...fix, 'then point JAVA_HOME at it — a newer JDK on PATH still wins otherwise'],
  };
  if (major < JDK_MIN) return { name: 'JDK', ok: false, found: `${major} — too old (need ${JDK_MIN}–${JDK_MAX})`, fix };
  return { name: 'JDK', ok: true, found: String(major), fix: [] };
}

/** Judge an SDK path (undefined = not found anywhere). Pure. */
export function sdkVerdict(sdk: string | undefined): Requirement {
  if (sdk) return { name: 'Android SDK', ok: true, found: sdk, fix: [] };
  return {
    name: 'Android SDK',
    ok: false,
    found: 'not found (looked at ANDROID_HOME, ANDROID_SDK_ROOT and the default location)',
    fix: [
      `Install Android Studio — it ships the SDK and a matching JDK: ${SDK_PAGE}`,
      'Open it once so it downloads the SDK, then re-run this. No IDE needed after that.',
    ],
  };
}

// ── --install ────────────────────────────────────────────────────────────────
// Every step below was found by doing it by hand once; the comments mark where it bites.

// Adoptium resolves "latest 21 GA" server-side, so this URL carries no version to chase.
const jdkUrl = (): string => {
  const os = platform() === 'win32' ? 'windows' : platform() === 'darwin' ? 'mac' : 'linux';
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  return `https://api.adoptium.net/v3/binary/latest/21/ga/${os}/${arch}/jdk/hotspot/normal/eclipse`;
};
// Google's zip DOES carry a build number, and it is the one thing here that rots. When this 404s, bump the number
// (the current one is listed on https://developer.android.com/studio#command-line-tools-only).
const CMDLINE_TOOLS_BUILD = '13114758';
const sdkToolsUrl = (): string => {
  const os = platform() === 'win32' ? 'win' : platform() === 'darwin' ? 'mac' : 'linux';
  return `https://dl.google.com/android/repository/commandlinetools-${os}-${CMDLINE_TOOLS_BUILD}_latest.zip`;
};

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed (HTTP ${res.status}): ${url}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

/** Node ships no unzip, so this shells out — and the choice per OS matters: on Windows `tar` may resolve to Git
 *  Bash's GNU tar, which cannot read a zip at all ("does not look like a tar archive"). PowerShell always can. */
function extract(archive: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  const run = archive.endsWith('.tar.gz')
    ? spawnSync('tar', ['-xzf', archive, '-C', dest], { encoding: 'utf8' })
    : platform() === 'win32'
      ? spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dest}' -Force`], { encoding: 'utf8' })
      : spawnSync('unzip', ['-q', '-o', archive, '-d', dest], { encoding: 'utf8' });
  if (run.error || run.status !== 0) throw new Error(`extract failed: ${run.stderr || run.error?.message || 'unknown'}`);
}

/** The single directory an archive unpacked into (Adoptium's root is versioned, e.g. `jdk-21.0.11+10`). */
const soleDir = (parent: string): string =>
  join(parent, readdirSync(parent, { withFileTypes: true }).filter((e) => e.isDirectory())[0]?.name ?? '');

async function installJdk(): Promise<void> {
  if (majorOf(MANAGED_JDK) === 21) { console.log('  ✓ JDK 21 already in ~/.muten — skipping'); return; }
  const tmp = join(MUTEN_HOME, platform() === 'win32' ? 'jdk.zip' : 'jdk.tar.gz');
  const staging = join(MUTEN_HOME, 'jdk-staging');
  console.log('  · JDK 21 (~200MB) from Adoptium…');
  mkdirSync(MUTEN_HOME, { recursive: true });
  await download(jdkUrl(), tmp);
  rmSync(staging, { recursive: true, force: true });
  extract(tmp, staging);
  rmSync(MANAGED_JDK, { recursive: true, force: true });
  spawnSync(platform() === 'win32' ? 'cmd' : 'mv', platform() === 'win32'
    ? ['/c', 'move', soleDir(staging), MANAGED_JDK] : [soleDir(staging), MANAGED_JDK], { encoding: 'utf8' });
  rmSync(staging, { recursive: true, force: true });
  rmSync(tmp, { force: true });
  const got = majorOf(MANAGED_JDK);
  if (got !== 21) throw new Error(`unpacked a JDK but it reports major ${got ?? '?'}`);
  console.log('  ✓ JDK 21');
}

async function installSdk(): Promise<void> {
  const sdkmanager = join(MANAGED_SDK, 'cmdline-tools', 'latest', 'bin', platform() === 'win32' ? 'sdkmanager.bat' : 'sdkmanager');
  if (!existsSync(sdkmanager)) {
    const tmp = join(MUTEN_HOME, 'cmdline-tools.zip');
    console.log('  · Android command-line tools…');
    mkdirSync(MANAGED_SDK, { recursive: true });
    await download(sdkToolsUrl(), tmp);
    rmSync(join(MANAGED_SDK, 'cmdline-tools'), { recursive: true, force: true });
    extract(tmp, MANAGED_SDK);
    rmSync(tmp, { force: true });
    // sdkmanager REFUSES to run unless it sits in cmdline-tools/latest/ — the zip unpacks one level too high.
    const unpacked = join(MANAGED_SDK, 'cmdline-tools');
    const latest = join(unpacked, 'latest');
    const staged = join(MUTEN_HOME, 'cmdline-staging');
    rmSync(staged, { recursive: true, force: true });
    spawnSync(platform() === 'win32' ? 'cmd' : 'mv', platform() === 'win32'
      ? ['/c', 'move', unpacked, staged] : [unpacked, staged], { encoding: 'utf8' });
    mkdirSync(unpacked, { recursive: true });
    spawnSync(platform() === 'win32' ? 'cmd' : 'mv', platform() === 'win32'
      ? ['/c', 'move', staged, latest] : [staged, latest], { encoding: 'utf8' });
    if (!existsSync(sdkmanager)) throw new Error('cmdline-tools unpacked but sdkmanager is missing');
  }
  // sdkmanager runs ON java, so it needs a JDK too — hand it the one we control.
  const env = { ...process.env, JAVA_HOME: existsSync(javaBin(MANAGED_JDK)) ? MANAGED_JDK : process.env.JAVA_HOME };
  const sdkmanagerRun = (args: string[], input?: string) =>
    spawnSync(sdkmanager, [`--sdk_root=${MANAGED_SDK}`, ...args], { encoding: 'utf8', env, input, shell: platform() === 'win32' });

  console.log('  · accepting the Android SDK licences (this is Google\'s agreement — you asked for --install)');
  sdkmanagerRun(['--licenses'], 'y\n'.repeat(50)); // interactive by design: the y's are the answer --install stands for
  console.log('  · platform-36 + build-tools + platform-tools (~600MB)…');
  const packages = sdkmanagerRun(['platforms;android-36', 'build-tools;36.0.0', 'platform-tools']);
  if (packages.status !== 0) throw new Error(`sdkmanager failed:\n${(packages.stderr || packages.stdout || '').slice(-600)}`);
  if (!existsSync(join(MANAGED_SDK, 'platforms'))) throw new Error('sdkmanager reported success but installed no platform');
  console.log('  ✓ Android SDK');
}

/** Point THIS app's Gradle at the managed toolchain, so `./gradlew` works with no env vars set. `local.properties`
 *  (sdk.dir) is Android's own mechanism — Android Studio writes the same file; `org.gradle.java.home` is Gradle's.
 *  Both live in the generated `android/`, which is gitignored, so this is re-run after every `android:init`. */
function wireProject(root: string): boolean {
  const androidDir = join(root, 'android');
  if (!existsSync(androidDir)) return false;
  const sdk = androidSdk();
  if (sdk) setProperty(join(androidDir, 'local.properties'), 'sdk.dir', sdk);
  const jdk = existsSync(javaBin(MANAGED_JDK)) ? MANAGED_JDK : undefined;
  if (jdk) setProperty(join(androidDir, 'gradle.properties'), 'org.gradle.java.home', jdk);
  return !!(sdk || jdk);
}

/** Set ONE key in a .properties file and preserve every other line. Capacitor's gradle.properties ships
 *  `android.useAndroidX=true` and a jvmargs tuning — overwrite the file and the build breaks somewhere that looks
 *  unrelated. Values are escaped the way .properties wants (`\` and `:`), which Windows paths are full of. */
function setProperty(file: string, key: string, value: string): void {
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const kept = previous.split(/\r?\n/).filter((line) => !line.startsWith(`${key}=`));
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  kept.push(`${key}=${value.replace(/\\/g, '\\\\').replace(/:/g, '\\:')}`, '');
  writeFileSync(file, kept.join('\n'));
}

/** Read a .properties value back, undoing the escaping. */
function readProperty(file: string, key: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, 'utf8').split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
  return line?.slice(key.length + 1).replace(/\\:/g, ':').replace(/\\\\/g, '\\').trim();
}

/** `muten android [--install|--build]` — ONE command, three modes. Not three commands: the default (diagnose) is
 *  what you want 90% of the time, and the other two are things you do to the thing it diagnosed. */
export async function androidCommand(root: string, args: string[]): Promise<boolean> {
  if (args.includes('--install')) return androidInstall(root);
  if (args.includes('--build')) return androidBuild(root);
  return androidDoctor(root);
}

/** Download and install the whole toolchain into ~/.muten. Returns true when the machine can build afterwards. */
async function androidInstall(root: string): Promise<boolean> {
  console.log('\n  muten android --install — a JDK 21 + the Android SDK, into ~/.muten\n');
  console.log('  Nothing touches your PATH, your registry or your existing JDKs: it all lands in one folder and');
  console.log('  `rm -rf ~/.muten` removes it. ~800MB.\n');
  try {
    await installJdk();
    await installSdk();
  } catch (e) {
    console.error(`\n  ✖ ${e instanceof Error ? e.message : String(e)}`);
    console.error('\n  Nothing was installed system-wide. Retry, or install by hand — `muten android` prints how.\n');
    return false;
  }
  if (wireProject(root)) console.log('  ✓ pointed android/ at it (local.properties + gradle.properties)');
  console.log('');
  return androidDoctor(root);
}

// ── --build ──────────────────────────────────────────────────────────────────

/** Run a command in `root`, streaming its output — these are the long ones (Gradle, sdkmanager) and a silent
 *  five-minute wait reads as a hang. Returns true on exit 0. */
function run(command: string, args: string[], root: string): boolean {
  // Windows needs all three of these at once: a .bat/.cmd only spawns through cmd (shell), cmd does NOT search the
  // cwd for a bare name (so the wrapper is passed absolute), and cmd splits an unquoted path at a space — hence
  // quoting an absolute command ourselves. Getting any one wrong reads as "'gradlew.bat' is not recognized".
  const win = platform() === 'win32';
  const spawnable = win && isAbsolute(command) ? `"${command}"` : command;
  const result = spawnSync(spawnable, args, { cwd: root, stdio: 'inherit', shell: win });
  return !result.error && result.status === 0;
}

/** The whole chain, in one command: toolchain → android/ → bundle → sync → Gradle → the .apk's path.
 *  It lives here rather than in an npm script for one concrete reason: the Gradle wrapper is `gradlew` on Windows
 *  and `./gradlew` everywhere else, and no single npm script spells both. Node knows the platform. */
async function androidBuild(root: string): Promise<boolean> {
  if (!existsSync(join(root, 'capacitor.config.json'))) {
    console.error('\n  ✖ No capacitor.config.json — this app has no Android target.');
    console.error('    Scaffold one with `npm create muten@latest <name> -- --android`.\n');
    return false;
  }
  if (!androidDoctor(root)) return false; // it already printed what's missing and how to get it

  const npx = platform() === 'win32' ? 'npx.cmd' : 'npx';
  if (!existsSync(join(root, 'android'))) {
    console.log('\n  · generating android/ (disposable — gitignored, regenerated any time)');
    if (!run(npx, ['cap', 'add', 'android'], root)) return false;
    wireProject(root); // `cap add` writes a fresh gradle.properties: re-point it or Gradle loses the JDK
  }
  console.log('\n  · muten bundle → dist/');
  await bundle(root); // in-process: we ARE muten — spawning `npx muten bundle` from inside muten is a second boot
  console.log('  · cap sync → the app\'s assets');
  if (!run(npx, ['cap', 'sync', 'android'], root)) return false;

  console.log('\n  · Gradle (first run downloads its own distribution — minutes, then seconds)\n');
  const gradlew = join(root, 'android', platform() === 'win32' ? 'gradlew.bat' : 'gradlew');
  if (!run(gradlew, ['assembleDebug'], join(root, 'android'))) {
    console.error('\n  ✖ Gradle failed. The output above is Gradle\'s own.\n');
    return false;
  }
  const apk = join(root, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  console.log(`\n  ✓ ${apk}`);
  console.log('\n  It is debug-signed, so it installs on any phone:');
  console.log('    adb install -r <that file>      (USB debugging on), or copy it across and open it.\n');
  return existsSync(apk);
}

/** Report whether this machine can build the .apk. Returns true when it can. */
function androidDoctor(root?: string): boolean {
  // Wire BEFORE measuring: `cap add android` regenerates android/ and wipes the wiring, so every run re-points it
  // — and the verdict must describe the world AFTER that, which is the world gradlew will actually run in.
  const wired = root ? wireProject(root) : false;
  const requirements = [jdkVerdict(javaMajor(root)), sdkVerdict(androidSdk())];
  console.log('\n  muten android — can this machine build an .apk?\n');
  for (const req of requirements) console.log(`  ${req.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✖\x1b[0m'} ${req.name.padEnd(12)} ${req.found}`);

  const missing = requirements.filter((req) => !req.ok);
  if (!missing.length && wired) console.log('\n  android/ points at this toolchain (local.properties + gradle.properties), so `gradlew` needs no env vars.');
  if (!missing.length) {
    console.log('\n  Ready. Build it:\n    npm run android:build');
    console.log(`    cd android && ${platform() === 'win32' ? 'gradlew' : './gradlew'} assembleDebug`);
    console.log('    -> android/app/build/outputs/apk/debug/app-debug.apk\n');
    return true;
  }
  console.log('\n  Not ready yet. Let muten do it — nothing leaves ~/.muten, and `rm -rf ~/.muten` undoes it:\n');
  console.log('    muten android --install\n');
  console.log('  Or by hand:\n');
  for (const req of missing) {
    console.log(`  ${req.name}:`);
    for (const line of req.fix) console.log(`    ${line}`);
  }
  console.log('\n  Or install nothing: push, and .github/workflows/apk.yml builds the .apk on a runner that already');
  console.log('  has the SDK — the file lands in the run\'s Artifacts. A local toolchain only buys you an emulator');
  console.log('  and offline iteration; for iterating on a real phone, `muten dev` already prints a /_qr page.\n');
  return false;
}
