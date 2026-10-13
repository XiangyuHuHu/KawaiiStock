import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DATA_DIR } from '../paths.js';

export const AUDIT_PATH = join(DATA_DIR, 'risk', 'audit.jsonl');

/** append-only。策略和 AI 不得删改历史。 */
export async function appendAudit(event) {
  await mkdir(dirname(AUDIT_PATH), { recursive: true });
  const row = {
    at: new Date().toISOString(),
    ...event
  };
  await appendFile(AUDIT_PATH, `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}
