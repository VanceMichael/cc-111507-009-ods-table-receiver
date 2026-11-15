function parseJson(bytes) { try { return JSON.parse(bytes.toString()); } catch { return null; } }
export function inspect(bytes) { return { format: 'ODS', zip: bytes.subarray(0,2).toString() === 'PK', compressedBytes: bytes.length }; }
