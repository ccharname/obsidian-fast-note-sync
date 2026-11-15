'use strict';
const assert=require('node:assert/strict');const {test}=require('node:test');
const {fixture,flush,FileUploadCoordinator,binaryFixture}=require('./file-upload-harness.cjs');

test('40 same-path uploads hold one body until its ACK',async()=>{
 const after=fixture();const tasks=Array.from({length:40},(_,i)=>after.submit('a.bin',i));await flush();assert.equal(after.state.reads.length,1);assert.equal(after.coordinator().active.size,1);assert.equal(after.coordinator().pending.length,39);
 for(let i=0;i<40;i++){assert.equal(after.state.reads.length,i+1);after.ack('a.bin');await flush();}await Promise.all(tasks);assert.equal(after.coordinator().active.size,0);assert.equal(after.coordinator().sessions.size,0);
});
test('same session repeated before and after ACK is consumed only once',async()=>{
 const f=fixture();const a=f.submit('a.bin','same'),b=f.submit('a.bin','same');await flush();assert.equal(f.state.reads.length,1);f.ack('a.bin');await Promise.all([a,b]);await f.submit('a.bin','same');assert.equal(f.state.reads.length,1);
});
test('different paths retain the 20-job cap and all queued jobs eventually run',async()=>{
 const f=fixture(),tasks=Array.from({length:25},(_,i)=>f.submit('f'+i+'.bin',i));await flush();assert.equal(f.state.reads.length,20);assert.equal(f.plugin.concurrencyLimiter.activeKeys.size,20);
 for(let i=0;i<25;i++){f.ack('f'+i+'.bin');await flush();assert(f.plugin.concurrencyLimiter.activeKeys.size<=20);}await Promise.all(tasks);assert.equal(f.state.reads.length,25);assert.equal(f.coordinator().pending.length,0);
});
test('a pre-held FileUploadCheck slot hands off at a full global limit without deadlock',async()=>{
 const f=fixture({limit:1});await f.plugin.concurrencyLimiter.waitForSlot('a.bin');const task=f.submit('a.bin',1);await flush();assert.equal(f.state.reads.length,1);assert.equal(f.plugin.concurrencyLimiter.queue.length,0);f.ack('a.bin');await task;
});
test('ordinary limiter callers do not acquire the explicit FileUpload handoff option',async()=>{
 const f=fixture({limit:1});await f.plugin.concurrencyLimiter.waitForSlot('a.bin');let acquired=false;const task=f.plugin.concurrencyLimiter.waitForSlot('b.bin').then(v=>{acquired=v;});await flush();assert.equal(acquired,false);f.plugin.concurrencyLimiter.releaseSlot('a.bin');await task;assert.equal(acquired,true);f.plugin.concurrencyLimiter.releaseSlot('b.bin');
});
test('disabled global limit still serializes duplicate paths; enabling restores cap',async()=>{
 const f=fixture({enabled:false,limit:1});const a=f.submit('a.bin',1),b=f.submit('b.bin',2),dup=f.submit('a.bin',3);await flush();assert.equal(f.state.reads.length,2);assert.equal(f.coordinator().active.size,2);
 f.ack('a.bin');await a;await flush();assert.equal(f.state.reads.length,3);f.ack('a.bin');f.ack('b.bin');await Promise.all([b,dup]);
 f.plugin.settings.concurrencyControlEnabled=true;const c=f.submit('c.bin',4),d=f.submit('d.bin',5);await flush();assert.equal(f.plugin.concurrencyLimiter.activeKeys.size,1);f.ack('c.bin');await c;await flush();f.ack('d.bin');await d;
});
test('body read failure and network failure release admission without caching a success',async()=>{
 let fail=true;const f=fixture({limit:1,read:async()=>{if(fail){fail=false;throw Error('disk failed');}return new ArrayBuffer(32768);}});await f.submit('a.bin','retry');assert.equal(f.coordinator().active.size,0);assert.equal(f.plugin.concurrencyLimiter.activeKeys.size,0);assert.equal(f.coordinator().completed.size,0);
 const retry=f.submit('a.bin','retry');await flush();f.ack('a.bin');await retry;
 const g=fixture({limit:1,sendMode:'throw'});await g.submit('a.bin',1);assert.equal(g.coordinator().active.size,0);assert.equal(g.plugin.concurrencyLimiter.activeKeys.size,0);assert.equal(g.coordinator().completed.size,0);
});
test('connection-closed send releases slot and allows a later retry',async()=>{
 const f=fixture({sendMode:'closed'});await f.submit('a.bin',1);assert.equal(f.coordinator().active.size,0);assert.equal(f.plugin.concurrencyLimiter.activeKeys.size,0);assert.equal(f.coordinator().sessions.size,0);
});
test('clear settles queued work and waits for uncancellable active read before admitting replacement',async()=>{
 let resolveRead;const f=fixture({limit:1,read:async()=>new Promise(resolve=>{resolveRead=resolve;})});const a=f.submit('a.bin',1),b=f.submit('b.bin',2);await flush();assert.equal(f.state.reads.length,1);
 f.plugin.concurrencyLimiter.clear();await b;assert.equal(f.coordinator().pending.length,0);const replacement=f.submit('c.bin',3);await flush();assert.equal(f.state.reads.length,1,'native read still holds coordinator admission');
 resolveRead(new ArrayBuffer(32768));await a;await flush();assert.equal(f.state.sends.length,0);assert.equal(f.state.reads.length,2);resolveRead(new ArrayBuffer(32768));await flush();f.ack('c.bin');await replacement;assert.equal(f.coordinator().active.size,0);
});
test('same-priority shared limiter waiters are FIFO without head-of-line blocking',async()=>{
 const f=fixture({limit:1});const a=f.submit('a.bin',1),a2=f.submit('a.bin',2),b=f.submit('b.bin',1),d=f.submit('d.bin',1);await flush();assert.deepEqual(f.state.reads,['a.bin']);
 f.ack('a.bin');await a;await flush();assert.deepEqual(f.state.reads,['a.bin','b.bin']);f.ack('b.bin');await b;await flush();assert.deepEqual(f.state.reads,['a.bin','b.bin','d.bin']);f.ack('d.bin');await d;await flush();assert.deepEqual(f.state.reads,['a.bin','b.bin','d.bin','a.bin']);f.ack('a.bin');await a2;
});

