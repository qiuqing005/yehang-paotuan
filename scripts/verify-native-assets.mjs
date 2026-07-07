import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const webDist = path.join(root, 'apps', 'web', 'dist');
const targets = [
  {
    label: 'Windows renderer',
    dir: path.join(root, 'apps', 'native', 'windows-electron', 'renderer'),
    runtimeConfig: path.join(root, 'apps', 'native', 'windows-electron', 'native-runtime.json'),
    mainProcess: path.join(root, 'apps', 'native', 'windows-electron', 'main.js'),
  },
  {
    label: 'Android WebView',
    dir: path.join(root, 'apps', 'native', 'android-webview', 'app', 'src', 'main', 'assets', 'www'),
  },
];
const expectedApiBase = process.env.NATIVE_EXPECTED_API_BASE ?? process.env.PAOTUAN_API_BASE ?? '';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizeAssetRef(ref) {
  return ref.replace(/^[./]+/, '').replace(/^\/+/, '');
}

function readAssetRefs(dir) {
  const indexPath = path.join(dir, 'index.html');
  assert(existsSync(indexPath), `Missing index.html: ${indexPath}`);
  const html = readFileSync(indexPath, 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^":#?]+)(?:[?#][^"]*)?"/g)]
    .map((match) => normalizeAssetRef(match[1]))
    .filter((ref) => ref.startsWith('assets/') && /\.(?:js|css)$/.test(ref))
    .sort();
  assert(refs.some((ref) => ref.endsWith('.js')), `Missing JavaScript asset reference in ${indexPath}`);
  assert(refs.some((ref) => ref.endsWith('.css')), `Missing CSS asset reference in ${indexPath}`);
  refs.forEach((ref) => {
    assert(existsSync(path.join(dir, ref)), `Referenced native asset is missing: ${path.join(dir, ref)}`);
  });
  return refs;
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function listFiles(dir, base = dir) {
  assert(existsSync(dir), `Missing directory: ${dir}`);
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return listFiles(absolute, base);
      }
      if (!entry.isFile()) {
        return [];
      }
      return toPosix(path.relative(base, absolute));
    })
    .sort();
}

function hashFile(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function readManifest(dir, options = {}) {
  const allowExtra = new Set(options.allowExtra ?? []);
  return new Map(
    listFiles(dir)
      .filter((relativePath) => !allowExtra.has(relativePath))
      .map((relativePath) => {
        const absolute = path.join(dir, ...relativePath.split('/'));
        return [
          relativePath,
          {
            hash: hashFile(absolute),
            size: statSync(absolute).size,
          },
        ];
      }),
  );
}

function compareManifest(label, expected, actual) {
  const expectedFiles = [...expected.keys()].sort();
  const actualFiles = [...actual.keys()].sort();
  const missing = expectedFiles.filter((file) => !actual.has(file));
  const extra = actualFiles.filter((file) => !expected.has(file));
  assert(missing.length === 0, `${label} is missing dist files:\n${missing.join('\n')}`);
  assert(extra.length === 0, `${label} contains stale extra files:\n${extra.join('\n')}`);

  const changed = expectedFiles.filter((file) => {
    const expectedItem = expected.get(file);
    const actualItem = actual.get(file);
    return !actualItem || expectedItem.hash !== actualItem.hash || expectedItem.size !== actualItem.size;
  });
  assert(changed.length === 0, `${label} file contents differ from apps/web/dist:\n${changed.join('\n')}`);
}

function compareRefs(label, expected, actual) {
  const expectedText = expected.join('\n');
  const actualText = actual.join('\n');
  assert(
    expectedText === actualText,
    `${label} asset references are stale.\nExpected:\n${expectedText}\nActual:\n${actualText}`,
  );
}

function normalizeUrl(value) {
  const trimmed = String(value ?? '').trim().replace(/\/+$/, '');
  assert(trimmed, 'Native API base cannot be empty.');
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (error) {
    throw new Error(`Native API base is not a valid URL: ${trimmed}`);
  }
  assert(['http:', 'https:'].includes(parsed.protocol), `Native API base must be http(s): ${trimmed}`);
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

function readNativeConfigApiBase(dir) {
  const configPath = path.join(dir, 'native-config.js');
  assert(existsSync(configPath), `Missing native config: ${configPath}`);
  const source = readFileSync(configPath, 'utf8');
  const match = source.match(/window\.__PAOTUAN_API_BASE__\s*=\s*(?:window\.__PAOTUAN_API_BASE__\s*\|\|\s*)?("[^"]*"|'[^']*')\s*;/);
  assert(match, `Cannot parse native API base from ${configPath}`);
  const literal = match[1].startsWith("'")
    ? `"${match[1].slice(1, -1).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : match[1];
  return normalizeUrl(JSON.parse(literal));
}

function readJsonFile(filePath) {
  assert(existsSync(filePath), `Missing JSON file: ${filePath}`);
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot parse JSON file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readDefaultAppUrl(filePath) {
  assert(existsSync(filePath), `Missing Windows main process file: ${filePath}`);
  const source = readFileSync(filePath, 'utf8');
  const match = source.match(/const\s+DEFAULT_APP_URL\s*=\s*("[^"]*"|'[^']*')\s*;/);
  assert(match, `Cannot parse DEFAULT_APP_URL from ${filePath}`);
  const literal = match[1].startsWith("'")
    ? `"${match[1].slice(1, -1).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : match[1];
  return normalizeUrl(JSON.parse(literal));
}

function validateNativeApiConfig(targetsToValidate) {
  const configs = targetsToValidate.map((target) => ({
    apiBase: readNativeConfigApiBase(target.dir),
    label: target.label,
    mainProcess: target.mainProcess,
    runtimeConfig: target.runtimeConfig,
  }));
  const expected = expectedApiBase ? normalizeUrl(expectedApiBase) : configs[0]?.apiBase;
  assert(expected, 'No native target API base was found.');
  configs.forEach((config) => {
    assert(config.apiBase === expected, `${config.label} native-config.js API mismatch. Expected ${expected}, got ${config.apiBase}`);
    if (config.runtimeConfig) {
      const runtime = readJsonFile(config.runtimeConfig);
      assert(normalizeUrl(runtime.apiBase) === expected, `${config.label} native-runtime.json apiBase mismatch.`);
      assert(normalizeUrl(runtime.appUrl) === expected, `${config.label} native-runtime.json appUrl mismatch.`);
    }
    if (config.mainProcess) {
      const defaultAppUrl = readDefaultAppUrl(config.mainProcess);
      assert(defaultAppUrl === expected, `${config.label} DEFAULT_APP_URL mismatch. Expected ${expected}, got ${defaultAppUrl}`);
    }
  });
  return expected;
}

const expectedRefs = readAssetRefs(webDist);
const expectedManifest = readManifest(webDist, {
  allowExtra: ['native-config.js'],
});
const expectedFiles = [...expectedManifest.keys()].sort();
const dynamicJsChunks = expectedFiles.filter((file) => file.startsWith('assets/') && file.endsWith('.js') && !expectedRefs.includes(file));
const nativeApiBase = validateNativeApiConfig(targets);

targets.forEach((target) => {
  const actualRefs = readAssetRefs(target.dir);
  compareRefs(target.label, expectedRefs, actualRefs);
  compareManifest(target.label, expectedManifest, readManifest(target.dir, {
    allowExtra: ['native-config.js'],
  }));
});

console.log(JSON.stringify({
  ok: true,
  apiBase: nativeApiBase,
  refs: expectedRefs,
  fileCount: expectedFiles.length,
  dynamicJsChunks,
  targets: targets.map((target) => target.label),
}, null, 2));
