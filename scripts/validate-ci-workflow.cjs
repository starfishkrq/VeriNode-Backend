const fs = require('fs');
const path = require('path');

const workflowPath = path.resolve(__dirname, '..', '.github', 'workflows', 'ci.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');

const requiredSnippets = [
  'concurrency:',
  'cancel-in-progress: true',
  'dorny/paths-filter@v3',
  'Warm dependency cache',
  'strategy:',
  'fail-fast: false',
  'CodeQL analyze',
  'npm audit --omit=dev --audit-level high',
  'docker/build-push-action@v6',
  'CI complete',
];

const missing = requiredSnippets.filter((snippet) => !workflow.includes(snippet));
if (missing.length > 0) {
  console.error('CI workflow is missing required optimization gates:');
  for (const snippet of missing) console.error(`- ${snippet}`);
  process.exit(1);
}

const shardMatches = [...workflow.matchAll(/^\s*- shard: ([a-z-]+)$/gm)].map((match) => match[1]);
const uniqueShards = new Set(shardMatches);
if (uniqueShards.size < 3) {
  console.error(`Expected at least 3 test shards, found ${uniqueShards.size}.`);
  process.exit(1);
}

console.log(`Validated ${uniqueShards.size} CI test shards and required optimization gates.`);
