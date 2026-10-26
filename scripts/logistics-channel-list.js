#!/usr/bin/env node
const { runCli } = require('./shared.js');
const { listArgs, queryList } = require('./query.js');

async function main(options = {}) {
  return queryList('/logistics/initial-channel/index', {}, options);
}

module.exports = { main };
if (require.main === module) runCli({ name: 'logistics-channel-list', description: '查询头程物流渠道、运输方式和材积除数原始配置。', args: listArgs, func: main });
