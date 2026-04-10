#!/usr/bin/env npx tsx
// Quick test: run a debate locally or via proxy
// Usage: npx tsx scripts/debate-test.ts "Should we pursue Foresite?" [local|proxy]

import { bullBearDebate, redTeamDebate } from '../src/debate.js';

const topic = process.argv[2] || 'Should Carefront delay launch by 2 weeks to ensure broker pipeline?';
const mode = (process.argv[3] as 'local' | 'proxy') || 'local';

console.log(`\n🎯 Topic: ${topic}`);
console.log(`📡 Mode: ${mode}\n`);

const result = await bullBearDebate(topic, undefined, mode);

console.log('\n' + '='.repeat(60));
for (const turn of result.transcript) {
  console.log(`\n[${turn.agent} — Round ${turn.round}] (${(turn.durationMs / 1000).toFixed(1)}s)`);
  console.log(turn.content.slice(0, 500));
  if (turn.content.length > 500) console.log('...');
}

if (result.synthesis) {
  console.log('\n' + '='.repeat(60));
  console.log('\n[SYNTHESIS]');
  console.log(result.synthesis);
}

console.log(`\nTotal: ${(result.durationMs / 1000).toFixed(1)}s`);
console.log('Session IDs:', result.sessionIds);
