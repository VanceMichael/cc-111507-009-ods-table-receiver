import { unzipSync } from 'fflate';

// ODS 是 ZIP 容器，结构化读取只依赖 content.xml。
// 解析在“逻辑坐标”上进行：行列重复只做算术推进，不把重复次数展开成内存对象。
// XML 使用单遍流式扫描（生成器事件 + 显式状态栈）：巨型重复段不展开、不缓存全部事件，
// 且不执行任何实体声明（DOCTYPE/ENTITY/CDATA 直接拒绝）。

const NS_TABLE = 'table:';
const NS_TEXT = 'text:';
const NS_OFFICE = 'office:';

const SUPPORTED_VALUE_TYPES = new Set(['string', 'float', 'boolean', 'date', 'time']);
const BOOLEAN_VALUES = new Set(['true', 'false']);
const NAMED_ENTITIES = { lt: '<', gt: '>', amp: '&', apos: "'", quot: '"' };

// 防御性上限：只对真正要输出的语义记录计数，重复空白不受此限。
export const DEFAULT_RECORD_LIMIT = 100000;

export class OdsParseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OdsParseError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 流式 XML 扫描生成器：逐个产出 start/end/text 事件，不保留文档级缓冲。
// ---------------------------------------------------------------------------
function* scanXml(xml) {
  const length = xml.length;
  let index = 0;
  let textStart = 0;

  const flushText = function* (end) {
    if (end > textStart) yield { type: 'text', value: decodeEntities(xml.slice(textStart, end)) };
  };

  while (index < length) {
    if (xml.charCodeAt(index) !== 60 /* < */) {
      const next = xml.indexOf('<', index);
      index = next === -1 ? length : next;
      continue;
    }
    yield* flushText(index);
    const mark = xml[index + 1];

    if (mark === '?') {
      const close = xml.indexOf('?>', index + 2);
      if (close === -1) throw new OdsParseError('xml-invalid', 'XML 声明未闭合');
      index = close + 2;
      textStart = index;
      continue;
    }
    if (mark === '!') {
      if (xml.startsWith('<!--', index)) {
        const close = xml.indexOf('-->', index + 4);
        if (close === -1) throw new OdsParseError('xml-invalid', 'XML 注释未闭合');
        index = close + 3;
        textStart = index;
        continue;
      }
      throw new OdsParseError('forbidden-doctype', 'content.xml 禁止 DOCTYPE、ENTITY 与 CDATA 段');
    }

    const closing = mark === '/';
    const nameStart = closing ? index + 2 : index + 1;
    let cursor = nameStart;
    while (cursor < length && !isNameDelimiter(xml.charCodeAt(cursor))) cursor += 1;
    const name = xml.slice(nameStart, cursor);
    if (!name) throw new OdsParseError('xml-invalid', 'XML 标签名缺失');

    if (closing) {
      while (cursor < length && xml.charCodeAt(cursor) !== 62) cursor += 1;
      if (cursor >= length) throw new OdsParseError('xml-invalid', `结束标签 ${name} 未闭合`);
      cursor += 1;
      yield { type: 'end', name };
    } else {
      const attributes = {};
      let selfClosing = false;
      while (cursor < length) {
        while (cursor < length && isWhitespace(xml.charCodeAt(cursor))) cursor += 1;
        if (xml.charCodeAt(cursor) === 62 /* > */) { cursor += 1; break; }
        if (xml.charCodeAt(cursor) === 47 /* / */ && xml.charCodeAt(cursor + 1) === 62) {
          selfClosing = true;
          cursor += 2;
          break;
        }
        const attrNameStart = cursor;
        while (cursor < length && !isWhitespace(xml.charCodeAt(cursor)) &&
               xml.charCodeAt(cursor) !== 61 && xml.charCodeAt(cursor) !== 62 &&
               xml.charCodeAt(cursor) !== 47) cursor += 1;
        const attrName = xml.slice(attrNameStart, cursor);
        if (!attrName) throw new OdsParseError('xml-invalid', 'XML 属性语法无效');
        while (cursor < length && isWhitespace(xml.charCodeAt(cursor))) cursor += 1;
        if (xml.charCodeAt(cursor) !== 61) throw new OdsParseError('xml-invalid', `属性 ${attrName} 缺少取值`);
        cursor += 1;
        while (cursor < length && isWhitespace(xml.charCodeAt(cursor))) cursor += 1;
        const quote = xml.charCodeAt(cursor);
        if (quote !== 39 && quote !== 34) throw new OdsParseError('xml-invalid', `属性 ${attrName} 必须使用引号`);
        cursor += 1;
        const valueStart = cursor;
        while (cursor < length && xml.charCodeAt(cursor) !== quote) cursor += 1;
        if (cursor >= length) throw new OdsParseError('xml-invalid', `属性 ${attrName} 未闭合`);
        attributes[attrName] = decodeEntities(xml.slice(valueStart, cursor));
        cursor += 1;
      }
      yield { type: 'start', name, attributes };
      if (selfClosing) yield { type: 'end', name };
    }
    index = cursor;
    textStart = index;
  }
  yield* flushText(length);
}

