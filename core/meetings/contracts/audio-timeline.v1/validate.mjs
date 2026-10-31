import {readFileSync} from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
const validate=new Ajv2020({strict:true}).compile(JSON.parse(readFileSync(new URL('./audio-timeline.schema.json',import.meta.url))));
if(!validate(JSON.parse(readFileSync(new URL('./golden/Status.json',import.meta.url)))))throw new Error(JSON.stringify(validate.errors));
console.log('audio-timeline.v1 golden valid');
