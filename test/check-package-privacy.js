const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const publicHosts = new Set(['github.com', 'www.skills.sh', 'skills.sh', 'learn.chatgpt.com',
  'registry.npmjs.org', 'npmjs.com', 'www.npmjs.com', 'docs.npmjs.com', 'modelcontextprotocol.io']);

function auditText(filename, content) {
  const findings = [];
  const add = (kind, index) => findings.push({ file: filename, line: content.slice(0, index).split('\n').length, kind });
  const patterns = [
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
    ['access-token', /\b(?:npm_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
    ['personal-path', /\/(?:Users|home)\/[A-Za-z0-9_.-]+|[A-Z]:\\Users\\[A-Za-z0-9_.-]+/gi],
    ['private-address', /\b(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)\b/g],
    ['embedded-credentials', /https?:\/\/[^\s/@]+:[^\s/@]+@/g],
  ];
  for (const [kind, pattern] of patterns) for (const match of content.matchAll(pattern)) add(kind, match.index);
  for (const match of content.matchAll(/https?:\/\/[^\s"'<>`\])}]+/g)) {
    if (match[0].includes('${')) continue;
    try {
      const host = new URL(match[0]).hostname;
      if (!publicHosts.has(host) && !/(^|\.)(?:example\.(?:com|org|net)|invalid|test)$/.test(host)) add('non-public-service-url', match.index);
    } catch {}
  }
  for (const match of content.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
    if (!/(^|\.)(?:example\.(?:com|org|net)|invalid|test)$/.test(match[1])) add('personal-email', match.index);
  }
  const assignment = /["']?\b(?:password|passwd|token|access_token|refresh_token|api[_-]?key|secret)["']?\s*[:=]\s*(["'])([^"'\n]+)\1/gi;
  for (const match of content.matchAll(assignment)) {
    if (!/^(?:your[-_]|example[-_]|demo[-_]|\[REDACTED\]|\$\{)/i.test(match[2])) add('literal-credential', match.index);
  }
  return findings;
}

function readCommand(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Package audit could not run ${command}`);
  return result.stdout;
}

function checkPackage(archive) {
  const root = path.resolve(__dirname, '..');
  let files;
  let read;
  if (archive) {
    const filename = path.resolve(archive);
    files = readCommand('tar', ['-tzf', filename]).trim().split('\n').filter((entry) => !entry.endsWith('/'));
    read = (entry) => readCommand('tar', ['-xOzf', filename, entry]);
  } else {
    const [pack] = JSON.parse(readCommand('npm', ['pack', '--dry-run', '--ignore-scripts', '--json']));
    files = pack.files.map((file) => `package/${file.path}`);
    read = (entry) => fs.readFileSync(path.join(root, entry.slice('package/'.length)), 'utf8');
  }
  const findings = [];
  for (const file of files) {
    const valid = /^package\/(?:index\.mjs|README\.md|package\.json|(?:scripts|docs)\/.+)$/.test(file)
      && !file.split('/').includes('..');
    const sensitive = /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|config\.json|session\.json|credentials\.[^/]+)$|\.(?:pem|key|p12|pfx|sqlite3?|db|csv|xlsx?)$/i.test(file);
    if (!valid || sensitive) { findings.push({ file, kind: 'unexpected-or-sensitive-file' }); continue; }
    findings.push(...auditText(file, read(file)));
  }
  return { files: files.length, findings };
}

module.exports = { auditText, checkPackage };
if (require.main === module) {
  try {
    const result = checkPackage(process.argv[2]);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.findings.length) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
