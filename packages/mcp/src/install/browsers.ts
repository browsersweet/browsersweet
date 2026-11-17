import { NATIVE_HOST_NAME } from '../protocol/constants.js';
import { type PathEnv, pathFor } from '../paths.js';

export const BROWSER_KEYS = [
  'chrome',
  'chrome-for-testing',
  'chromium',
  'edge',
  'brave',
  'vivaldi',
  'arc',
  'firefox',
] as const;
export type BrowserKey = (typeof BROWSER_KEYS)[number];

export const BROWSER_NAMES: Record<BrowserKey, string> = {
  chrome: 'Google Chrome',
  'chrome-for-testing': 'Google Chrome for Testing',
  chromium: 'Chromium',
  edge: 'Microsoft Edge',
  brave: 'Brave',
  vivaldi: 'Vivaldi',
  arc: 'Arc',
  firefox: 'Firefox',
};

export type BrowserFamily = 'chromium' | 'firefox';

export function familyOf(key: BrowserKey): BrowserFamily {
  return key === 'firefox' ? 'firefox' : 'chromium';
}

export const MANIFEST_FILE = `${NATIVE_HOST_NAME}.json`;

/** Where a browser looks for per-user native messaging hosts on this OS. */
export interface BrowserLocation {
  readonly key: BrowserKey;
  /** Exists when the browser has been run by this user. */
  readonly detectPath: string;
  /** macOS/Linux: the NativeMessagingHosts directory. */
  readonly manifestDir?: string;
  /** Windows: HKCU keys whose default value points at the manifest. */
  readonly registryKeys?: readonly string[];
}

const CHROME_KEY = 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts';

/*
 * Chrome for Testing (the Chrome build Puppeteer and Playwright download) keeps its own user
 * data directory, and Chromium reads per-user hosts from `<user data dir>/NativeMessagingHosts`
 * on macOS and Linux (chrome/common/chrome_paths.cc, DIR_USER_NATIVE_MESSAGING):
 * - macOS: ~/Library/Application Support/Google/Chrome for Testing
 *   (chrome/common/chrome_paths_mac.mm: "Google/Chrome for Testing" under
 *   GOOGLE_CHROME_FOR_TESTING_BRANDING)
 * - Linux: $XDG_CONFIG_HOME/google-chrome-for-testing (chrome/common/chrome_paths_linux.cc)
 * - Windows: user data in %LOCALAPPDATA%\Google\Chrome for Testing\User Data
 *   (chrome/install_static/google_chrome_for_testing_install_modes.h, user_data_dir.cc). Only
 *   Chromium-branded builds read a different registry key; every other build, Chrome for Testing
 *   included, reads HKCU\Software\Google\Chrome\NativeMessagingHosts
 *   (chrome/browser/extensions/api/messaging/launch_context_win.cc).
 * Source: https://chromium.googlesource.com/chromium/src at a52e438f (November 2026).
 */

