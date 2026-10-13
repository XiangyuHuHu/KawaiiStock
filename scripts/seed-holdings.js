import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from '../src/paths.js';
import { loadAccounts, saveHoldings } from '../src/holdings.js';

const config = await loadAccounts();
for (const account of config.accounts) {
  const local = join(DATA_DIR, 'holdings', `${account.holdingsStem}.json`);
  const book = JSON.parse(await readFile(local, 'utf8'));
  await saveHoldings(account, book);
  console.log('seeded', account.id);
}
