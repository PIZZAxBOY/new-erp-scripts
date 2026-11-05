const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeXlsx, readTable, writeTable, zipFiles } = require('../scripts/xlsx-merge.js');

test('merges one-sheet workbooks, shared strings and rejects mismatched headers', () => {
  const left = writeTable([['box', 'qty'], ['A & B', '1']]);
  const right = writeTable([['box', 'qty'], ['C', '2']]);
  assert.equal(left.subarray(0, 2).toString(), 'PK');
  assert.deepEqual(readTable(mergeXlsx([left, right])), [['box', 'qty'], ['A & B', '1'], ['C', '2']]);
  const shared = zipFiles([
    ['xl/workbook.xml', Buffer.from('<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="s" sheetId="1" r:id="rId1"/></sheets></workbook>')],
    ['xl/_rels/workbook.xml.rels', Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')],
    ['xl/sharedStrings.xml', Buffer.from('<sst><si><t>box</t></si><si><t>A&amp;B</t></si></sst>')],
    ['xl/worksheets/sheet1.xml', Buffer.from('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>note</t></is></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>3</v></c></row></sheetData></worksheet>')],
  ]);
  assert.deepEqual(readTable(shared), [['box', '', 'note'], ['A&B', '3', '']]);
  assert.throws(() => mergeXlsx([left, writeTable([['other'], ['x']])]), /do not share a header/);
  assert.throws(() => readTable(Buffer.from('PK-not-a-zip')), /not a readable workbook/);
});

test('packing export delegates a new range to the account pool', async () => {
  const { main } = require('../scripts/packing-detail-export.js');
  const delegated = await main({
    project: 'YS', warehouses: 'DEMO-DEST-UK', startDate: '2025-01-01', endDate: '2025-06-30', token: 'unused',
    accountSplit: async ({ start, end, query }) => {
      assert.equal(start, '2025-01-01 00:00:00');
      assert.equal(end, '2025-06-30 23:59:59');
      assert.equal(query.scan_date, `${start} & ${end}`);
      return { file: Buffer.from('PK-merged'), boxes: 3, taskId: 'one', parts: 2, query };
    },
  });
  assert.equal(delegated.file.toString(), 'PK-merged');
  assert.equal(delegated.parts, 2);
});
