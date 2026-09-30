import fs from 'node:fs';

const sampleNames = ['it-meetings-starter.json', 'details-test-pack.json', 'professional-communication-pack.json'];
for (const sampleName of sampleNames) {
  const payload = JSON.parse(fs.readFileSync(new URL(`../sample-packs/${sampleName}`, import.meta.url)));
  if (payload.schema_version !== 1) throw new Error(`${sampleName} schema_version must be 1`);
  if (!Array.isArray(payload.items) || !payload.items.length) throw new Error(`${sampleName} needs items`);
  for (const item of payload.items) {
    if (!item.term || !item.type || !item.meaning) throw new Error(`Invalid item ${item.term || '(missing term)'}`);
    if (!Array.isArray(item.examples) || item.examples.length !== 5) throw new Error(`${item.term} must have five examples`);
  }
  if (sampleName !== 'it-meetings-starter.json' && payload.items.some((item) => !item.explanation || !item.origin || !Array.isArray(item.synonyms) || !item.synonyms.length || !item.pronunciation)) {
    throw new Error(`${sampleName} needs explanation, origin, synonyms, and pronunciation for every item.`);
  }
  console.log(`Sample pack valid: ${sampleName} (${payload.items.length} items).`);
}
