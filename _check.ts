import { getDb, getConfig } from './src/db.js';
async function main() {
  const db = await getDb();
  const ctx = getConfig(db, 'business_context');
  console.log(ctx);
}
main();
