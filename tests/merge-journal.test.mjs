import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {webcrypto} from 'node:crypto';
const mod={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/storage/merge_journal.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:mod,exports:mod.exports,crypto:webcrypto,TextEncoder});
const {MergeJournal}=mod.exports;
const state=(text,revision='1')=>({baseContent:text,revision});
function adapter(){const files=new Map(),dirs=new Set();return {files,dirs,writes:[],exists:async p=>files.has(p)||dirs.has(p),read:async p=>{if(!files.has(p))throw Error('ENOENT');return files.get(p)},write:async function(p,s){this.writes.push({p,size:s.length});files.set(p,s)},mkdir:async p=>dirs.add(p),list:async p=>({files:[...files.keys()].filter(k=>k.startsWith(p+'/')),folders:[]}),rename:async(_from,to)=>{if(files.has(to))throw Error('Destination file already exists!');throw Error('rename must never be used')}}}
const make=a=>new MergeJournal({adapter:a,dir:'plugin/merge-journal',legacyPath:'plugin/merge-journal.json'});
{
 const a=adapter(),s=make(a);assert.deepEqual({...await s.load()},{});await s.save('a.md',state('one'));await s.save('a.md',state('two','2'));await s.save('a.md',state('three','3'));
 assert.equal(a.files.size,2);assert.equal((await make(a).load())['a.md'].baseContent,'three');
 const newest=[...a.files.entries()].find(([,v])=>JSON.parse(v).sequence===3)[0];a.files.set(newest,'{"torn":');assert.equal((await make(a).load())['a.md'].baseContent,'two');
}
{
 const a=adapter(),s=make(a);await s.load();await s.save('a.md',state('Aa'));await s.save('a.md',state('BB','2'));const newest=[...a.files.entries()].find(([,v])=>JSON.parse(v).sequence===2);a.files.set(newest[0],newest[1].replace('BB','Aa'));assert.equal((await make(a).load())['a.md'].baseContent,'Aa');
}
{
 const a=adapter();a.files.set('plugin/merge-journal.json',JSON.stringify({'a.md':state('legacy'),'b.md':state('kept')}));const s=make(a);assert.equal((await s.load())['a.md'].baseContent,'legacy');await s.save('a.md',state('new','2'));await s.save('b.md',null);const loaded=await make(a).load();assert.equal(loaded['a.md'].baseContent,'new');assert.equal(loaded['b.md'],undefined);
}
{
 const a=adapter(),s=make(a);await s.load();for(let i=0;i<120;i++)await s.save(`${i}.md`,state('x'.repeat(1000)));a.writes=[];await s.save('changed.md',state('short'));assert.equal(a.writes.length,1);assert.ok(a.writes[0].size<500);
}
{
 const a=adapter(),s=make(a);await s.load();await s.save('a.md',state('one'));for(const k of a.files.keys())a.files.set(k,'broken');await assert.rejects(make(a).load(),/No valid/);
}
{
 const a=adapter(),s=make(a);await s.load();const original=a.write;a.write=async()=>{throw Error('disk full')};await assert.rejects(s.save('a.md',state('one')),/disk full/);a.write=original;await s.save('a.md',state('recovered'));assert.equal((await make(a).load())['a.md'].baseContent,'recovered');
}
console.log('PASS sharded two-slot journal: adapter semantics, torn writes, checksum, migration, tombstones, bounded IO, failure recovery');