function isWhitespace(code) {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

function isNameDelimiter(code) {
  return isWhitespace(code) || code === 62 /* > */ || code === 47 /* / */;
}

function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const codePoint = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : Number(body.slice(1));
      if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
        throw new OdsParseError('xml-invalid', `非法数字实体 ${match}`);
      }
      return String.fromCodePoint(codePoint);
    }
    const named = NAMED_ENTITIES[body];
    if (named === undefined) throw new OdsParseError('xml-invalid', `未声明的实体 ${match}`);
    return named;
  });
}

function localName(name) {
  const index = name.indexOf(':');
  return index === -1 ? name : name.slice(index + 1);
}

function attr(attributes, namespace, name) {
  const value = attributes[`${namespace}${name}`];
  return value === undefined ? undefined : value;
}

function positiveRepeat(attributes, namespace, name, issues, sheetName, row, column) {
  const raw = attr(attributes, namespace, name);
  if (raw === undefined) return 1;
  if (!/^\d+$/.test(raw)) {
    issues.push({ code: 'unsupported-feature', sheet: sheetName, row, column,
      message: `重复次数不是非负整数：${raw}` });
    return 1;
  }
  return Number(raw);
}

function spanCount(attributes, namespace, name, issues, sheetName, row, column) {
  const raw = attr(attributes, namespace, name);
  if (raw === undefined) return 1;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    issues.push({ code: 'unsupported-feature', sheet: sheetName, row, column,
      message: `跨度值无效：${raw}` });
    return 1;
  }
  return Number(raw);
}

export function columnLabel(column) {
  let label = '';
  let current = column;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    current = Math.floor((current - 1) / 26);
  }
  return label;
}

function cellRef(row, column) {
  return `${columnLabel(column)}${row}`;
}

// 解析 ZIP，只取 content.xml；不读取任何其它部件或外部资源。
function readContentXml(bytes) {
  let entries;
  try {
    entries = unzipSync(new Uint8Array(bytes));
  } catch (error) {
    throw new OdsParseError('zip-invalid', `ODS 容器无法解压：${error.message}`);
  }
  const content = entries['content.xml'];
  if (!content) throw new OdsParseError('content-missing', 'ODS 容器缺少 content.xml');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch (error) {
    throw new OdsParseError('content-invalid', `content.xml 不是合法 UTF-8：${error.message}`);
  }
}

function buildValue(attributes, text, issues, sheetName, row, column) {
  const valueType = attr(attributes, NS_OFFICE, 'value-type');
  if (valueType === undefined) {
    // 无值类型：显式空单元格（可能仍携带公式，但没有缓存值）。
    return { valueType: null, value: null, explicitEmpty: true };
  }
  if (!SUPPORTED_VALUE_TYPES.has(valueType)) {
    issues.push({ code: 'unsupported-type', sheet: sheetName, row, column,
      message: `未支持的值类型 ${valueType}，已保留原文文本` });
    return { valueType, value: null, explicitEmpty: false, unsupported: true };
  }
  if (valueType === 'string') {
    const officeValue = attr(attributes, NS_OFFICE, 'string-value');
    return { valueType, value: officeValue !== undefined ? officeValue : text, explicitEmpty: false };
  }
  if (valueType === 'float') {
    const raw = attr(attributes, NS_OFFICE, 'value');
    if (raw === undefined || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) {
      issues.push({ code: 'bad-number', sheet: sheetName, row, column,
        message: `float 单元格缺少可用缓存数值：${raw ?? '（无 office:value）'}` });
      return { valueType, value: null, explicitEmpty: false };
    }
    return { valueType, value: Number(raw), explicitEmpty: false };
  }
  if (valueType === 'boolean') {
    const raw = attr(attributes, NS_OFFICE, 'boolean-value');
    if (!BOOLEAN_VALUES.has(raw)) {
      issues.push({ code: 'bad-number', sheet: sheetName, row, column,
        message: `boolean 单元格缓存值无效：${raw ?? '（无 office:boolean-value）'}` });
      return { valueType, value: null, explicitEmpty: false };
    }
    return { valueType, value: raw === 'true', explicitEmpty: false };
  }
  // date / time：缓存即 ISO 词法串，原样保留，不做时区换算。
  const key = valueType === 'date' ? 'date-value' : 'time-value';
  const raw = attr(attributes, NS_OFFICE, key);
  if (raw === undefined) {
    issues.push({ code: 'missing-cache', sheet: sheetName, row, column,
      message: `${valueType} 单元格缺少缓存值 office:${key}` });
    return { valueType, value: null, explicitEmpty: false };
  }
  return { valueType, value: raw, explicitEmpty: false };
}

