const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const { test } = require('node:test');

const history = { project: 'YS', warehouses: ['DEMO-DEST-UK'], startDate: '2026-09-01', endDate: '2026-09-30' };
const selection = { token: 'test-token', packingNo: 'ORDER-1', stockFrom: 'DEMO-FROM' };
const row = (id) => ({ id: String(id), packing_num_no: `BOX-${id}`, packing_num: 'ORDER-1', packing_no: 'ORDER-1',
  stock_from: 'DEMO-FROM', site_type: 'DEMO-DEST-UK', status: '1', dk_status: '5', sku: 'SKU-A', pack_version: '2', num: '0' });

function mockERP(t, handler) {
  const previous = process.env.NEW_ERP_BASE_URL;
  process.env.NEW_ERP_BASE_URL = 'https://packing-test.invalid';
  t.after(() => {
    if (previous === undefined) delete process.env.NEW_ERP_BASE_URL;
    else process.env.NEW_ERP_BASE_URL = previous;
  });
  const calls = [];
  t.mock.method(global, 'fetch', async (input, options) => {
    const query = Object.fromEntries(new URL(input).searchParams);
    calls.push(query);
    assert.equal(options.method ?? 'GET', 'GET');
    assert.equal(options.headers.token, 'test-token');
    const data = await handler(query, options);
    return data instanceof Response ? data : new Response(JSON.stringify({ code: 200, data }));
  });
  return calls;
}

function pageData(query, totalCount = 5) {
  const page = Number(query.page), pageSize = Number(query.pageSize);
  return { page, pageSize, totalCount: String(totalCount), summary: 'ERP原文',
    list: Array.from({ length: Math.min(pageSize, Math.max(0, totalCount - (page - 1) * pageSize)) },
      (_, i) => row((page - 1) * pageSize + i + 1)) };
}

test('packing order queries preserve single-page shape and add scoped fetchAll', async (t) => {
  const api = await import('../index.mjs');
  const calls = mockERP(t, (q) => pageData(q));
  const first = await api.packingOrderList({ ...selection, ...history, pageSize: 2 });
  assert.equal(first.list.length, 2);
  assert.equal(first.totalCount, 5);
  assert.equal(first.fetchedCount, 2);
  assert.equal(first.complete, false);
  assert.equal(first.summary, 'ERP原文');
  assert.deepEqual(first.query, { number_field: 'packing_num', number_value: 'ORDER-1', stock_from: 'DEMO-FROM',
    auction_site: 'YS', site_type: 'DEMO-DEST-UK', status: '', time_type: 'out_time',
    scan_date: '2026-09-01 00:00:00 & 2026-09-30 23:59:59' });
  const full = await api.packingOrderList({ ...selection, pageSize: 2, fetchAll: true });
  assert.equal(full.list.length, 5);
  assert.equal(full.complete, true);
  assert.equal(full.fetchedCount, 5);
  assert.equal(full.source.query.page, 1);
  assert.deepEqual(full.query, { number_field: 'packing_num', number_value: 'ORDER-1', stock_from: 'DEMO-FROM', status: '' });
  assert.equal(calls.length, 4);
  assert.ok(!JSON.stringify(full).includes('test-token'));
  assert.equal((await api.packingOrderList({ ...selection, page: 3, pageSize: 2 })).complete, false);
});

