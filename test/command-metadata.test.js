const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');

const { commands } = require('../scripts/new-erp.js');
const infrastructure = new Set(['login', 'logout', 'setup', 'mcp']);
const businessCommands = Object.entries(commands).filter(([name]) => !infrastructure.has(name));

test('the command registry exposes all 22 business modules with callable argument metadata', () => {
  assert.equal(Object.keys(commands).length, 26);
  assert.equal(businessCommands.length, 22);
  assert.deepEqual(Object.keys(commands).filter((name) => infrastructure.has(name)).sort(),
    ['login', 'logout', 'mcp', 'setup']);
  for (const [name, command] of businessCommands) {
    assert.ok(command.description, name);
    const implementation = require(path.join('../scripts', command.script));
    assert.equal(typeof implementation[name === 'packing-order-pages' ? 'pages' : 'main'], 'function', name);
    assert.ok(Array.isArray(implementation.args), name);
    assert.ok(implementation.args.length > 0, name);
    const names = implementation.args.map((arg) => arg.name);
    assert.equal(new Set(names).size, names.length, `${name}: unique argument names`);
    for (const arg of implementation.args) {
      assert.equal(typeof arg.name, 'string', name);
      assert.ok(['string', 'int', 'bool'].includes(arg.type), `${name}: ${arg.name}`);
      assert.equal(typeof arg.help, 'string', `${name}: ${arg.name}`);
    }
  }
});

test('shared and derived metadata retain the existing CLI definitions', () => {
  const list = require('../scripts/packing-order-list.js');
  const pages = require('../scripts/packing-order-pages.js');
  assert.equal(pages.pages, list.pages);
  assert.deepEqual(pages.args, list.args.filter((arg) => arg.name !== 'fetchAll'));
  assert.ok(pages.args.every((arg) => list.args.includes(arg)));
  assert.equal(require('../scripts/logistics-channel-list.js').args, require('../scripts/query.js').listArgs);
});

test('importing the registry neither invokes the CLI nor loads command modules', () => {
  const script = `
    const assert = require('node:assert/strict');
    require('node:child_process').spawnSync = () => { throw new Error('CLI invoked'); };
    process.argv = [process.execPath, 'new-erp.js', 'market-order-list'];
    process.exitCode = 73;
    const { commands } = require('./scripts/new-erp.js');
    assert.equal(process.exitCode, 73);
    assert.equal(Object.keys(commands).length, 26);
    for (const { script } of Object.values(commands)) {
      assert.equal(require.cache[require.resolve('./scripts/' + script)], undefined);
    }
    process.exitCode = 0;
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.error);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
