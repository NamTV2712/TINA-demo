#!/usr/bin/env node
/** gate:schema for tool-approval.v1 — golden `<Shape>.<case>.json` validates against #/$defs/<Shape>. */
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(HERE, "tool-approval.schema.json"), "utf8"));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(schema);

const dir = join(HERE, "golden");
const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
let failed = 0;
for (const file of files) {
  const shape = file.split(".")[0];
  const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/${shape}` });
  const data = JSON.parse(readFileSync(join(dir, file), "utf8"));
  if (validate(data)) console.log(`  ✓ ${file} ≡ ${shape}`);
  else { console.error(`  ✗ ${file} (${shape}): ${ajv.errorsText(validate.errors)}`); failed++; }
}
console.log(failed ? `tool-approval.v1: ${failed} golden(s) FAILED` : `tool-approval.v1: ${files.length} goldens conform`);
process.exit(failed ? 1 : 0);
