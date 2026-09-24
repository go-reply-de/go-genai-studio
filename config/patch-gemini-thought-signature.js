/**
 * Gemini 3 rejects a tool call sent back without its thought signature (HTTP 400), and
 * @langchain/google-common 0.2.x drops it whenever the stored signatures don't line up with
 * the message parts. Re-attaches the dropped signatures to the tool calls in order, like upstream's
 * fixThoughtSignatures; tool calls that never had one get Google's documented placeholder.
 */
const fs = require('fs');
const path = require('path');

const ANCHOR = 'const signatures = message?.additional_kwargs?.signatures ?? [];';
const PLACEHOLDER = 'skip_thought_signature_validator';

function findPackages(nodeModules, found = []) {
  if (!fs.existsSync(nodeModules)) {
    return found;
  }
  const pkg = path.join(nodeModules, '@langchain', 'google-common');
  if (fs.existsSync(path.join(pkg, 'package.json'))) {
    found.push(pkg);
  }
  for (const entry of fs.readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = path.join(nodeModules, entry.name);
    const children = entry.name.startsWith('@')
      ? fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => path.join(dir, e.name))
      : [dir];
    for (const child of children) {
      findPackages(path.join(child, 'node_modules'), found);
    }
  }
  return found;
}

function patchFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes(PLACEHOLDER)) {
    return 'already patched';
  }
  const at = src.indexOf(ANCHOR);
  if (at === -1 || src.indexOf(ANCHOR, at + 1) !== -1) {
    throw new Error(`expected exactly one signature block in ${file}`);
  }
  const ret = /\n(\s*)return \[/.exec(src.slice(at));
  if (!ret) {
    throw new Error(`no return after the signature block in ${file}`);
  }
  const indent = ret[1];
  const insertAt = at + ret.index + 1;
  const stamp = [
    `${indent}const unattached = signatures.filter((s) => s && !parts.some((p) => p.thoughtSignature === s));`,
    `${indent}let nextSignature = 0;`,
    `${indent}for (const part of parts) {`,
    `${indent}    if (part.functionCall && !part.thoughtSignature) {`,
    `${indent}        part.thoughtSignature = unattached[nextSignature++] ?? "${PLACEHOLDER}";`,
    `${indent}    }`,
    `${indent}}`,
    '',
  ].join('\n');
  fs.writeFileSync(file, src.slice(0, insertAt) + stamp + src.slice(insertAt));
  return 'patched';
}

const root = path.resolve(__dirname, '..');
const packages = [
  ...findPackages(path.join(root, 'node_modules')),
  ...findPackages(path.join(root, 'api', 'node_modules')),
];
if (packages.length === 0) {
  throw new Error('@langchain/google-common not found; the Gemini 3 tool-call fix was not applied');
}
for (const pkg of packages) {
  const { version } = require(path.join(pkg, 'package.json'));
  for (const name of ['gemini.js', 'gemini.cjs']) {
    const file = path.join(pkg, 'dist', 'utils', name);
    console.log(`${path.relative(root, file)} (${version}): ${patchFile(file)}`);
  }
}
