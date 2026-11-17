import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { parseOds, OdsParseError, columnLabel } from '../src/ods-reader.mjs';

const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"';

function ods(body) {
  const xml = `<?xml version="1.0"?>${body}`;
  return Buffer.from(zipSync({ 'content.xml': strToU8(xml), mimetype: strToU8('x') }));
}
const sheet = inner =>
  `<office:document-content ${NS}><office:body><office:spreadsheet>${inner}</office:spreadsheet></office:body></office:document-content>`;
const table = (name, rows) => `<table:table table:name="${name}">${rows}</table:table>`;
const row = (cells, repeat) =>
  `<table:table-row${repeat ? ` table:number-rows-repeated="${repeat}"` : ''}>${cells}</table:table-row>`;
const cell = (inner, attrs = '') => {
  const prefix = attrs ? `<table:table-cell ${attrs}` : '<table:table-cell';
  return inner === '' ? `${prefix}/>` : `${prefix}>${inner}</table:table-cell>`;
};
const p = text => `<text:p>${text}</text:p>`;

test('逻辑坐标：行列重复按算术展开到正确坐标，但不产生空白记录', () => {
  const bytes = ods(sheet(table('S',
    row(cell(p('h1'), 'office:value-type="string"') + cell(p('h2'), 'office:value-type="string"')) +
    row(cell(p('A01'), 'office:value-type="string"') + cell(p('B01'), 'office:value-type="string"'), '3') +
    row('<table:table-cell table:number-columns-repeated="1000000"/>', '1000000'))));
  const r = parseOds(bytes);
  assert.equal(r.records.length, 8);
  assert.deepEqual(r.records.map(x => x.ref), ['A1', 'B1', 'A2', 'B2', 'A3', 'B3', 'A4', 'B4']);
  assert.equal(r.coverage.sheets[0].maxRow, 4);
  assert.equal(r.coverage.sheets[0].maxColumn, 2);
  // 未给 region：空白尾部既不造记录，也不计数，避免凭格式化范围制造货位。
  assert.equal(r.coverage.sheets[0].explicitEmptyCells, 0);
  assert.equal(r.issues.length, 0);
});

test('大表有效区域有限：1e6×1e6 空白尾部不展开、恒定耗时与内存', () => {
  const bytes = ods(sheet(table('S',
    row(cell(p('x'))) +
    row('<table:table-cell table:number-columns-repeated="1000000"/>', '1000000'))));
  const t0 = process.hrtime.bigint();
  const r = parseOds(bytes);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 200, `应恒定耗时，实际 ${ms}ms`);
  assert.equal(r.records.length, 1);
  assert.equal(r.coverage.sheets[0].recordCount, 1);
});

test('合并：覆盖格引用原点不复制值，原点记录值且登记矩形', () => {
  const bytes = ods(sheet(table('S',
    row(cell(p('M'), 'office:value-type="string" table:number-columns-spanned="2"') +
      '<table:covered-table-cell/>' + cell(p('Z'), 'office:value-type="string"')))));
  const r = parseOds(bytes);
  assert.deepEqual(r.records.map(x => x.ref), ['A1', 'C1']);
  assert.equal(r.coverage.sheets[0].coveredCells, 1);
  assert.deepEqual(r.coverage.sheets[0].merged[0],
    { origin: 'A1', row: 1, column: 1, columnSpan: 2, rowSpan: 1 });
  assert.equal(r.issues.length, 0);
});

test('region：只采逻辑闭合矩形内的语义格，区域外不造货位', () => {
  const bytes = ods(sheet(table('S',
    row(cell(p('a')) + cell(p('b')) + cell(p('c'))) +
    row(cell(p('d')) + cell(p('e')) + cell(p('f'))) +
    row('<table:table-cell table:number-columns-repeated="3"/>', '5'))));
  const r = parseOds(bytes, { tables: [{ sheet: 'S', region: [2, 1, 3, 2] }] });
  assert.deepEqual(r.records.map(x => x.ref), ['B1', 'C1', 'B2', 'C2']);
  // 空白尾部落在 region（行1-2）之外，不计数
  assert.equal(r.coverage.sheets[0].explicitEmptyCells, 0);
});

test('显式空值：region 内计数但不造记录，区域外忽略', () => {
  const bytes = ods(sheet(table('S',
    row('<table:table-cell/>' + cell(p('x'))) +
    row('<table:table-cell table:number-columns-repeated="4"/>'))));
  const r = parseOds(bytes, { tables: [{ sheet: 'S', region: [1, 1, 5, 2] }] });
  assert.deepEqual(r.records.map(x => x.ref), ['B1']);
  assert.equal(r.coverage.sheets[0].explicitEmptyCells, 5); // A1 + 第2行4格
});

test('公式缓存：有 office 缓存标 cached，缺失标 missing 且不求值', () => {
  const bytes = ods(sheet(table('S',
    row(cell(p('12'), 'office:value-type="float" office:value="12" table:formula="of:=6+6"')) +
    row(cell(p('12'), 'office:value-type="float" table:formula="of:=6+6"')))));
  const r = parseOds(bytes);
  assert.equal(r.records[0].cache, 'cached');
  assert.equal(r.records[0].value, 12);
  assert.equal(r.records[1].cache, 'missing');
  assert.equal(r.records[1].value, null);
  assert.ok(r.issues.some(i => i.code === 'missing-cache'));
});