test('per-path cancellation removes queued sessions and permits a clean retry',async()=>{
 const c=new FileUploadCoordinator(()=>1);const a=c.run('a','1',async()=>true),b=c.run('a','2',async()=>true);c.cancel('a');assert.equal(await b,'cancelled');assert.equal(await a,'cancelled');const retry=c.run('a','1',async()=>true);c.acknowledge('a');assert.equal(await retry,'acknowledged');
});
test('completed-session cache is bounded and preserves in-flight metadata only',async()=>{
 const c=new FileUploadCoordinator(()=>1,undefined,4);for(let i=0;i<10;i++){const task=c.run('a',String(i),async()=>true);c.acknowledge('a');await task;}assert.equal(c.completed.size,4);assert.equal(c.sessions.size,0);assert.equal(c.pending.length,0);assert.equal(c.active.size,0);
});

test('session-not-found after body sent resolves the old session and preserves the next queued session',async()=>{
 const f=fixture({limit:1});const old=f.submit('a.bin',1),next=f.submit('a.bin',2);await flush();assert.equal(f.context.du.size,0,'legacy session table already removed by body finally');assert.equal(f.state.reads.length,1);
 f.missing(1);await old;await flush();assert.equal(f.plugin.fileSyncTasks.failed,1);assert.equal(f.state.reads.length,2);f.ack('a.bin');await next;assert.equal(f.coordinator().active.size,0);assert.equal(f.coordinator().completed.size,1);
});

