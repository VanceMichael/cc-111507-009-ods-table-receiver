import { receiveBytes } from './http-client.mjs';
import { inspect } from './source-metadata.mjs';
import { parseOds, OdsParseError } from './ods-reader.mjs';

// 请求本身的结构/参数错误：不领取来源、不写收件，由服务层转 400。
export class RequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RequestError';
  }
}

export async function collect({ input, descriptor, sourceBase, store }) {
  if (input.mode === 'raw') return collectRaw({ descriptor, sourceBase, store });
  if (input.mode === 'structured') return collectStructured({ input, descriptor, sourceBase, store });
  throw new RequestError('接收方式无效');
}

async function collectRaw({ descriptor, sourceBase, store }) {
  const source = await receiveBytes(`${sourceBase}/files/${encodeURIComponent(descriptor.entry)}`);
  const blob = await store.blob(source.bytes);
  const receipt = await store.save({ state: 'received', mode: 'raw', product: descriptor.product,
    source: descriptor.entry, sourceVersion: source.etag, metadata: inspect(source.bytes), blobs: [blob],
    records: [], issues: [], coverage: { structured: false, downloadedBytes: source.bytes.length } });
  return { receipt };
}

async function collectStructured({ input, descriptor, sourceBase, store }) {
  validateStructuredInput(input);
  const source = await receiveBytes(`${sourceBase}/files/${encodeURIComponent(descriptor.entry)}`);
  const blob = await store.blob(source.bytes);
  const base = {
    mode: 'structured', product: descriptor.product, source: descriptor.entry,
    sourceVersion: source.etag, metadata: inspect(source.bytes), blobs: [blob],
  };

  let parsed;
  try {
    parsed = parseOds(source.bytes, { tables: input.tables });
  } catch (error) {
    if (error instanceof OdsParseError) {
      // 来源内容完全无法解释：保留原文证据，给 rejected，不靠抛异常丢掉字节。
      const receipt = await store.save({ ...base, state: 'rejected',
        records: [], issues: [{ code: error.code, sheet: null, row: null, column: null, message: error.message }],
        coverage: { structured: true, downloadedBytes: source.bytes.length, explainable: false } });
      return { httpStatus: 201, receipt };
    }
    throw error;
  }

  const { records, issues, coverage } = parsed;
  // 完全无法解释（没有任何采得记录）才 rejected；有问题但仍有记录为 partial；无缺口为 complete。
  const state = records.length === 0
    ? 'rejected'
    : (issues.length > 0 || coverage.truncated ? 'partial' : 'complete');
  const receipt = await store.save({ ...base, state, records, issues,
    coverage: { ...coverage, downloadedBytes: source.bytes.length, explainable: records.length > 0 } });
  return { httpStatus: 201, receipt };
}

// 仅校验请求形状；region 词法由 parseOds 统一解释，这里提前触发可在下载前给出 400。
function validateStructuredInput(input) {
  if (input.tables === undefined) return;
  if (!Array.isArray(input.tables)) throw new RequestError('tables 必须是数组');
  for (const entry of input.tables) {
    if (!entry || typeof entry !== 'object' || typeof entry.sheet !== 'string' || entry.sheet === '') {
      throw new RequestError('tables 每项必须包含非空 sheet 名称');
    }
    if (entry.region === undefined) continue;
    const region = entry.region;
    if (!Array.isArray(region) || region.length !== 4 ||
        region.some(n => !Number.isInteger(n) || n < 1) ||
        region[2] < region[0] || region[3] < region[1]) {
      throw new RequestError('region 必须是 [minColumn,minRow,maxColumn,maxRow]，均为 >=1 的整数且上界不小于下界');
    }
  }
}
