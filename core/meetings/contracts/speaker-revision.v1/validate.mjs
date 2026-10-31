import {readFileSync} from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
const ajv=new Ajv2020({strict:true});addFormats(ajv);
const validate=ajv.compile(JSON.parse(readFileSync(new URL('./speaker-revision.schema.json',import.meta.url))));
if(!validate(JSON.parse(readFileSync(new URL('./golden/Revision.json',import.meta.url)))))throw Error(JSON.stringify(validate.errors));
console.log('speaker-revision.v1 golden valid');
