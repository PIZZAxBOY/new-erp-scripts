const assert = require('node:assert/strict');
const { test } = require('node:test');
const { auditText } = require('./check-package-privacy.js');

test('package audit rejects private endpoints, user paths and literal credentials without printing values', () => {
  const sample = ['https://erp.company.internal/assets/build.js', '/Users/example/.config/session.json',
    `npm_${'x'.repeat(40)}`, 'password: "do-not-publish-me"', 'person@company.internal'].join('\n');
  const result = auditText('docs/example.md', sample);
  for (const kind of ['non-public-service-url', 'personal-path', 'access-token', 'literal-credential', 'personal-email']) {
    assert.ok(result.some((finding) => finding.kind === kind), kind);
  }
  assert.ok(result.every((finding) => finding.file === 'docs/example.md'));
  assert.ok(!JSON.stringify(result).includes('do-not-publish-me'));
  assert.ok(!JSON.stringify(result).includes('erp.company.internal'));
});

test('package audit permits public documentation, reserved examples and credential variables', () => {
  const sample = ['https://registry.npmjs.org', 'https://github.com/example/project',
    'https://your-erp.example.com', 'token: "your-token"', 'const token = process.env.NEW_ERP_TOKEN;',
    'const headers = { token };'].join('\n');
  assert.deepEqual(auditText('README.md', sample), []);
});
