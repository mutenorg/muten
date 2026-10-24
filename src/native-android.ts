// native-android: `muten native --android`, the native app on an Android emulator with nothing to set up. muten gets
// the emulator, a system image and adb into ~/.muten (downloaded straight from Google's repository, streamed: the same
// archives sdkmanager reads, at the speed of the line, where sdkmanager crawled at 0.1 MB/s), writes a virtual phone
// (no Java, no avdmanager), boots it with its window, waits for Android, and opens the app with Expo, which installs
// Expo Go on the phone by itself. The app's errors and the phone's own (logcat) come out in the same terminal, and
// `--screenshot <file>` saves what the screen shows, so a person and an agent see the same thing. Linux first.
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync, accessSync, constants, openSync, watch } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { printErrors, recordError, resetErrors, say } from './native-errors.js';
import { RESTART_METRO } from './native-project.js';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

const SDK = join(homedir(), '.muten', 'android-sdk');
const AVD_HOME = join(homedir(), '.android', 'avd');
const AVD = 'muten';
const API = 36;
const REPOSITORY = 'https://dl.google.com/android/repository/';
const IMAGES = `${REPOSITORY}sys-img/google_apis/`;
const BOOT_WAIT_MS = 240_000;
// the error lines that belong to the app (React Native, Expo, Hermes, a crash), among everything Android logs
const APP_SOURCES = /^[EF]\/(unknown:|ReactNative|AndroidRuntime|Expo|Hermes|FabricUIManager|ViewManager)/;
// of those, what is not a failure: React Native's own housekeeping as an app closes or reloads, and stack tails
// what Metro prints when the app's JavaScript fails: a render error, an uncaught throw, a module it cannot find
const METRO_ERROR = /\bERROR\b|Uncaught|Render Error|Invariant Violation|SyntaxError|TypeError|ReferenceError|Unable to resolve/;
const ANSI = /\x1b\[[0-9;]*m/g;
const REGEN_DELAY_MS = 600;   // a save (or a muten build, many files at once) settles before the app is written again
const MUTEN_DIST = dirname(fileURLToPath(import.meta.url));
const NOISE = /NoCrashSoftException|Unhandled SoftException|^\.\.\. \d+ more|ImagePipelineFactory has already|non-existent frame callback|Stopping surface|was stopped on SurfaceMountingManager|Unable to get the DevSupportManager|Skipping batch of MountItems/;

const adbPath = (): string => join(SDK, 'platform-tools', 'adb');
const emulatorPath = (): string => join(SDK, 'emulator', 'emulator');
const imageDir = (): string => join(SDK, 'system-images', `android-${API}`, 'google_apis', 'x86_64');

/** The archive of package `path` for this machine, from a repository manifest: its full URL. */
async function archiveUrl(manifest: string, base: string, path: string): Promise<string> {
  const xml = await (await fetch(manifest)).text();
  const blocks = xml.split('<remotePackage ').filter((block) => block.startsWith(`path="${path}"`));
  // the stable channel first (channel-0), and of its archives the one for Linux (or the one with no host)
  const stable = blocks.find((block) => /<channelRef ref="channel-0"\/>/.test(block)) ?? blocks[0];
  if (!stable) throw new Error(`${path} is not in ${manifest}`);
  const archives = stable.split('<archive>').slice(1);
  const mine = archives.find((archive) => /<host-os>linux<\/host-os>/.test(archive)) ?? archives.find((archive) => !/<host-os>/.test(archive));
  const url = mine && /<url>([^<]+)<\/url>/.exec(mine)?.[1];
  if (!url) throw new Error(`no archive of ${path} for this machine`);
  return url.startsWith('http') ? url : base + url;
}

/** Downloads `url` to `file`, streamed, saying how far it is. */
async function fetchTo(url: string, file: string, label: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status}): ${url}`);
  const total = Number(res.headers.get('content-length') || 0);
  const out = createWriteStream(file);
  const reader = res.body.getReader();
  let got = 0, shown = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (!out.write(value)) await new Promise((resolve) => out.once('drain', resolve));
    const percent = total ? Math.floor((got / total) * 100) : -1;
    if (percent >= 0 && percent >= shown + 10) { shown = percent; process.stdout.write(`\r  · ${label}: ${percent}% of ${Math.round(total / 1048576)} MB`); }
  }
  await new Promise((resolve) => out.end(resolve));
  process.stdout.write('\n');
}

/** Package `path` unpacked into `into` (its archive holds one folder, which becomes `name` there). */
async function install(manifest: string, base: string, path: string, into: string, name: string, label: string): Promise<void> {
  const url = await archiveUrl(manifest, base, path);
  const zip = join(SDK, `${name}.download.zip`);
  const staging = join(SDK, `${name}.staging`);
  mkdirSync(into, { recursive: true });
  await fetchTo(url, zip, label);
  rmSync(staging, { recursive: true, force: true });
  if (spawnSync('unzip', ['-q', '-o', zip, '-d', staging]).status !== 0) throw new Error(`could not unpack ${label} (is unzip installed? sudo apt install unzip)`);
  const inside = readdirSync(staging)[0];
  rmSync(join(into, name), { recursive: true, force: true });
  renameSync(join(staging, inside), join(into, name));
  rmSync(staging, { recursive: true, force: true });
  rmSync(zip, { force: true });
}

/** What the emulator needs, downloaded the first time only. */
async function ensureToolchain(): Promise<void> {
  if (!existsSync(adbPath())) await install(`${REPOSITORY}repository2-3.xml`, REPOSITORY, 'platform-tools', SDK, 'platform-tools', 'adb (platform-tools)');
  if (!existsSync(emulatorPath())) await install(`${REPOSITORY}repository2-3.xml`, REPOSITORY, 'emulator', SDK, 'emulator', 'the Android emulator');
  if (!existsSync(join(imageDir(), 'system.img'))) await install(`${IMAGES}sys-img2-3.xml`, IMAGES, `system-images;android-${API};google_apis;x86_64`, join(SDK, 'system-images', `android-${API}`, 'google_apis'), 'x86_64', `Android ${API} (the phone's system)`);
}