function normalizeTables(tables) {
  if (tables === undefined) return new Map();
  if (!Array.isArray(tables)) throw new OdsParseError('region-invalid', 'tables 必须是数组');
  const requested = new Map();
  for (const entry of tables) {
    if (!entry || typeof entry !== 'object' || typeof entry.sheet !== 'string' || entry.sheet === '') {
      throw new OdsParseError('region-invalid', 'tables 每项必须包含非空 sheet 名称');
    }
    let region = null;
    if (entry.region !== undefined) {
      if (!Array.isArray(entry.region) || entry.region.length !== 4 ||
          entry.region.some(n => !Number.isInteger(n) || n < 1)) {
        throw new OdsParseError('region-invalid',
          'region 必须是 [minColumn,minRow,maxColumn,maxRow]，均为 >=1 的整数');
      }
      const [minColumn, minRow, maxColumn, maxRow] = entry.region;
      if (maxColumn < minColumn || maxRow < minRow) {
        throw new OdsParseError('region-invalid', 'region 的上界不得小于下界');
      }
      region = entry.region;
    }
    // 同一 sheet 给多个条目时按多矩形处理；单条目即文档约定的单个闭合矩形。
    if (!requested.has(entry.sheet)) requested.set(entry.sheet, []);
    if (region) requested.get(entry.sheet).push(region);
  }
  return requested;
}

// 主入口：返回 { records, issues, coverage }，全部坐标从 1 起。
export function parseOds(bytes, options = {}) {
  const { tables: tableSpec, recordLimit = DEFAULT_RECORD_LIMIT } = options;
  const requested = normalizeTables(tableSpec);
  const events = scanXml(readContentXml(bytes));

  const records = [];
  const issues = [];
  const sheets = [];
  const seenCoordinates = new Set();
  let limited = false;
  let anyTableElement = false;

  const addRecord = record => {
    if (records.length >= recordLimit) {
      if (!limited) {
        limited = true;
        issues.push({ code: 'record-limit', sheet: record.sheet, row: record.row, column: record.column,
          message: `语义记录达到上限 ${recordLimit}，后续记录未采集` });
      }
      return false;
    }
    records.push(record);
    return true;
  };

  // 状态栈：跳过整张子树或切换工作表时，用 depth 精确返回当前层级。
  let depth = 0;
  const sheetStack = [];

  for (const event of events) {
    if (event.type === 'start') {
      depth += 1;
      if (event.name === `${NS_TABLE}table`) {
        anyTableElement = true;
        const sheetName = attr(event.attributes, NS_TABLE, 'name') ?? '';
        if (sheetName === '') {
          issues.push({ code: 'unsupported-feature', sheet: '', row: null, column: null,
            message: '工作表缺少 table:name，已跳过' });
          sheetStack.push({ skip: true, depth });
          continue;
        }
        if (requested.size > 0 && !requested.has(sheetName)) {
          sheetStack.push({ skip: true, depth });
          continue;
        }
        sheetStack.push({ skip: false, depth, state: createSheetState(sheetName) });
      } else if (sheetStack.length > 0 && !sheetStack.at(-1).skip) {
        handleSheetStart(event, sheetStack.at(-1).state, context());
      }
    } else if (event.type === 'text') {
      if (sheetStack.length > 0 && !sheetStack.at(-1).skip) {
        handleSheetText(event, sheetStack.at(-1).state);
      }
    } else if (event.type === 'end') {
      if (event.name === `${NS_TABLE}table` && sheetStack.length > 0) {
        const frame = sheetStack.pop();
        if (!frame.skip) finalizeSheet(frame.state, context());
      } else if (sheetStack.length > 0 && !sheetStack.at(-1).skip) {
        handleSheetEnd(event, sheetStack.at(-1).state, context());
      }
      depth -= 1;
    }
  }

  // 仅当文档里连一个 table:table 都没有时才算结构损坏；请求表缺失走 sheet-missing 问题。
  if (!anyTableElement) {
    throw new OdsParseError('structure-invalid', 'content.xml 缺少 office:spreadsheet/table:table 结构');
  }

  for (const sheetName of requested.keys()) {
    if (!sheets.some(item => item.sheet === sheetName)) {
      issues.push({ code: 'sheet-missing', sheet: sheetName, row: null, column: null,
        message: '来源台账不包含请求的工作表' });
    }
  }

  const requestedSheets = requested.size > 0
    ? [...requested.entries()].map(([sheet, regions]) => ({ sheet, regions }))
    : sheets.map(item => ({ sheet: item.sheet, regions: [] }));

  return {
    records,
    issues,
    coverage: {
      structured: true,
      requestedSheets,
      sheets,
      recordCount: records.length,
      issueCount: issues.length,
      recordLimit,
      truncated: limited,
    },
  };

  function context() {
    return { requested, records, issues, sheets, seenCoordinates, addRecord,
      isTruncated: () => limited };
  }
}

