import fs from 'node:fs';
const payload = JSON.parse(fs.readFileSync(new URL('../sample-packs/it-meetings-starter.json', import.meta.url)));
if (payload.schema_version !== 1) throw new Error('Sample schema_version must be 1');
if (!Array.isArray(payload.items) || !payload.items.length) throw new Error('Sample needs items');
for (const item of payload.items) {
  if (!item.term || !item.type || !item.meaning) throw new Error(`Invalid item ${item.term || '(missing term)'}`);
  if (!Array.isArray(item.examples) || item.examples.length !== 5) throw new Error(`${item.term} must have five examples`);
}
console.log(`Sample pack valid: ${payload.items.length} items.`);