/** The virtual phone, written as the emulator reads it (what avdmanager would write, without Java). */
function ensureAvd(): void {
  const dir = join(AVD_HOME, `${AVD}.avd`);
  if (existsSync(join(dir, 'config.ini'))) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(AVD_HOME, `${AVD}.ini`), `avd.ini.encoding=UTF-8\npath=${dir}\npath.rel=avd/${AVD}.avd\ntarget=android-${API}\n`);
  writeFileSync(join(dir, 'config.ini'), [
    `AvdId=${AVD}`, `avd.ini.displayname=muten phone`, 'abi.type=x86_64', 'hw.cpu.arch=x86_64', 'hw.cpu.ncore=4', 'hw.ramSize=4096',
    `image.sysdir.1=system-images/android-${API}/google_apis/x86_64/`, 'tag.id=google_apis', 'tag.display=Google APIs', 'PlayStore.enabled=false',
    'hw.lcd.width=1080', 'hw.lcd.height=2400', 'hw.lcd.density=420', 'hw.keyboard=yes', 'hw.gpu.enabled=yes', 'hw.gpu.mode=auto',
    'disk.dataPartition.size=6G', 'showDeviceFrame=no', 'fastboot.forceColdBoot=no',
  ].join('\n') + '\n');
}

const adb = (args: string[]): string => spawnSync(adbPath(), args, { encoding: 'utf8' }).stdout ?? '';
/** The emulator adb sees, ready, or ''. */
const runningEmulator = (): string => adb(['devices']).split('\n').map((line) => line.trim().split(/\s+/)).find((cols) => cols[0]?.startsWith('emulator-') && cols[1] === 'device')?.[0] ?? '';