function createSheetState(sheetName) {
  return {
    sheetName,
    cursorRow: 1,
    // 当前行：rowRepeat 与按文档顺序排列的单元格描述。
    currentRow: null,
    // 单元格体内文本累积。
    cell: null,
    // 活动合并矩形，原点之外的逻辑位置由覆盖格占位。
    activeMerges: [],
    coverage: {
      sheet: sheetName, maxRow: 0, maxColumn: 0, recordCount: 0,
      explicitEmptyCells: 0, coveredCells: 0, merged: [],
    },
  };
}

function handleSheetStart(event, state, ctx) {
  const { sheetName } = state;
  if (event.name === `${NS_TABLE}table-row`) {
    state.currentRow = {
      repeat: positiveRepeat(event.attributes, NS_TABLE, 'number-rows-repeated',
        ctx.issues, sheetName, state.cursorRow, null),
      cells: [],
    };
    return;
  }
  if (!state.currentRow) return;

  if (event.name === `${NS_TABLE}table-cell` || event.name === `${NS_TABLE}covered-table-cell`) {
    const kind = localName(event.name) === 'covered-table-cell' ? 'covered' : 'cell';
    state.cell = {
      kind,
      name: event.name,
      attributes: event.attributes,
      paragraphs: [],
      buffer: '',
    };
    state.currentRow.cells.push(state.cell);
    return;
  }

  if (state.cell && event.name === `${NS_TEXT}s`) {
    const raw = attr(event.attributes, NS_TEXT, 'c');
    const count = raw === undefined ? 1 : (/^\d+$/.test(raw) ? Math.min(Number(raw), 256) : 1);
    state.cell.buffer += ' '.repeat(count);
  } else if (state.cell && event.name === `${NS_TEXT}line-break`) {
    state.cell.buffer += '\n';
  } else if (state.cell && event.name === `${NS_TEXT}tab`) {
    state.cell.buffer += '\t';
  } else if (state.cell && event.name.startsWith(NS_TEXT) &&
             localName(event.name) !== 'span' && localName(event.name) !== 'p') {
    ctx.issues.push({ code: 'unsupported-feature', sheet: sheetName, row: null, column: null,
      message: `未支持的文本元素 <${event.name}>，仅保留其文字内容` });
  }
}

function handleSheetText(event, state) {
  if (state.cell) state.cell.buffer += event.value;
}

function handleSheetEnd(event, state, ctx) {
  if (state.cell && event.name === `${NS_TEXT}p`) {
    state.cell.paragraphs.push(state.cell.buffer);
    state.cell.buffer = '';
    return;
  }
  if (state.cell && event.name === state.cell.name) {
    state.cell = null;
    return;
  }
  if (event.name === `${NS_TABLE}table-row`) {
    emitRow(state, ctx);
    state.currentRow = null;
  }
}

