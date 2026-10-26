#!/usr/bin/env node
const { once } = require('node:events');
const { parseArgs, formatHelp, redactSensitiveText } = require('./shared.js');
const { pages, args: listArgs } = require('./packing-order-list.js');

const args = listArgs.filter((arg) => arg.name !== 'fetchAll');

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2), args);
    if (options.help) {
      process.stdout.write(formatHelp({ name: 'packing-order-pages', description: '串行读取全部装箱分页，每页输出一行JSON；建议 pageSize=100，受 maxPages 限制。', args }));
      return;
    }
    for await (const page of pages(options)) {
      if (!process.stdout.write(`${JSON.stringify(page)}\n`)) await once(process.stdout, 'drain');
    }
  } catch (error) {
    process.stderr.write(`Error: ${redactSensitiveText(error.message)}\n`);
    process.exitCode = error.exitCode || 1;
  }
}

if (require.main === module) main();