/** `undefined` when the browser doesn't exist on this OS (Arc on Linux/Windows). */
export function browserLocation(
  key: BrowserKey,
  pe: PathEnv,
): BrowserLocation | undefined {
  const p = pathFor(pe.platform);
  const host = NATIVE_HOST_NAME;
  switch (pe.platform) {
    case 'darwin': {
      const base = p.join(pe.homedir, 'Library', 'Application Support');
      const chromium = (...dir: string[]): BrowserLocation => ({
        key,
        detectPath: p.join(base, ...dir),
        manifestDir: p.join(base, ...dir, 'NativeMessagingHosts'),
      });
      switch (key) {
        case 'chrome':
          return chromium('Google', 'Chrome');
        case 'chrome-for-testing':
          return chromium('Google', 'Chrome for Testing');
        case 'chromium':
          return chromium('Chromium');
        case 'edge':
          return chromium('Microsoft Edge');
        case 'brave':
          return chromium('BraveSoftware', 'Brave-Browser');
        case 'vivaldi':
          return chromium('Vivaldi');
        case 'arc':
          return chromium('Arc', 'User Data');
        case 'firefox':
          return {
            key,
            detectPath: p.join(base, 'Firefox'),
            manifestDir: p.join(base, 'Mozilla', 'NativeMessagingHosts'),
          };
      }
      break;
    }
    case 'linux': {
      const config = pe.env['XDG_CONFIG_HOME'] || p.join(pe.homedir, '.config');
      const chromium = (...dir: string[]): BrowserLocation => ({
        key,
        detectPath: p.join(config, ...dir),
        manifestDir: p.join(config, ...dir, 'NativeMessagingHosts'),
      });
      switch (key) {
        case 'chrome':
          return chromium('google-chrome');
        case 'chrome-for-testing':
          return chromium('google-chrome-for-testing');
        case 'chromium':
          return chromium('chromium');
        case 'edge':
          return chromium('microsoft-edge');
        case 'brave':
          return chromium('BraveSoftware', 'Brave-Browser');
        case 'vivaldi':
          return chromium('vivaldi');
        case 'arc':
          return undefined;
        case 'firefox':
          return {
            key,
            detectPath: p.join(pe.homedir, '.mozilla'),
            manifestDir: p.join(
              pe.homedir,
              '.mozilla',
              'native-messaging-hosts',
            ),
          };
      }
      break;
    }
    case 'win32': {
      const local =
        pe.env['LOCALAPPDATA'] ?? p.join(pe.homedir, 'AppData', 'Local');
      const roaming =
        pe.env['APPDATA'] ?? p.join(pe.homedir, 'AppData', 'Roaming');
      const keys = (...roots: string[]) =>
        roots.map((root) => `${root}\\${host}`);
      switch (key) {
        case 'chrome':
          return {
            key,
            detectPath: p.join(local, 'Google', 'Chrome', 'User Data'),
            registryKeys: keys(CHROME_KEY),
          };
        case 'chrome-for-testing':
          return {
            key,
            detectPath: p.join(
              local,
              'Google',
              'Chrome for Testing',
              'User Data',
            ),
            registryKeys: keys(CHROME_KEY),
          };
        case 'chromium':
          return {
            key,
            detectPath: p.join(local, 'Chromium', 'User Data'),
            registryKeys: keys(
              'HKCU\\Software\\Chromium\\NativeMessagingHosts',
            ),
          };
        case 'edge':
          return {
            key,
            detectPath: p.join(local, 'Microsoft', 'Edge', 'User Data'),
            registryKeys: keys(
              'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
            ),
          };
        // Brave and Vivaldi builds differ in which key they read; write both theirs and Chrome's
        // (all Chromium manifests are identical, so sharing Chrome's is harmless).
        case 'brave':
          return {
            key,
            detectPath: p.join(
              local,
              'BraveSoftware',
              'Brave-Browser',
              'User Data',
            ),
            registryKeys: keys(
              'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts',
              CHROME_KEY,
            ),
          };
        case 'vivaldi':
          return {
            key,
            detectPath: p.join(local, 'Vivaldi', 'User Data'),
            registryKeys: keys(
              'HKCU\\Software\\Vivaldi\\NativeMessagingHosts',
              CHROME_KEY,
            ),
          };
        case 'arc':
          // Arc for Windows ships as an MSIX package; its host lookup isn't documented yet.
          return undefined;
        case 'firefox':
          return {
            key,
            detectPath: p.join(roaming, 'Mozilla', 'Firefox'),
            registryKeys: keys('HKCU\\Software\\Mozilla\\NativeMessagingHosts'),
          };
      }
    }
  }
  return undefined;
}

export function parseBrowserKey(value: string): BrowserKey | undefined {
  const lower = value.toLowerCase().replace(/\s+/g, '');
  const aliases: Record<string, BrowserKey> = {
    googlechrome: 'chrome',
    chromefortesting: 'chrome-for-testing',
    googlechromefortesting: 'chrome-for-testing',
    cft: 'chrome-for-testing',
    msedge: 'edge',
    microsoftedge: 'edge',
    bravebrowser: 'brave',
  };
  if ((BROWSER_KEYS as readonly string[]).includes(lower)) {
    return lower as BrowserKey;
  }
  return aliases[lower];
}
