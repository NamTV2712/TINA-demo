import {readFileSync,readdirSync} from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
const validate=new Ajv2020({strict:true}).compile(JSON.parse(readFileSync(new URL('./transcript-refinement.schema.json',import.meta.url))));
for(const name of readdirSync(new URL('./golden/',import.meta.url)).filter(name=>name.endsWith('.json'))){const doc=JSON.parse(readFileSync(new URL('./golden/'+name,import.meta.url)));if(!validate(doc))throw Error(JSON.stringify(validate.errors));}
console.log('transcript-refinement.v1 goldens valid');
