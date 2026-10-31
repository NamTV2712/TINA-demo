import { readFileSync, readdirSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
const ajv = new Ajv2020({ strict: true }); addFormats(ajv);
const validate = ajv.compile(JSON.parse(readFileSync(new URL('./transcript-alignment.schema.json', import.meta.url))));
for (const name of readdirSync(new URL('./golden/', import.meta.url)).filter(name => name.endsWith('.json'))) {
  const doc = JSON.parse(readFileSync(new URL('./golden/' + name, import.meta.url)));
  if (!validate(doc)) throw Error(JSON.stringify(validate.errors));
}
console.log('transcript-alignment.v1 goldens valid');