test('packing history pages are lazy, serial, bounded and stop immediately on return', async (t) => {
  const api = await import('../index.mjs');
  let active = 0, peak = 0;
  const calls = mockERP(t, async (q) => {
    peak = Math.max(peak, ++active);
    await Promise.resolve();
    active--;
    return pageData(q);
  });
  const iterator = api.packingOrderPages({ ...selection, pageSize: 2 });
  assert.equal(calls.length, 0);
  const first = (await iterator.next()).value;
  assert.equal(first.page, 1);
  assert.equal(first.complete, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  const second = (await iterator.next()).value;
  assert.equal(second.list.length, 2);
  assert.equal(second.fetchedCount, 4);
  assert.equal(first.list[0].id, '1');
  await iterator.return();
  assert.equal(calls.length, 2);
  const pages = [];
  for await (const page of api.packingOrderPages({ ...selection, pageSize: 2 })) pages.push(page);
  assert.deepEqual(pages.map((p) => [p.page, p.list.length, p.fetchedCount, p.complete]),
    [[1, 2, 2, false], [2, 2, 4, false], [3, 1, 5, true]]);
  assert.equal(peak, 1);
});

test('packing list and streaming reject broken pagination, duplicates, changed counts and scope', async (t) => {
  const api = await import('../index.mjs');
  let mode;
  mockERP(t, (q) => {
    const data = pageData(q);
    if (mode === 'short') data.list.pop();
    if (mode === 'page') data.page++;
    if (mode === 'pageSize') data.pageSize++;
    if (mode === 'total') data.totalCount = null;
    if (mode === 'changed' && data.page > 1) data.totalCount = '6';
    if (mode === 'duplicate' && data.page > 1) data.list[0] = row(1);
    if (mode === 'stock') data.list[0].stock_from = 'OTHER';
    if (mode === 'packing') data.list[0].packing_num = 'OTHER';
    if (mode === 'warehouse') data.list[0].site_type = 'OTHER';
    if (mode === 'identity') { delete data.list[0].id; delete data.list[0].packing_num_no; }
    return data;
  });
  for (mode of ['short', 'page', 'pageSize', 'total', 'changed', 'duplicate', 'stock', 'packing', 'warehouse', 'identity']) {
    const options = { ...selection, ...history, pageSize: 2 };
    await assert.rejects(api.packingOrderList({ ...options, fetchAll: true }), /pagination|totalCount|duplicate|outside|without/);
    await assert.rejects(async () => { for await (const unused of api.packingOrderPages(options)) {} },
      /pagination|totalCount|duplicate|outside|without/);
  }
});

test('new scope and pagination options fail before requests; maxPages fails after first page', async (t) => {
  const api = await import('../index.mjs');
  const calls = mockERP(t, (q) => pageData(q));
  for (const options of [{}, { stockFrom: 'DEMO-FROM' }, { packingNo: '' }, { packingNo: null },
    { packingNo: '*' }, { packingNo: ' ORDER-1' }, { packingNo: ['ORDER-1'] },
    { packingNo: 'ORDER-1', stockFrom: '' }, { packingNo: 'ORDER-1', project: 'YS' },
    { ...history, packingNo: '' }, { ...history, stockFrom: null },
    { ...selection, fetchAll: 'true' }, { ...selection, fetchAll: true, page: 2 },
    { ...selection, pageSize: 101 }, { ...selection, maxPages: 1001 }]) {
    await assert.rejects(api.packingOrderList({ token: 'test-token', ...options }));
  }
  await assert.rejects(async () => { for await (const unused of api.packingOrderPages({ ...selection, fetchAll: false })) {} });
  for (const fn of ['packingBatchList', 'planDeliveryOrderList']) {
    await assert.rejects(api[fn]({ ...selection, packingNo: '' }));
  }
  await assert.rejects(api.planDeliveryOrderList({ token: 'test-token', stockFrom: 'DEMO-FROM' }));
  assert.equal(calls.length, 0);
  await assert.rejects(api.packingOrderList({ ...selection, pageSize: 2, fetchAll: true, maxPages: 2 }), /exceeding maxPages=2/);
  assert.equal(calls.length, 1);
  calls.length = 0;
  await assert.rejects(async () => {
    for await (const unused of api.packingOrderPages({ ...selection, pageSize: 2, maxPages: 2 })) {}
  }, /exceeding maxPages=2/);
  assert.equal(calls.length, 1);
});

test('empty packing history yields one complete page without export work', async (t) => {
  const api = await import('../index.mjs');
  const calls = mockERP(t, (q) => pageData(q, 0));
  let count = 0;
  for await (const page of api.packingOrderPages(selection)) {
    count++;
    assert.equal(page.complete, true);
    assert.equal(page.totalCount, 0);
    assert.deepEqual(page.list, []);
  }
  assert.equal(count, 1);
  assert.equal(calls.length, 1);
});

test('batch packingNo and historical delivery mappings preserve raw fields and strict scope', async (t) => {
  const api = await import('../index.mjs');
  let mode;
  const calls = mockERP(t, (q) => {
    const data = pageData(q);
    if (mode === 'packing') data.list[0].packing_no = 'OTHER';
    if (mode === 'stock') data.list[0].stock_from = 'OTHER';
    if (mode === 'id') delete data.list[0].id;
    if (mode === 'duplicate' && data.page > 1) data.list[0].id = '1';
    if (mode === 'changed' && data.page > 1) data.totalCount = '6';
    if (mode === 'short') data.list.pop();
    return data;
  });
  for (const fn of ['packingBatchList', 'planDeliveryOrderList']) {
    mode = '';
    const result = await api[fn]({ ...selection, status: '', pageSize: 2, fetchAll: true });
    assert.equal(result.totalCount, 5);
    assert.equal(result.complete, true);
    assert.equal(result.source.query.packing_no, 'ORDER-1');
    assert.equal(result.source.query.stock_from, 'DEMO-FROM');
    assert.equal(result.list[0].pack_version, '2');
    assert.equal(result.list[0].num, '0');
    for (mode of ['packing', 'stock', 'changed', 'short']) {
      await assert.rejects(api[fn]({ ...selection, status: '', pageSize: 2, fetchAll: true }), /outside|totalCount|pagination/);
    }
  }
  for (mode of ['id', 'duplicate']) {
    await assert.rejects(api.planDeliveryOrderList({ ...selection, pageSize: 2, fetchAll: true }), /without|duplicate/);
  }
  assert.ok(calls.some((q) => q.r === '/sales/plan-delivery-order/list'));
});

test('packing detail validates box and warehouses and retains zero, versions and measurements', async (t) => {
  const api = await import('../index.mjs');
  let mode;
  const calls = mockERP(t, (q) => ({ packing_num_no: mode === 'box' ? 'OTHER' : q.packing_num_no,
    stock_from: mode === 'stock' ? 'OTHER' : q.stock_from, site_type: mode === 'site' ? 'OTHER' : q.site_type,
    packing_sku: mode === 'shape' ? {} : [{ sku: 'SKU-A', num: '0', bom_number: '17' }],
    packing_long: '0.00', this_box_total_weight: null }));
  const options = { token: 'test-token', packingNumNo: 'BOX-1', stockFrom: 'DEMO-FROM', siteType: 'DEMO-DEST-UK', status: 0 };
  const detail = await api.packingDetail(options);
  assert.deepEqual(detail.packing_sku, [{ sku: 'SKU-A', num: '0', bom_number: '17' }]);
  assert.equal(detail.packing_long, '0.00');
  assert.equal(detail.this_box_total_weight, null);
  assert.equal(detail.source.query.status, '0');
  assert.equal(detail.source.query.site_type, 'DEMO-DEST-UK');
  for (mode of ['box', 'stock', 'site', 'shape']) await assert.rejects(api.packingDetail(options), /does not match/);
  const count = calls.length;
  for (const invalid of [{ packingNumNo: '' }, { stockFrom: '' }, { siteType: '' }, { status: '' },
    { status: null }, { status: false }, { status: '1,2' }]) await assert.rejects(api.packingDetail({ ...options, ...invalid }));
  assert.equal(calls.length, count);
});

test('packing export keeps full history scope, adds exact filters and accepts in-memory polling options', async (t) => {
  const api = await import('../index.mjs');
  let submitted = false, polls = 0;
  const query = { number_field: 'packing_num', number_value: 'ORDER-1', stock_from: 'DEMO-FROM',
    auction_site: 'YS', site_type: 'DEMO-DEST-UK', status: '', time_type: 'out_time',
    scan_date: '2026-09-01 00:00:00 & 2026-09-30 23:59:59' };
  const task = (id, condition = query, status = '3') => ({ id, status,
    route_url: 'warehouse/packing-order/down-packing-detail', add_condition: JSON.stringify(condition) });
  const calls = mockERP(t, (q) => {
    if (q.r.endsWith('/list')) return pageData(q, 1);
    if (q.r.endsWith('/down-packing-detail')) {
      assert.deepEqual(q, { r: '/warehouse/packing-order/down-packing-detail', ...query });
      submitted = true;
      return {};
    }
    if (q.r.endsWith('/index')) {
      if (!submitted) return { list: [task('old')] };
      return { list: [task('old'), task('extra-filter', { ...query, sku: 'OTHER' }),
        task('wrong-packing', { ...query, number_value: 'OTHER' }), task('new', query, ++polls === 1 ? '2' : '3')] };
    }
    assert.equal(q.id, 'new');
    return new Response('PK-in-memory-xlsx', { headers: { 'content-disposition': 'attachment; filename=test.xlsx' } });
  });
  const options = { ...selection, ...history, pollMs: 1, timeoutMs: 600000 };
  for (const invalid of [{ ...selection }, { ...options, pollMs: 0 }, { ...options, timeoutMs: -1 },
    { ...options, packingNo: '' }, { ...options, stockFrom: '' }]) await assert.rejects(api.exportPackingDetails(invalid));
  assert.equal(calls.length, 0);
  const result = await api.exportPackingDetails(options);
  assert.equal(result.taskId, 'new');
  assert.equal(result.file.toString(), 'PK-in-memory-xlsx');
  assert.equal(result.boxes, 1);
  assert.deepEqual(result.query, query);
  assert.equal(polls, 2);
  assert.equal(calls.filter((q) => q.r.endsWith('/down-packing-detail')).length, 1);
});

test('explicit packing export taskId resumes a matching task and reports it without submitting', async (t) => {
  const api = await import('../index.mjs');
  const { packingQuery } = require('../scripts/packing-order-list.js');
  const query = packingQuery({ ...selection, ...history });
  let polls = 0;
  const progress = [];
  const calls = mockERP(t, (q) => {
    if (q.r.endsWith('/list')) return pageData(q, 1);
    if (q.r.endsWith('/index')) return { list: [{ id: 'saved', status: ++polls === 1 ? '2' : '3',
      route_url: 'warehouse/packing-order/down-packing-detail', add_condition: JSON.stringify(query) }] };
    assert.ok(!q.r.endsWith('/down-packing-detail'));
    assert.equal(q.id, 'saved');
    return new Response('PK-resumed', { headers: { 'content-disposition': 'attachment' } });
  });
  const result = await api.exportPackingDetails({ ...selection, ...history, taskId: 'saved', pollMs: 1,
    onProgress: (event) => { progress.push(event); } });
  assert.equal(result.taskId, 'saved');
  assert.equal(result.file.toString(), 'PK-resumed');
  assert.deepEqual(progress, [{ stage: 'waiting', boxes: 1, taskId: 'saved' }, { stage: 'download', boxes: 1, taskId: 'saved' }]);
  assert.equal(calls.filter((q) => q.r.endsWith('/down-packing-detail')).length, 0);
});

test('packing export rejects mismatched, disappeared, failed and changed resumed tasks', async (t) => {
  const api = await import('../index.mjs');
  const { packingQuery } = require('../scripts/packing-order-list.js');
  const query = packingQuery({ ...selection, ...history });
  let mode, polls;
  const calls = mockERP(t, (q) => {
    if (q.r.endsWith('/list')) return pageData(q, 1);
    assert.ok(q.r.endsWith('/index'), 'resume must not submit or download on failure');
    polls++;
    const condition = mode === 'query' || mode === 'changed' && polls > 1 ? { ...query, number_value: 'OTHER' }
      : mode === 'extra-filter' ? { ...query, sku: 'OTHER' } : query;
    const list = mode === 'missing' ? [] : [{ id: 'saved', status: mode === 'failed' ? '4' : '2',
      route_url: mode === 'route' ? 'other/export' : 'warehouse/packing-order/down-packing-detail',
      add_condition: mode === 'malformed' ? 'not-json' : JSON.stringify(condition) }];
    return { page: Number(q.page), pageSize: Number(q.pageSize), totalCount: list.length, list };
  });
  for (mode of ['query', 'extra-filter', 'route', 'malformed', 'missing', 'failed', 'changed']) {
    polls = 0;
    await assert.rejects(api.exportPackingDetails({ ...selection, ...history, taskId: 'saved', pollMs: 1 }),
      /does not match|disappeared|failed/);
  }
  const count = calls.length;
  for (const invalid of [{ taskId: '' }, { taskId: null }, { taskId: '*' }, { project: undefined }]) {
    await assert.rejects(api.exportPackingDetails({ ...selection, ...history, taskId: 'saved', ...invalid }));
  }
  assert.equal(calls.length, count);
});

test('packing export finds an older explicit task by bounded serial download-center pagination', async (t) => {
  const api = await import('../index.mjs');
  const { packingQuery } = require('../scripts/packing-order-list.js');
  const query = packingQuery({ ...selection, ...history });
  const calls = mockERP(t, (q) => {
    if (q.r.endsWith('/list')) return pageData(q, 1);
    if (q.r.endsWith('/index')) {
      const data = pageData(q, 101);
      data.list = data.list.map((r) => ({ id: r.id, status: '3', route_url: 'warehouse/packing-order/down-packing-detail',
        add_condition: JSON.stringify(query) }));
      return data;
    }
    assert.ok(!q.r.endsWith('/down-packing-detail'));
    assert.equal(q.id, '101');
    return new Response('PK-older', { headers: { 'content-disposition': 'attachment' } });
  });
  const result = await api.exportPackingDetails({ ...selection, ...history, taskId: '101' });
  assert.equal(result.file.toString(), 'PK-older');
  assert.deepEqual(calls.filter((q) => q.r.endsWith('/index')).map((q) => q.page), ['1', '1', '2']);
});

test('new packing exports expose taskId before a polling failure so an explicit retry does not submit again', async (t) => {
  const api = await import('../index.mjs');
  const { packingQuery } = require('../scripts/packing-order-list.js');
  const query = packingQuery({ ...selection, ...history });
  let submitted = false, polls = 0, recovered = false, saved;
  const calls = mockERP(t, (q) => {
    if (q.r.endsWith('/list')) return pageData(q, 1);
    if (q.r.endsWith('/down-packing-detail')) { submitted = true; return {}; }
    if (q.r.endsWith('/index')) {
      if (!submitted) return { list: [] };
      if (++polls === 2) throw Error('simulated poll interruption');
      return { list: [{ id: 'checkpoint', status: recovered ? '3' : '2',
        route_url: 'warehouse/packing-order/down-packing-detail', add_condition: JSON.stringify(query) }] };
    }
    return new Response('PK-recovered', { headers: { 'content-disposition': 'attachment' } });
  });
  await assert.rejects(api.exportPackingDetails({ ...selection, ...history, pollMs: 1,
    onProgress: (event) => { if (event.stage === 'waiting') saved = event.taskId; } }), /simulated poll interruption/);
  assert.equal(saved, 'checkpoint');
  recovered = true;
  const result = await api.exportPackingDetails({ ...selection, ...history, taskId: saved });
  assert.equal(result.file.toString(), 'PK-recovered');
  assert.equal(calls.filter((q) => q.r.endsWith('/down-packing-detail')).length, 1);
});

test('packing export honors a custom poll deadline', async (t) => {
  const api = await import('../index.mjs');
  let clock = 0, submitted = false;
  t.mock.method(Date, 'now', () => clock);
  mockERP(t, (q) => {
    if (q.r.endsWith('/list')) return pageData(q, 1);
    if (q.r.endsWith('/down-packing-detail')) { submitted = true; return {}; }
    if (!submitted) return { list: [] };
    clock = 25;
    return { list: [] };
  });
  await assert.rejects(api.exportPackingDetails({ ...selection, ...history, pollMs: 2, timeoutMs: 25 }), /timed out after 25ms/);
});

test('pageSize 100 uses 10 requests versus 50 at default 20 for the same 1000 fixture boxes', async (t) => {
  const api = await import('../index.mjs');
  const calls = mockERP(t, (q) => pageData(q, 1000));
  const read = async (options) => {
    let count = 0, sum = 0;
    for await (const page of api.packingOrderPages({ ...selection, ...options })) {
      count += page.list.length;
      sum += page.list.reduce((n, r) => n + Number(r.id), 0);
      assert.ok(page.list.length <= (options.pageSize ?? 20));
    }
    return { count, sum };
  };
  const defaultResult = await read({});
  assert.equal(calls.length, 50);
  assert.ok(calls.every((q) => q.pageSize === '20'));
  calls.length = 0;
  const largerResult = await read({ pageSize: 100 });
  assert.equal(calls.length, 10);
  assert.deepEqual(largerResult, defaultResult);
  assert.deepEqual(defaultResult, { count: 1000, sum: 500500 });
  t.diagnostic('本地固定1000箱：默认20条/页=50次请求；100条/页=10次，减少80%。仅验证请求数，不是ERP实测速率。');
});

test('packing pages CLI emits parseable per-page NDJSON and new read CLIs map options', async (t) => {
  const server = http.createServer((request, response) => {
    const q = Object.fromEntries(new URL(request.url, 'http://local').searchParams);
    const data = q.r.endsWith('/packing-detail')
      ? { packing_num_no: q.packing_num_no, stock_from: q.stock_from, packing_sku: [] } : pageData(q, 3);
    response.end(JSON.stringify({ code: 200, data }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const run = (command, args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(__dirname, '..', 'scripts', 'new-erp.js'), command, '--token', 'test-token', ...args,
    ],
      { env: { ...process.env, NEW_ERP_BASE_URL: `http://127.0.0.1:${server.address().port}` } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (b) => { stdout += b; });
    child.stderr.on('data', (b) => { stderr += b; });
    child.on('error', reject);
    child.on('close', (code) => { try { assert.equal(code, 0, stderr); resolve(stdout); } catch (error) { reject(error); } });
  });
  const output = await run('packing-order-pages', ['--packingNo', 'ORDER-1', '--stockFrom', 'DEMO-FROM', '--pageSize', '2']);
  const pages = output.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(pages.map((p) => [p.page, p.list.length, p.complete]), [[1, 2, false], [2, 1, true]]);
  const delivery = JSON.parse(await run('plan-delivery-order-list', ['--packingNo', 'ORDER-1', '--stockFrom', 'DEMO-FROM', '--fetchAll', '--pageSize', '2']));
  assert.equal(delivery.list.length, 3);
  assert.equal(delivery.complete, true);
  const detail = JSON.parse(await run('packing-detail', ['--packingNumNo', 'BOX-1', '--stockFrom', 'DEMO-FROM', '--siteType', 'DEMO-DEST-UK', '--status', '0']));
  assert.equal(detail.packing_num_no, 'BOX-1');
});
