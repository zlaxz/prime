import { getDb } from './src/db.js';
import { scanOtter } from './src/connectors/otter.js';

async function main() {
  const db = getDb();
  console.log('Testing Otter scan (3 meetings)...');
  const result = await scanOtter(db, { days: 90, maxMeetings: 3, verbose: true });
  console.log('\nResult:', JSON.stringify(result));
}
main().catch(e => console.error('Error:', e.message, e.stack));