test('A holds all 20 check slots; earlier B waiters cannot prevent A upload handoffs',async()=>{
 const f=fixture();for(let i=0;i<20;i++)await f.plugin.concurrencyLimiter.waitForSlot('A'+i+'.bin');
 const bs=Array.from({length:20},(_,i)=>f.submit('B'+i+'.bin','B'+i));await flush();assert.equal(f.state.reads.length,0);
 const as=Array.from({length:20},(_,i)=>f.submit('A'+i+'.bin','A'+i));await flush();assert.equal(f.state.reads.filter(x=>x.startsWith('A')).length,20,'existing check holders must not deadlock behind B');
 for(let i=0;i<20;i++){f.ack('A'+i+'.bin');await flush();}await Promise.all(as);await flush();assert.equal(f.state.reads.filter(x=>x.startsWith('B')).length,20);for(let i=0;i<20;i++)f.ack('B'+i+'.bin');await Promise.all(bs);
});

test('cancelled native reads keep both body slots across reconnect; replacement generation stays bounded',async()=>{
 const readers=[];const f=fixture({limit:2,read:async file=>new Promise(resolve=>readers.push({path:file.path,resolve}))});
 const a=f.submit('a.bin',1),b=f.submit('b.bin',2);await flush();assert.equal(f.coordinator().buffers.active,2);assert.equal(f.state.reads.length,2);
 f.plugin.concurrencyLimiter.clear();const c=f.submit('c.bin',3),d=f.submit('d.bin',4);await flush();assert.equal(f.state.reads.length,2);assert.equal(f.coordinator().buffers.pending.length,2);
 readers.find(x=>x.path==='a.bin').resolve(new ArrayBuffer(32768));await a;await flush();assert.equal(f.state.reads.length,3);assert.equal(f.coordinator().buffers.active,2);
 readers.find(x=>x.path==='b.bin').resolve(new ArrayBuffer(32768));await b;await flush();assert.equal(f.state.reads.length,4);assert.equal(f.coordinator().buffers.active,2);
 for(const p of ['c.bin','d.bin'])readers.find(x=>x.path===p).resolve(new ArrayBuffer(32768));await flush();assert.equal(f.coordinator().buffers.active,0);f.ack('c.bin');f.ack('d.bin');await Promise.all([c,d]);assert.equal(f.coordinator().buffers.pending.length,0);
});

test('cancelling a session waiting for a body gate does not wait for unrelated native reads',async()=>{
 const c=new FileUploadCoordinator(()=>1);let releaseFirst;const first=c.run('a','1',async ticket=>{await c.buffers.acquire(ticket);await new Promise(resolve=>{releaseFirst=resolve;});c.buffers.release();return true;});
 const second=c.run('b','2',async ticket=>{const acquired=await c.buffers.acquire(ticket);if(!acquired)return false;c.buffers.release();return true;});await flush();assert.equal(c.buffers.active,1);assert.equal(c.buffers.pending.length,1);c.cancelSession('2');assert.equal(await second,'cancelled');assert.equal(c.buffers.pending.length,0);assert.equal(c.buffers.active,1);releaseFirst();await flush();c.acknowledge('a');await first;
});

