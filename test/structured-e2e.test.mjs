import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/server.mjs';

async function withService(scenario, fn) {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-e2e-'));
  const service = await createService({ dataDir, scenario });
  try { await fn(service); } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function structured(service, body) {
  const response = await fetch(`${service.baseUrl}/v1/intakes`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, result: await response.json() };
}

test('standard 场景：结构化收件 complete，记录含逻辑坐标与缓存标记', async () => {
  await withService('standard', async service => {
    const { status, result } = await structured(service,
      { mode: 'structured', tables: [{ sheet: '货位', region: [1, 1, 2, 3] }] });
    assert.equal(status, 201);
    assert.equal(result.state, 'complete');
    assert.ok(result.records.length >= 4);
    assert.ok(JSON.stringify(result.records).includes('A01'));
    const formula = result.records.find(r => r.formula);
    assert.equal(formula.cache, 'cached');
    assert.equal(result.coverage.structured, true);
    assert.equal(result.coverage.truncated, false);
  });
});

test('merged 场景：覆盖格不复制值，原点保留合并信息', async () => {
  await withService('merged', async service => {
    const { status, result } = await structured(service, { mode: 'structured' });
    assert.equal(status, 201);
    assert.ok(['complete', 'partial'].includes(result.state));
    const refs = result.records.map(r => r.ref);
    // 合并原点 A 列有值，被覆盖的 B 列不产生记录
    assert.ok(refs.includes('A2'));
    assert.ok(!refs.includes('B2'));
    const sheet = result.coverage.sheets.find(s => s.sheet === '货位');
    assert.ok(sheet.coveredCells >= 1);
    assert.ok(sheet.merged.some(m => m.columnSpan === 2));
  });
});

test('no-cache 场景：公式缺缓存标 missing，状态 partial 且不求值', async () => {
  await withService('no-cache', async service => {
    const { status, result } = await structured(service, { mode: 'structured' });
    assert.equal(status, 201);
    assert.equal(result.state, 'partial');
    const formula = result.records.find(r => r.formula);
    assert.equal(formula.cache, 'missing');
    assert.equal(formula.value, null);
    assert.ok(result.issues.some(i => i.code === 'missing-cache'));
  });
});

test('large-empty 场景：不展开百万空白尾部，只采有效区域', async () => {
  await withService('large-empty', async service => {
    const t0 = process.hrtime.bigint();
    const { status, result } = await structured(service, { mode: 'structured' });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(status, 201);
    assert.ok(ms < 500, `应恒定耗时，实际 ${ms}ms`);
    assert.equal(result.records.length, 6);
    const sheet = result.coverage.sheets.find(s => s.sheet === '货位');
    assert.equal(sheet.explicitEmptyCells, 0); // 无 region，不凭格式化范围造货位
  });
});

test('region 外的语义格不采集，且不产生空白货位', async () => {
  await withService('standard', async service => {
    const { status, result } = await structured(service,
      { mode: 'structured', tables: [{ sheet: '货位', region: [1, 1, 1, 1] }] });
    assert.equal(status, 201);
    assert.deepEqual(result.records.map(r => r.ref), ['A1']);
  });
});

test('请求不存在的工作表：rejected 且记录为零、问题可定位', async () => {
  await withService('standard', async service => {
    const { status, result } = await structured(service,
      { mode: 'structured', tables: [{ sheet: '不存在' }] });
    assert.equal(status, 201);
    assert.equal(result.state, 'rejected');
    assert.equal(result.records.length, 0);
    assert.ok(result.issues.some(i => i.code === 'sheet-missing' && i.sheet === '不存在'));
  });
});

test('非法 region：400 语法错误，不写成功收件', async () => {
  await withService('standard', async service => {
    const response = await fetch(`${service.baseUrl}/v1/intakes`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'structured', tables: [{ sheet: '货位', region: [0, 1, 2, 2] }] }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.ok(typeof body.error === 'string');
  });
});

test('结构化收件可持久化：新查询返回相同记录与覆盖信息', async () => {
  await withService('standard', async service => {
    const { result } = await structured(service,
      { mode: 'structured', tables: [{ sheet: '货位', region: [1, 1, 2, 3] }] });
    const saved = await (await fetch(`${service.baseUrl}/v1/receipts/${result.id}`)).json();
    assert.deepEqual(saved.records, result.records);
    assert.deepEqual(saved.coverage, result.coverage);
    assert.deepEqual(saved.issues, result.issues);
  });
});
