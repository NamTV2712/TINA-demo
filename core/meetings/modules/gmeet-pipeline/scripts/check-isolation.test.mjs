import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const dir=mkdtempSync(join(tmpdir(),'tina-isolation-'));
try{
 mkdirSync(join(dir,'scripts'));mkdirSync(join(dir,'src'));
 writeFileSync(join(dir,'package.json'),JSON.stringify({type:'module'}));
 copyFileSync(new URL('./check-isolation.js',import.meta.url),join(dir,'scripts/check-isolation.js'));
 const run=()=>spawnSync(process.execPath,[join(dir,'scripts/check-isolation.js')],{encoding:'utf8'});
 writeFileSync(join(dir,'src/test.ts'),"import {mock} from 'node:test';\n");assert.equal(run().status,0,'real node:-only builtins are allowed');
 writeFileSync(join(dir,'src/test.ts'),"import x from 'node:undeclared';\n");assert.equal(run().status,1,'unknown node: specifiers are not trusted');
 writeFileSync(join(dir,'src/test.ts'),"import x from '@unowned/private';\n");assert.equal(run().status,1,'undeclared dependencies still fail');
 console.log('PASS isolation: node:test accepted; unknown builtins and undeclared packages rejected');
}finally{rmSync(dir,{recursive:true,force:true});}