// 统计一个行块 × 列块中落在请求 region 内的逻辑格数；无 region 时整块计入。纯算术，不展开。
function countInRegions(requested, sheetName, rowStart, rowCount, colStart, colCount) {
  const list = requested.get(sheetName);
  if (!list || list.length === 0) return rowCount * colCount;
  const rowEnd = rowStart + rowCount - 1;
  const colEnd = colStart + colCount - 1;
  let total = 0;
  for (const [minColumn, minRow, maxColumn, maxRow] of list) {
    const rLo = Math.max(rowStart, minRow);
    const rHi = Math.min(rowEnd, maxRow);
    const cLo = Math.max(colStart, minColumn);
    const cHi = Math.min(colEnd, maxColumn);
    if (rHi >= rLo && cHi >= cLo) total += (rHi - rLo + 1) * (cHi - cLo + 1);
  }
  return total;
}

// 该工作表是否被显式 region 约束；未约束时不为空白尾部造任何计数或记录。
function hasRegions(requested, sheetName) {
  const list = requested.get(sheetName);
  return Array.isArray(list) && list.length > 0;
}

// 返回某一行内、单元格实例（按 columnSpan 间隔排列）中位于 region 的实例列段；无 region 即全部。
function instanceColumnSegments(requested, sheetName, row, startColumn, repeat, columnSpan) {
  const lastInstance = startColumn + (repeat - 1) * columnSpan;
  const list = requested.get(sheetName);
  if (!list || list.length === 0) return [[startColumn, lastInstance]];
  const segments = [];
  for (const [minColumn, minRow, maxColumn, maxRow] of list) {
    if (row < minRow || row > maxRow) continue;
    // 实例列 startColumn + k*columnSpan（k ∈ [0,repeat)）中落入 [minColumn,maxColumn] 的 k 范围。
    const kLo = Math.max(0, Math.ceil((minColumn - startColumn) / columnSpan));
    const kHi = Math.min(repeat - 1, Math.floor((maxColumn - startColumn) / columnSpan));
    if (kHi >= kLo) segments.push([startColumn + kLo * columnSpan, startColumn + kHi * columnSpan]);
  }
  return segments;
}

// 统计行块内某列段中被活动合并矩形覆盖的格数，并回报未被合并覆盖的列段。
function coveredOverBlock(state, requested, sheetName, rowStart, rowCount, colStart, colEnd) {
  const rowEnd = rowStart + rowCount - 1;
  const hits = [];
  for (const merge of state.activeMerges) {
    const rLo = Math.max(rowStart, merge.originRow);
    const rHi = Math.min(rowEnd, merge.originRow + merge.rowSpan - 1);
    if (rHi < rLo) continue;
    const cLo = Math.max(colStart, merge.originColumn);
    const cHi = Math.min(colEnd, merge.originColumn + merge.columnSpan - 1);
    if (cHi < cLo) continue;
    // 合并矩形与本行块相交的行数 × 相交列段中位于 region 的格数。
    const rows = rHi - rLo + 1;
    const regionCells = countInRegions(requested, sheetName, rLo, rows, cLo, cHi - cLo + 1);
    if (regionCells > 0) hits.push([cLo, cHi, regionCells]);
  }
  hits.sort((a, b) => a[0] - b[0]);

  let covered = 0;
  const uncovered = [];
  let cursor = colStart;
  for (const [cLo, cHi, regionCells] of hits) {
    if (cLo > cursor) uncovered.push([cursor, cLo - 1]);
    cursor = Math.max(cursor, cHi + 1);
    covered += regionCells;
  }
  if (cursor <= colEnd) uncovered.push([cursor, colEnd]);
  return { covered, uncovered };
}

