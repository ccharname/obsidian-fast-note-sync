'use strict';
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const esbuild=require('esbuild');
const project=process.env.FNS_TEST_PROJECT_ROOT||path.resolve(__dirname,'../..');
const source=path.join(project,'src/lib/sync');
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
function loadTs(name,imports=()=>{throw Error('unexpected helper import');},extra=''){
 const body=fs.readFileSync(path.join(source,name),'utf8')+extra;
 const code=esbuild.transformSync(body,{loader:'ts',format:'cjs',target:'es2022'}).code;
 const m={exports:{}};const fn=vm.runInNewContext('(function(require,module,exports){'+code+'\n})',{console,TextEncoder,TextDecoder,Uint8Array,DataView,WebSocket:{OPEN:1}});fn(imports,m,m.exports);return m.exports;
}
const coordination=loadTs('file_upload_coordinator.ts');
function fixture({limit=20,enabled=true,read=null,hash=null,send=null,sendMode='sent'}={}){
 const state={reads:[],sends:[],completed:[],errors:[],checkpoints:new Map()};
 const logger={addOrUpdateLog(){}};
 const dump=(...args)=>{if(String(args[0]).startsWith('Upload process error'))state.errors.push(String(args[1]));};
 const helpers={hashContent:()=> 'pathhash',hashFileAsync:async()=>hash?hash():'hash',dump,dumpError:dump,isPathExcluded:()=>false,isLargeBinarySyncRisk:()=>false,logMemorySnapshot:()=>{},sleep:async()=>{}};
 const obs={normalizePath:x=>x,Platform:{isMobile:false},TFile:class{}};
 const imports=name=>name==='obsidian'?obs:name==='./file_upload_coordinator'?coordination:name==='../utils/helpers'?helpers:name==='./sync_log_manager'?{SyncLogManager:{getInstance:()=>logger}}:{};
 const {ConcurrencyLimiter}=loadTs('concurrency_limiter.ts',imports);
 const operations=loadTs('operator_file.ts',imports,'\nexport const __testState = { activeUploadsMap, sessionIdToPathMap, uploadSessionOwners };');
 const context={Nn:operations.__testState.activeUploadsMap,du:operations.__testState.sessionIdToPathMap,owners:operations.__testState.uploadSessionOwners};
 const plugin={settings:{syncEnabled:true,readonlySyncEnabled:false,concurrencyControlEnabled:enabled,maxConcurrentUploads:limit,cloudPreviewEnabled:false},syncState:{pendingFilePushPageIndex:new Map()},totalChunksToUpload:0,uploadedChunksCount:0,fileSyncTasks:{failed:0,completed:0},pendingUploadHashes:new Map(),fileHashManager:{setFileHash(){}},localStorageManager:{savePending(){},getMetadata:()=>0,setMetadata(){}},recordSyncCompleted:(...args)=>state.completed.push(args),app:{vault:{getName:()=> 'isolated-fixture',getFileByPath:p=>({path:p,stat:{size:32768,mtime:1}}),readBinary:async file=>{state.reads.push(file.path);return read?read(file):new ArrayBuffer(32768);}},loadLocalStorage:key=>state.checkpoints.get(key),saveLocalStorage:(key,value)=>state.checkpoints.set(key,value)},websocket:{SendBinary:async(_frame,_prefix,before,after)=>{if(before())return'cancelled';state.sends.push(state.reads.at(-1));if(send)return send({before,after});if(sendMode==='throw')throw Error('fixture network failed');if(sendMode==='closed')return'closed';after();return'sent';}}};
 plugin.concurrencyLimiter=new ConcurrencyLimiter(plugin);
 const submit=(filePath,sessionId)=>operations.receiveFileUpload({path:filePath,pathHash:'pathhash',sessionId:String(sessionId).padStart(36,'0')},plugin);
 const ack=filePath=>operations.receiveFileUploadAck({path:filePath,pathHash:'pathhash'},plugin);
 return{state,plugin,submit,ack,missing:sessionId=>operations.receiveFileUploadSessionNotFound(String(sessionId).padStart(36,'0'),plugin),context,coordinator:()=>coordination.getFileUploadCoordinator(plugin),flush};
}
module.exports={fixture,flush,...coordination};

function binaryFixture() {
 const { WebSocketClient }=loadTs('websocket_client.ts',()=>({}));const client=Object.create(WebSocketClient.prototype);let releaseDrain;const sends=[];
 client.ws={readyState:1,send:data=>sends.push(data.byteLength)};client.waitForBufferDrain=()=>new Promise(resolve=>{releaseDrain=resolve;});client.notifyActivity=()=>{};
 return{client,sends,release:()=>releaseDrain()};
}
module.exports.binaryFixture=binaryFixture;