test('值类型 string/float/boolean/date/time 各自解析', () => {
  const cells =
    cell(p('s'), 'office:value-type="string"') +
    cell(p('3.5'), 'office:value-type="float" office:value="3.5"') +
    cell('', 'office:value-type="boolean" office:boolean-value="true"') +
    cell('', 'office:value-type="date" office:date-value="2026-11-17"') +
    cell('', 'office:value-type="time" office:time-value="PT2H30M"');
  const r = parseOds(ods(sheet(table('S', row(cells)))));
  assert.deepEqual(r.records.map(x => x.value), ['s', 3.5, true, '2026-11-17', 'PT2H30M']);
  assert.deepEqual(r.records.map(x => x.valueType), ['string', 'float', 'boolean', 'date', 'time']);
});

test('text:s 重复空格与 text:line-break 保留', () => {
  const inner = '<text:p>a<text:s text:c="3"/>b<text:line-break/>c</text:p>';
  const r = parseOds(ods(sheet(table('S', row(cell(inner, 'office:value-type="string"'))))));
  assert.equal(r.records[0].value, 'a   b\nc');
});

test('稳定身份来自逻辑坐标而非数组下标', () => {
  const bytes = ods(sheet(table('S', row(cell(p('x'), 'table:number-columns-repeated="2"')))));
  const r = parseOds(bytes);
  assert.deepEqual(r.records.map(x => x.id), ['S!A1', 'S!B1']);
});

test('重复存储：同一逻辑坐标冲突时保留首次并报问题', () => {
  // 两张同名列在同一坐标各写一次（人为构造重复存储）
  const bytes = ods(sheet(
    table('S', row(cell(p('first'), 'office:value-type="string"'))) +
    table('S', row(cell(p('second'), 'office:value-type="string"')))));
  const r = parseOds(bytes);
  assert.equal(r.records.length, 1);
  assert.equal(r.records[0].value, 'first');
  assert.ok(r.issues.some(i => i.code === 'cell-collision'));
});

test('多工作表与请求过滤：未请求的表跳过，缺失表报问题', () => {
  const bytes = ods(sheet(table('A', row(cell(p('1')))) + table('B', row(cell(p('2'))))));
  const r = parseOds(bytes, { tables: [{ sheet: 'A' }, { sheet: 'GHOST' }] });
  assert.deepEqual(r.records.map(x => x.sheet), ['A']);
  assert.ok(r.issues.some(i => i.code === 'sheet-missing' && i.sheet === 'GHOST'));
});

test('无法解释：非 ODS zip、缺 content.xml、坏 XML、DOCTYPE 全部拒绝', () => {
  assert.throws(() => parseOds(Buffer.from('not a zip')), e => e.code === 'zip-invalid');
  assert.throws(() => parseOds(Buffer.from(zipSync({ 'other.xml': strToU8('<a/>') }))),
    e => e.code === 'content-missing');
  assert.throws(() => parseOds(ods('')), e => e.code === 'structure-invalid');
  const doctype = Buffer.from(zipSync({
    'content.xml': strToU8('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><office:document-content/>'),
  }));
  assert.throws(() => parseOds(doctype), e => e.code === 'forbidden-doctype');
  assert.ok(OdsParseError);
});

test('未支持值类型保留原文并报问题，不假装完整', () => {
  const bytes = ods(sheet(table('S', row(cell(p('=x'), 'office:value-type="percentage" office:value="0.5"')))));
  const r = parseOds(bytes);
  assert.ok(r.issues.some(i => i.code === 'unsupported-type'));
  assert.equal(r.records[0].valueType, 'percentage');
});

test('recordLimit 触发 truncated 并报问题，不无限增长', () => {
  const bytes = ods(sheet(table('S', row(cell(p('v'), 'table:number-columns-repeated="1000"')))));
  const r = parseOds(bytes, { recordLimit: 10 });
  assert.equal(r.records.length, 10);
  assert.equal(r.coverage.truncated, true);
  assert.ok(r.issues.some(i => i.code === 'record-limit'));
});

test('region 参数非法时抛中文错误', () => {
  const bytes = ods(sheet(table('S', row(cell(p('x'))))));
  assert.throws(() => parseOds(bytes, { tables: [{ sheet: 'S', region: [0, 1, 2, 2] }] }),
    e => e.code === 'region-invalid');
  assert.throws(() => parseOds(bytes, { tables: [{ sheet: 'S', region: [3, 1, 2, 2] }] }),
    e => e.code === 'region-invalid');
});

test('columnLabel 列号换算', () => {
  assert.equal(columnLabel(1), 'A');
  assert.equal(columnLabel(26), 'Z');
  assert.equal(columnLabel(27), 'AA');
  assert.equal(columnLabel(52), 'AZ');
});
