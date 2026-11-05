const zlib = require('node:zlib');

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c;
}

function invalid(message) {
  const error = new Error(message);
  error.code = 'XLSX_MERGE';
  return error;
}

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipFiles(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name);
    const compressed = zlib.deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, compressed);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(8, 10);
    record.writeUInt32LE(crc32(data), 16);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(nameBuf.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

function unzip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.subarray(0, 2).toString() !== 'PK') throw invalid('packing export segment is not a readable workbook');
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  if (eocd < 0) throw invalid('packing export segment is not a readable workbook');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw invalid('packing export segment is not a readable workbook');
    const method = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw invalid('packing export segment is not a readable workbook');
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const compressed = buffer.subarray(dataStart, dataStart + compSize);
    if (compressed.length !== compSize) throw invalid('packing export segment is not a readable workbook');
    let data;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = zlib.inflateRawSync(compressed);
    else throw invalid('packing export segment is not a readable workbook');
    files.set(name.replaceAll('\\', '/'), data);
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function decode(text) {
  return text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|lt|gt|quot|apos|amp);/g, (all, dec, hex) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[all.slice(1, -1)];
  });
}

function encode(text) {
  return String(text).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}

function texts(xml) {
  return [...xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((match) => decode(match[1]));
}

function columnIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref || '');
  if (!letters) throw invalid('packing export segment is not a readable workbook');
  let index = 0;
  for (const char of letters[0]) index = index * 26 + char.charCodeAt(0) - 64;
  return index - 1;
}

function columnName(index) {
  let n = index + 1;
  let name = '';
  while (n) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function worksheetName(files) {
  const workbook = files.get('xl/workbook.xml')?.toString('utf8') || '';
  const sheets = [...workbook.matchAll(/<(?:\w+:)?sheet\b[^>]*\br:id="([^"]+)"/g)];
  if (sheets.length !== 1) throw invalid('packing export segment must contain exactly one worksheet');
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') || '';
  const rel = new RegExp(`Id="${sheets[0][1]}"[^>]*Target="([^"]+)"`).exec(rels)
    || new RegExp(`Target="([^"]+)"[^>]*Id="${sheets[0][1]}"`).exec(rels);
  if (!rel) throw invalid('packing export segment is not a readable workbook');
  const target = rel[1].replace(/^\//, '');
  return target.startsWith('xl/') ? target : `xl/${target.replace(/^\.\.\//, '')}`;
}

function readTable(file) {
  const files = unzip(file);
  const sheet = files.get(worksheetName(files))?.toString('utf8');
  if (!sheet) throw invalid('packing export segment is not a readable workbook');
  const shared = texts(files.get('xl/sharedStrings.xml')?.toString('utf8') || '');
  const body = /<(?:\w+:)?sheetData\b[^>]*>([\s\S]*?)<\/(?:\w+:)?sheetData>/.exec(sheet)?.[1] || '';
  const rows = [];
  for (const row of body.matchAll(/<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
    const cells = [];
    for (const cell of row[2].matchAll(/<(?:\w+:)?c\b([^>]*)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const index = columnIndex(/\br="([A-Z]+)\d+"/.exec(cell[1])?.[1] || columnName(cells.length));
      const type = /\bt="([^"]+)"/.exec(cell[1])?.[1] || 'n';
      const value = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(cell[2] || '');
      let text = '';
      if (type === 's') {
        const pointer = Number(value?.[1]);
        if (!value || !Number.isInteger(pointer) || pointer < 0 || pointer >= shared.length) throw invalid('packing export segment is not a readable workbook');
        text = shared[pointer];
      } else if (type === 'inlineStr') text = texts(cell[2] || '').join('');
      else if (value) text = decode(value[1]);
      else if (type !== 'n') throw invalid('packing export segment is not a readable workbook');
      while (cells.length < index) cells.push('');
      cells[index] = text;
    }
    rows.push(cells);
  }
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  return rows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ''));
}

function writeTable(rows) {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const data = rows.map((row, rowIndex) => {
    const cells = Array.from({ length: width }, (_, index) => {
      const ref = `${columnName(index)}${rowIndex + 1}`;
      return `<c r="${ref}" t="inlineStr"><is><t>${encode(row[index] ?? '')}</t></is></c>`;
    }).join('');
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${data}</sheetData></worksheet>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="packing" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  const root = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
  return zipFiles([
    ['[Content_Types].xml', Buffer.from(types)],
    ['_rels/.rels', Buffer.from(root)],
    ['xl/workbook.xml', Buffer.from(workbook)],
    ['xl/_rels/workbook.xml.rels', Buffer.from(rels)],
    ['xl/worksheets/sheet1.xml', Buffer.from(sheet)],
  ]);
}

function mergeXlsx(files) {
  if (!files.length) return null;
  const tables = files.map(readTable);
  const header = tables.find((table) => table.length)?.[0];
  if (!header) return writeTable([]);
  const rows = [header];
  for (const table of tables) {
    if (!table.length) continue;
    if (table[0].length !== header.length || table[0].some((cell, index) => cell !== header[index])) {
      throw invalid('packing export segments do not share a header');
    }
    for (const row of table.slice(1)) {
      if (row.length !== header.length) throw invalid('packing export segments do not share a header');
      rows.push(row);
    }
  }
  return writeTable(rows);
}

module.exports = { mergeXlsx, readTable, writeTable, zipFiles };
