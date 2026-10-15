import { createHash } from 'node:crypto';

export function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

export function stableString(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableString(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableString(value[key])}`).join(',')}}`;
}

export function stableHash(value) {
  return sha256(stableString(value));
}