/** The emulator running and Android booted: one already up, or a new one started (with its window). */
async function ensureBooted(): Promise<string> {
  const up = runningEmulator();
  if (up && adb(['-s', up, 'shell', 'getprop', 'sys.boot_completed']).trim() === '1') return up;
  try { accessSync('/dev/kvm', constants.R_OK | constants.W_OK); }
  catch { console.log('  ! /dev/kvm is not usable: the emulator will crawl. Turn it on: sudo usermod -aG kvm $USER, then log in again'); }
  console.log('  · starting the emulator (its window opens on your desktop)…');
  const log = openSync(join(homedir(), '.muten', 'emulator.log'), 'a');
  const child = spawn(emulatorPath(), ['-avd', AVD, '-no-boot-anim', '-no-snapshot-save'], { env: { ...process.env, ANDROID_SDK_ROOT: SDK, ANDROID_HOME: SDK }, detached: true, stdio: ['ignore', log, log] });
  child.unref();   // it keeps running after muten exits: the next `muten native --android` finds it up
  const started = Date.now();
  for (;;) {
    const serial = runningEmulator();
    if (serial && adb(['-s', serial, 'shell', 'getprop', 'sys.boot_completed']).trim() === '1') { console.log(`  ✓ Android is up (${Math.round((Date.now() - started) / 1000)} s)`); return serial; }
    if (Date.now() - started > BOOT_WAIT_MS) throw new Error(`the emulator did not boot in ${BOOT_WAIT_MS / 1000} s: see ~/.muten/emulator.log`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/** `muten native --screenshot <file>`: what the emulator's screen shows, as a PNG. */
export function nativeScreenshot(file: string): boolean {
  const png = screenPng();
  if (!png) { console.error(runningEmulator() ? '✖ the screen could not be read' : '✖ no emulator is running: muten native --android starts one'); return false; }
  writeFileSync(file, png);
  console.log(`✓ ${file}`);
  return true;
}

/** What the emulator's screen shows, as PNG bytes; null with no emulator. */
export function screenPng(): Buffer | null {
  const serial = runningEmulator();
  if (!serial) return null;
  const shot = spawnSync(adbPath(), ['-s', serial, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 });
  return shot.status === 0 && shot.stdout.length ? shot.stdout : null;
}

/** Opens a deep link on the emulator (an app route, through Expo Go). */
export function openOnPhone(url: string): boolean {
  const serial = runningEmulator();
  if (!serial) return false;
  adb(['-s', serial, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url]);
  return true;
}

/** `muten native --errors`: every error the running app has had since it opened, and what its screen shows now. */
export function nativeErrors(dir: string): boolean {
  if (runningEmulator()) nativeScreenshot(join(dir, 'screen.png'));
  return printErrors(dir);
}

/** While the app is open: the app written again on its own when its source or muten itself changes. The phone reloads
 *  the screens that changed (Fast Refresh), so nothing restarts. Each round runs in a fresh process, so a rebuilt muten
 *  is the one that writes it. */
function regenerateOnChange(root: string, dir: string, restartMetro: () => void): () => void {
  let timer: NodeJS.Timeout | undefined, busy = false, again = false;
  const round = (): void => {
    if (busy) { again = true; return; }
    busy = true;
    say(dir, '\n  · a change: writing the app again…\n');
    const child = spawn(process.execPath, [process.argv[1], 'native', root, '--regen'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk: Buffer) => say(dir, chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => say(dir, chunk.toString(), process.stderr));
    child.on('close', (code) => { busy = false; if (code === RESTART_METRO) restartMetro(); if (again) { again = false; round(); } });
  };
  const changed = (): void => { clearTimeout(timer); timer = setTimeout(round, REGEN_DELAY_MS); };
  const watchers = [join(root, 'src'), join(root, 'public'), MUTEN_DIST].filter((path) => existsSync(path)).map((path) => watch(path, { recursive: true }, changed));
  return () => { for (const watcher of watchers) watcher.close(); };
}

/** `muten native --android`: the toolchain, the phone, Android booted, and the app open on it with its errors here. */
export async function nativeAndroid(dir: string, root: string): Promise<boolean> {
  if (platform() !== 'linux') { console.error('✖ muten native --android runs on Linux for now; elsewhere: npx expo start, and open it with Expo Go'); return false; }
  await ensureToolchain();
  ensureAvd();
  const serial = await ensureBooted();
  resetErrors(dir);
  // the phone's own errors, from now on, beside the app's: a crash in native code never reaches Metro (a style the
  // phone refuses turns the screen red and Metro's log stays clean). React Native tags them `unknown:ReactNative`,
  // `unknown:FabricUIManager`, `unknown:ViewManager`…, so they are read by level and source, not by an exact tag
  const logcat = spawn(adbPath(), ['-s', serial, 'logcat', '-T', '1', '-v', 'brief', '*:E'], { stdio: ['ignore', 'pipe', 'ignore'] });
  logcat.stdout.on('data', (chunk: Buffer) => {
    for (const raw of chunk.toString().split('\n')) {
      const line = raw.trim();
      if (!APP_SOURCES.test(line) || /:\s+at\s/.test(line)) continue;   // the Java stack adds nothing a person can act on
      const message = line.replace(/^[EF]\/[^:]+(?::[^(]+)?\(\s*\d+\):\s*/, '');
      if (!NOISE.test(message)) recordError(dir, 'android', message);
    }
  });
  // Expo Go keeps the last app it opened: with the same address, opening it again only brings the old one forward
  adb(['-s', serial, 'shell', 'am', 'force-stop', 'host.exp.exponent']);
  say(dir, `  · opening the app with Expo (it installs Expo Go on the phone the first time)…\n  · it stays open: saving the app (or rebuilding muten) writes it again and the phone reloads\n  · every error goes to one file: muten native --errors shows them, with a screenshot\n  · the whole log, live, in another terminal: muten native --logs\n\n`);
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const env = { ...process.env, ANDROID_HOME: SDK, ANDROID_SDK_ROOT: SDK, PATH: `${join(SDK, 'platform-tools')}:${process.env.PATH ?? ''}` };
  // Metro's output passes through as it is, and what is an error in it is also recorded
  const pass = (chunk: Buffer, out: NodeJS.WriteStream): void => {
    say(dir, chunk.toString(), out);
    for (const raw of chunk.toString().split('\n')) { const line = raw.replace(ANSI, '').trim(); if (METRO_ERROR.test(line)) recordError(dir, 'app', line); }
  };
  let restarting = false;
  const startExpo = (clear: boolean): ChildProcess => {
    const child = spawn(npx, ['expo', 'start', '--android', ...(clear ? ['--clear'] : [])], { cwd: dir, stdio: ['inherit', 'pipe', 'pipe'], env });
    child.stdout?.on('data', (chunk: Buffer) => pass(chunk, process.stdout));
    child.stderr?.on('data', (chunk: Buffer) => pass(chunk, process.stderr));
    return child;
  };
  let expo = startExpo(true);   // a clean cache when the session opens: what changed while it was closed is bundled fresh
  // a round that installed a new package asks for it: this session's own Metro is stopped and started clean
  const restartMetro = (): void => {
    restarting = true;
    say(dir, '\n  · Metro starts again (a new package), with a clean cache…\n');
    expo.once('close', () => { adb(['-s', serial, 'shell', 'am', 'force-stop', 'host.exp.exponent']); expo = startExpo(true); restarting = false; });
    expo.kill('SIGINT');
  };
  const stopWatching = regenerateOnChange(root, dir, restartMetro);
  let status: number | null = 0;
  for (;;) {
    const current = expo;
    status = await new Promise<number | null>((resolve) => current.on('close', resolve));
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!restarting && current === expo) break;   // Metro ended on its own (or the person stopped it): the session ends
  }
  stopWatching();
  logcat.kill();
  return status === 0;
}
