const { listArgs, queryList } = require('./query.js');

async function main(options = {}) {
  return queryList('/logistics/initial-channel/index', {}, options);
}

module.exports = { main, args: listArgs };