// 一行事件读完后，按逻辑坐标把单元格描述落实为记录；行重复只做算术复用。
function emitRow(state, ctx) {
  const { sheetName, currentRow, coverage } = state;
  if (!currentRow) return;
  const { repeat: rowRepeat, cells } = currentRow;

  // 预解析每个单元格描述一次（行重复之间共享），避免在重复中重复计算。
  const described = cells.map(cell => {
    const text = cell.paragraphs.join('\n');
    const repeat = positiveRepeat(cell.attributes, NS_TABLE, 'number-columns-repeated',
      ctx.issues, sheetName, state.cursorRow, null);
    const columnSpan = cell.kind === 'cell'
      ? spanCount(cell.attributes, NS_TABLE, 'number-columns-spanned', ctx.issues, sheetName, state.cursorRow, null)
      : 1;
    const rowSpan = cell.kind === 'cell'
      ? spanCount(cell.attributes, NS_TABLE, 'number-rows-spanned', ctx.issues, sheetName, state.cursorRow, null)
      : 1;
    const formula = cell.kind === 'cell' ? attr(cell.attributes, NS_TABLE, 'formula') : undefined;
    const valueInfo = cell.kind === 'cell'
      ? buildValue(cell.attributes, text, ctx.issues, sheetName, state.cursorRow, null)
      : { valueType: null, value: null, explicitEmpty: false };
    const hasSemanticContent = cell.kind === 'cell' &&
      (valueInfo.valueType !== null || formula !== undefined ||
        (cell.paragraphs.length > 0 && text !== ''));
    return { cell, text, repeat, columnSpan, rowSpan, formula, valueInfo, hasSemanticContent,
      paragraphCount: cell.paragraphs.length };
  });

  // 整块都是空白/覆盖格的重复行（典型如 1e6×1e6 尾部）：用矩形算术一次性处理，绝不逐格逐行展开。
  if (!described.some(item => item.hasSemanticContent)) {
    emitBlankBlock(state, ctx, described, rowRepeat);
    state.cursorRow += rowRepeat;
    reclaimMerges(state);
    return;
  }

  for (let rowOffset = 0; rowOffset < rowRepeat; rowOffset += 1) {
    if (ctx.isTruncated()) break;
    const row = state.cursorRow + rowOffset;
    let column = 1;

    for (const item of described) {
      const { cell, repeat, columnSpan, rowSpan, formula, valueInfo, text, paragraphCount } = item;

      if (cell.kind === 'covered') {
        // 覆盖格按 repeat 连续占位；引用合并原点但不复制值，也不产生记录。
        const { covered, uncovered } = coveredOverBlock(state, ctx.requested, sheetName,
          row, 1, column, column + repeat - 1);
        coverage.coveredCells += covered;
        for (const [lo, hi] of uncovered) {
          ctx.issues.push({ code: 'covered-without-merge', sheet: sheetName, row, column: lo,
            endColumn: hi, message: '覆盖格不在任何合并矩形内' });
        }
        column += repeat;
        continue;
      }

      if (columnSpan > 1) {
        // 跨度只定义合并矩形的几何；列游标由后续覆盖格或 repeat 推进，不按跨度倍增。
        registerMergesForRun(state, coverage, ctx, sheetName, row, column, repeat, columnSpan, rowSpan);
      }

      if (!item.hasSemanticContent) {
        // 重复空白：算术跳过；仅在请求了 region 时统计其中显式空值，不为未提供区域造格。
        if (valueInfo.explicitEmpty && hasRegions(ctx.requested, sheetName)) {
          coverage.explicitEmptyCells += countInRegions(ctx.requested, sheetName,
            row, 1, column, repeat);
        }
        column += repeat;
        continue;
      }

      if (valueInfo.valueType === null && paragraphCount > 0 && text !== '') {
        ctx.issues.push({ code: 'unsupported-type', sheet: sheetName, row, column,
          message: '单元格含文本但缺少 office:value-type，已保留原文文本' });
      }

      // 单元格实例按跨度间隔排列（repeat×span）；只遍历与 region 相交的实例，受 recordLimit 约束。
      for (const [segLo, segHi] of
           instanceColumnSegments(ctx.requested, sheetName, row, column, repeat, columnSpan)) {
        for (let logicalColumn = segLo; logicalColumn <= segHi; logicalColumn += columnSpan) {
          if (ctx.isTruncated()) break;
          const coordinateKey = `${sheetName}!${row}!${logicalColumn}`;
          if (ctx.seenCoordinates.has(coordinateKey)) {
            ctx.issues.push({ code: 'cell-collision', sheet: sheetName, row, column: logicalColumn,
              message: '同一逻辑坐标出现重复存储，保留首次采得值' });
            continue;
          }
          ctx.seenCoordinates.add(coordinateKey);

          let cache;
          if (formula !== undefined) {
            const hasCache = valueInfo.valueType !== null && valueInfo.value !== null;
            cache = hasCache ? 'cached' : 'missing';
            if (!hasCache) {
              ctx.issues.push({ code: 'missing-cache', sheet: sheetName, row, column: logicalColumn,
                message: '公式没有可用的 office 缓存值，未求值' });
            }
          }

          const record = {
            id: `${sheetName}!${cellRef(row, logicalColumn)}`,
            sheet: sheetName,
            row,
            column: logicalColumn,
            ref: cellRef(row, logicalColumn),
            valueType: valueInfo.valueType,
            value: valueInfo.value,
            text: paragraphCount > 0 ? text : undefined,
            explicitEmpty: valueInfo.explicitEmpty || undefined,
            formula: formula ?? undefined,
            cache: cache ?? undefined,
          };
          if (ctx.addRecord(record)) {
            coverage.recordCount += 1;
            coverage.maxRow = Math.max(coverage.maxRow, row);
            coverage.maxColumn = Math.max(coverage.maxColumn, logicalColumn);
          }
        }
      }
      // ODF：列游标只按 number-columns-repeated 推进；跨度位置由覆盖格占据。
      column += repeat;
    }
  }
  state.cursorRow += rowRepeat;
  reclaimMerges(state);
}