test('late cancelled read cannot release a new-generation check slot for the same path',async()=>{
 let done;const f=fixture({limit:1,read:()=>new Promise(resolve=>done=resolve)});const old=f.submit('a.bin','old');await flush();f.plugin.concurrencyLimiter.clear();await f.plugin.concurrencyLimiter.waitForSlot('a.bin');done(new ArrayBuffer(32768));await old;assert.equal(f.plugin.concurrencyLimiter.activeKeys.size,1);assert.equal(f.state.sends.length,0);
});
test('late old hash cannot overwrite pending hash or remove a replacement active-upload owner',async()=>{
 let done;const f=fixture({hash:()=>new Promise(resolve=>done=resolve)});const old=f.submit('a.bin','old');await flush();f.plugin.concurrencyLimiter.clear();await f.plugin.concurrencyLimiter.waitForSlot('a.bin');f.plugin.pendingUploadHashes.set('a.bin','new-generation-hash');const owner={cancelled:false,newGeneration:true};f.context.Nn.set('a.bin',owner);done('old-hash');await old;assert.equal(f.plugin.pendingUploadHashes.get('a.bin'),'new-generation-hash');assert.equal(f.context.Nn.get('a.bin'),owner);assert.equal(f.state.sends.length,0);assert.equal(f.plugin.concurrencyLimiter.activeKeys.size,1);
});
test('late send failure does not decrement new-round counters or release its slot',async()=>{
 let fail;const f=fixture({send:()=>new Promise((_resolve,reject)=>fail=reject)});const old=f.submit('a.bin','old');await flush();f.plugin.concurrencyLimiter.clear();await f.plugin.concurrencyLimiter.waitForSlot('a.bin');f.plugin.totalChunksToUpload=100;const completed=f.state.completed.length;fail(Error('old socket failed'));await old;assert.equal(f.plugin.totalChunksToUpload,100);assert.equal(f.state.completed.length,completed);assert.equal(f.plugin.concurrencyLimiter.activeKeys.size,1);
});
test('late send-success callback cannot write a new-generation upload checkpoint',async()=>{
 let finish;const f=fixture({send:({after})=>new Promise(resolve=>{finish=()=>{after();resolve('sent');};})});const old=f.submit('a.bin','old');await flush();f.plugin.concurrencyLimiter.clear();f.plugin.uploadedChunksCount=100;finish();await old;assert.equal(f.plugin.uploadedChunksCount,100);assert.equal(f.coordinator().buffers.active,0);
});
test('late session-not-found for a cancelled generation cannot clear a new check slot or record failure',async()=>{
 let done;const f=fixture({read:()=>new Promise(resolve=>done=resolve)});const old=f.submit('a.bin','old');await flush();f.plugin.concurrencyLimiter.clear();await f.plugin.concurrencyLimiter.waitForSlot('a.bin');f.missing('old');assert.equal(f.plugin.concurrencyLimiter.activeKeys.size,1);assert.equal(f.plugin.fileSyncTasks.failed,0);done(new ArrayBuffer(32768));await old;
});

test('same session retry after clear queues a new generation instead of attaching to the cancelled old ticket',async()=>{
 let done;let reads=0;const f=fixture({limit:1,read:()=>++reads===1?new Promise(resolve=>done=resolve):Promise.resolve(new ArrayBuffer(32768))});const old=f.submit('a.bin','same');await flush();f.plugin.concurrencyLimiter.clear();await f.plugin.concurrencyLimiter.waitForSlot('a.bin');const retry=f.submit('a.bin','same');await flush();assert.equal(f.state.reads.length,1);done(new ArrayBuffer(32768));await old;await flush();assert.equal(f.state.reads.length,2);assert.equal(f.plugin.concurrencyLimiter.activeKeys.size,1);f.ack('a.bin');await retry;assert.equal(f.coordinator().sessions.size,0);
});
test('old finally cannot delete a replacement session owner or its session-to-path entry',async()=>{
 let done;const f=fixture({read:()=>new Promise(resolve=>done=resolve)});const old=f.submit('a.bin','old');await flush();f.plugin.concurrencyLimiter.clear();const key='old'.padStart(36,'0');const owner={newGeneration:true};f.context.owners.set(key,owner);f.context.du.set(key,'replacement.bin');done(new ArrayBuffer(32768));await old;assert.equal(f.context.owners.get(key),owner);assert.equal(f.context.du.get(key),'replacement.bin');
});

test('SendBinary rechecks cancellation after buffer drain before sending to a replacement socket',async()=>{
 const f=binaryFixture();let current=true;const task=f.client.SendBinary(new Uint8Array(8),'00',()=>!current);current=false;f.client.ws={readyState:1,send:data=>f.sends.push(data.byteLength)};f.release();assert.equal(await task,'cancelled');assert.equal(f.sends.length,0);
});