// 为一个 repeat×columnSpan 的非覆盖单元格登记全部合并矩形；只在与 region 相交时才有必要迭代。
function registerMergesForRun(state, coverage, ctx, sheetName, row, startColumn, repeat, columnSpan, rowSpan) {
  if (rowSpan > 1) {
    ctx.issues.push({ code: 'unsupported-feature', sheet: sheetName, row, column: startColumn,
      message: '跨行合并（table:number-rows-spanned）不在承诺范围内，仅登记矩形' });
  }
  for (let k = 0; k < repeat; k += 1) {
    const originColumn = startColumn + k * columnSpan;
    state.activeMerges.push({ originRow: row, originColumn, columnSpan, rowSpan });
    coverage.merged.push({ origin: cellRef(row, originColumn), row, column: originColumn, columnSpan, rowSpan });
  }
}

// 整块重复空白行：合并矩形与 region 都按区间算术统计，复杂度只与单元格描述数有关。
function emitBlankBlock(state, ctx, described, rowRepeat) {
  const { sheetName, coverage } = state;
  const rowStart = state.cursorRow;
  const regionRequested = hasRegions(ctx.requested, sheetName);
  let column = 1;
  for (const item of described) {
    const { cell, repeat, columnSpan, rowSpan } = item;
    if (cell.kind === 'covered') {
      const { covered, uncovered } = coveredOverBlock(state, ctx.requested, sheetName,
        rowStart, rowRepeat, column, column + repeat - 1);
      coverage.coveredCells += covered;
      for (const [lo, hi] of uncovered) {
        ctx.issues.push({ code: 'covered-without-merge', sheet: sheetName, row: rowStart,
          endRow: rowStart + rowRepeat - 1, column: lo, endColumn: hi,
          message: '覆盖格不在任何合并矩形内' });
      }
    } else if (columnSpan > 1) {
      // 空白合并格：登记矩形，覆盖位置仍不产生记录。
      for (let rowOffset = 0; rowOffset < rowRepeat; rowOffset += 1) {
        registerMergesForRun(state, coverage, ctx, sheetName,
          rowStart + rowOffset, column, repeat, columnSpan, rowSpan);
      }
      if (item.valueInfo.explicitEmpty && regionRequested) {
        coverage.explicitEmptyCells += countInRegions(ctx.requested, sheetName,
          rowStart, rowRepeat, column, repeat);
      }
    } else if (item.valueInfo.explicitEmpty && regionRequested) {
      coverage.explicitEmptyCells += countInRegions(ctx.requested, sheetName,
        rowStart, rowRepeat, column, repeat);
    }
    column += repeat;
  }
}

function reclaimMerges(state) {
  for (let index = state.activeMerges.length - 1; index >= 0; index -= 1) {
    if (state.activeMerges[index].originRow + state.activeMerges[index].rowSpan <= state.cursorRow) {
      state.activeMerges.splice(index, 1);
    }
  }
}

function finalizeSheet(state, ctx) {
  ctx.sheets.push(state.coverage);
  const { sheetName, coverage } = state;
  if (ctx.requested.has(sheetName) && coverage.recordCount === 0 &&
      coverage.explicitEmptyCells === 0 && coverage.coveredCells === 0) {
    ctx.issues.push({ code: 'sheet-empty', sheet: sheetName, row: null, column: null,
      message: '请求的工作表或区域内没有采得任何单元格' });
  }
}
