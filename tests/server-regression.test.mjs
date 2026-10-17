import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import {randomUUID} from 'node:crypto'
import {createAppApi} from './server-test-only.mjs'
import {openapi} from './server-test-only.mjs'
import {createGroundedService} from './server-test-only.mjs'
import {Journal} from './server-test-only.mjs'
import {createCloudHandler} from './server-test-only.mjs'
import {DeviceExecutor} from './device-executor.mjs'
import https from 'node:https'
import {EventEmitter} from 'node:events'
import {requestRouter} from './server-test-only.mjs'

const image=n=>'data:image/jpeg;base64,'+Buffer.from('fixture-'+n).toString('base64')
const capabilities={live:true,frames:true,events:true,actions:['night_vision.set','ptz.preset.goto','alarm.set','motion_detection.set'],nightVisionModes:[{key:7,label:'红外'}],presetIndices:[1],alarmTypes:['SOUND_ONLY'],detectionTypes:['PET','FACE','BODY']}
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hp-app-'))
 fs.writeFileSync(path.join(root,'.env.local'),'ANKER_KIMI_API_KEY=test-only')
 const journal=new Journal(path.join(root,'.local','journal.jsonl'));let time=Date.now(),choices=[],calls=0,draftOutput=null,plannerContext=null
 const grounded=createGroundedService(root,{journal:()=>journal,enqueue:fn=>fn(),router:async payload=>{if(draftOutput)plannerContext=JSON.parse(payload.messages[1].content[0].text);return {choices:[{message:{content:JSON.stringify(draftOutput||{targetDescriptionEn:'small dog',regionDescriptionEn:'pet enclosure',locationPolicyCompatible:true,clarificationQuestionZh:''})}}]}},visionFetch:async()=>{calls++;const choice=choices.shift()||'other';if(choice==='__error__')throw new Error('model fixture unavailable');return new Response(JSON.stringify({answers:{q1:{choice,abstained:choice==='unknown'}},usage:{total_ms:1}}))}})
 const wallStart=Date.now();
 const options={grounded:()=>grounded,journal:()=>journal,metrics:()=>({records:journal.list()}),clock:()=>time+(Date.now()-wallStart)}
 let api=createAppApi(root,options)
 const call=async(route,body,opts={})=>api.handle({method:body===undefined?'GET':'POST',headers:{'idempotency-key':opts.key||randomUUID()}},new URL('/api/v1'+route,'http://localhost'),body,'a'.repeat(64))
 const ok=async(route,body,opts)=>{const r=await call(route,body,opts);assert.equal(r.status,200,JSON.stringify(r.body));return r.body.data}
 const init=async()=>{const c=await ok('/clients',{name:'Test App',platform:'test',appVersion:'1.0'});await ok('/clients/'+c.id+'/heartbeat',{foreground:true,sdkReady:true});await ok('/devices',{deviceId:'camera-a',clientId:c.id,name:'客厅',model:'T8171',capabilities});return c.id}
 return {root,grounded,journal,call,ok,init,setChoices:xs=>choices=xs,setDraft:value=>draftOutput=value,plannerContext:()=>plannerContext,calls:()=>calls,advance:ms=>time+=ms,now:()=>new Date(time+(Date.now()-wallStart)).toISOString(),restart:()=>{api.close();api=createAppApi(root,options)},cleanup:async()=>{api.close();assert.ok(root.startsWith(path.resolve(os.tmpdir())+path.sep+'hp-app-'));await fs.promises.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100})}}
}
const source={id:'camera-a',camera:'客厅',name:'客厅摄像头',url:'',type:'live'}
const binding=()=>({source,referenceImage:image(1),annotatedReference:image(2),targetCrop:image(3),targetBox:{x:.2,y:.2,w:.2,h:.2},regionBox:{x:.1,y:.1,w:.8,h:.8},targetName:'Buddy',regionName:'围栏',targetDescriptionEn:'small dog',regionDescriptionEn:'enclosure',referenceMediaTime:0,matchMode:'instance'})
const frame=t=>({image:image(t),annotated:image(t),mediaTime:t,capturedAt:new Date().toISOString(),frameId:'frame-'+t,sourceId:'camera-a'})
async function setup(f,viewRevision=1){return f.ok('/setups/prepare',{request:'小狗完全离开围栏就提醒我',taskKind:'dog_boundary',binding:binding(),answers:[],notification:'auto',confirmed:true,viewRevision})}
async function watch(f){const s=await setup(f);f.setChoices(['clear','clear','other','other','other']);await f.ok('/setups/'+s.id+'/trial',{frames:[frame(0),frame(1),frame(2)],viewRevision:1});return f.ok('/watches',{setupId:s.id,confirmation:{target:true,rule:true},remember:true,interval:3})}
async function queued(f,clientId,action='night_vision.set',params={modeKey:7}){const c=await f.ok('/commands',{clientId,deviceId:'camera-a',action,params,reason:'改善观察画面'});return f.ok('/commands/'+c.id+'/decision',{clientId,decision:'confirm',expectedRevision:c.revision})}

test('compact list removes images without changing detailed evidence or observation facts',async()=>{
 const f=fixture();try{const client=await f.init(),w=await watch(f);f.setChoices(['other']);await f.ok('/watches/'+w.id+'/observe',{clientId:client,viewRevision:1,frame:frame(4)})
 const detailed=await f.ok('/watches'),compact=await f.ok('/watches?compact=1');
 assert.ok(JSON.stringify(detailed).includes('data:image'));assert.ok(!JSON.stringify(compact).includes('data:image'));
 assert.equal(compact[0].lastResult,detailed[0].lastResult);assert.equal(compact[0].observations[0].capturedAt,detailed[0].observations[0].capturedAt)
 assert.ok(JSON.stringify(await f.ok('/watches/'+w.id)).includes('data:image'))
 }finally{await f.cleanup()}
})
test('diagnostics show only bounded phases and never images, text, secrets or other workspaces',async()=>{
 const f=fixture(),other=fixture();try{await f.init();await setup(f);
 const data=await f.ok('/diagnostics'),serialized=JSON.stringify(data);
 assert.ok(data.records.some(r=>r.route==='/setups/prepare' && r.status==='success' && r.stages.some(s=>s.phase==='describe_target')));
 for(const secret of ['data:image','small dog','小狗完全离开','test-only','authorization','executionToken'])assert.ok(!serialized.includes(secret),secret);
 assert.equal((await other.ok('/diagnostics')).records.length,0);
 for(let i=0;i<105;i++)await f.call('/watches/no-such-watch/state',{state:'paused'});
 assert.equal((await f.ok('/diagnostics')).records.length,100);
 f.advance(86400001);assert.equal((await f.ok('/diagnostics')).records.length,0)
 }finally{await f.cleanup();await other.cleanup()}
})
test('progress is readable while a model request is still pending',async()=>{
 const f=fixture();let release;try{await f.init();const original=f.grounded.handle;
 const gate=new Promise(resolve=>release=resolve);
 f.grounded.handle=async(...args)=>{await gate;return original(...args)};
 const pending=setup(f);
 await new Promise(resolve=>setImmediate(resolve));
 const running=(await f.ok('/diagnostics')).records.find(r=>r.route==='/setups/prepare');
 assert.equal(running.status,'running');assert.equal(running.stages[0].phase,'accepted');
 release();await pending;assert.equal((await f.ok('/diagnostics')).records[0].status,'success');
 }finally{release?.();await f.cleanup()}
})
test('pause-resume during model work invalidates the old frame even when state is active again',async()=>{
 const f=fixture();let release;try{const client=await f.init(),w=await watch(f);const original=f.grounded.handle;
 const gate=new Promise(resolve=>release=resolve);
 f.grounded.handle=async(method,url,...rest)=>{if(url.pathname==='/api/contracts/observe')await gate;return original(method,url,...rest)};
 f.setChoices(['target']);const pending=f.call('/watches/'+w.id+'/observe',{clientId:client,viewRevision:1,frame:frame(4)});
 await new Promise(resolve=>setImmediate(resolve));await f.ok('/watches/'+w.id+'/state',{state:'paused'});await f.ok('/watches/'+w.id+'/state',{state:'active'});
 release();const result=await pending;assert.equal(result.body.error.code,'WATCH_STATE_CHANGED');assert.equal((await f.ok('/events')).length,0);
 }finally{release?.();await f.cleanup()}
})
test('upstream response interruption rejects promptly instead of waiting forever',async()=>{
 const original=https.request;try{
 https.request=(_url,_options,callback)=>{
  const req=new EventEmitter();req.setTimeout=()=>{};req.destroy=()=>req.emit('close');
  req.end=()=>setImmediate(()=>{const res=new EventEmitter();res.statusCode=200;res.setEncoding=()=>{};callback(res);res.emit('aborted');req.emit('close')});return req;
 };
 await assert.rejects(requestRouter({messages:[]},'private-test-key'),/ECONNRESET/);
 }finally{https.request=original}
})
test('missing dog compatibility field retries inside validation without inventing approval',async()=>{
 const f=fixture();let attempts=0;try{
 const g=createGroundedService(f.root,{journal:()=>f.journal,enqueue:fn=>fn(),router:async()=>({choices:[{message:{content:JSON.stringify({targetDescriptionEn:'small dog',regionDescriptionEn:'pet enclosure',...(++attempts>1?{locationPolicyCompatible:false,clarificationQuestionZh:'是否只观察当前可见位置？'}:{})})}}]})});
 const s=await g.handle('POST',new URL('/api/setup/prepare','http://localhost'),{request:'小狗完全离开围栏就提醒我',taskKind:'dog_boundary',binding:binding(),answers:[],notification:'auto',confirmed:true,capturePolicy:eventPolicy,locationAlerts:separateAlerts});
 assert.equal(attempts,2);assert.equal(s.plan.status,'needs_clarification');
 }finally{await f.cleanup()}
})
test('completed events reject contradictory terminal actions and exact retries stay idempotent',async()=>{
 const f=fixture();try{const client=await f.init(),w=await watch(f);f.setChoices(['target','target']);
 await f.ok('/watches/'+w.id+'/observe',{clientId:client,viewRevision:1,frame:frame(4)});
 await f.ok('/watches/'+w.id+'/observe',{clientId:client,viewRevision:1,frame:frame(5)});
 const e=(await f.ok('/events'))[0],key=randomUUID(),body={clientId:client,action:'user_completed',expectedRevision:e.revision};
 const done=await f.ok('/events/'+e.id+'/actions',body,{key});
 assert.deepEqual(await f.ok('/events/'+e.id+'/actions',body,{key}),done);
 const bad=await f.call('/events/'+e.id+'/actions',{clientId:client,action:'dismiss',expectedRevision:done.revision});
 assert.equal(bad.body.error.code,'EVENT_CLOSED');assert.equal((await f.ok('/events'))[0].handlingState,'user_completed');
 }finally{await f.cleanup()}
})

test('OpenAPI includes every integration path and schema-required confirmations',()=>{
 const spec=openapi();assert.equal(spec.openapi,'3.1.0');assert.ok(spec.paths['/api/v1/watches/{id}/observe']);assert.ok(spec.paths['/api/v1/commands/{id}/verify'])
 assert.deepEqual(spec.paths['/api/v1/commands/{id}/decision'].post.security,[{WorkspaceBearer:[]}])
})
test('device commands reject unsupported hardware and require confirmation before claim',async()=>{
 const f=fixture();try{const clientId=await f.init()
  let r=await f.call('/commands',{clientId,deviceId:'camera-a',action:'light.set',params:{enabled:true},reason:'打开灯光'});assert.equal(r.status,422)
  r=await f.call('/commands',{clientId,deviceId:'camera-a',action:'night_vision.set',params:{modeKey:0},reason:'切换夜视'});assert.equal(r.status,422)
  const c=await f.ok('/commands',{clientId,deviceId:'camera-a',action:'night_vision.set',params:{modeKey:7},reason:'切换夜视'})
  assert.equal((await f.call('/commands/'+c.id+'/claim',{clientId,expectedRevision:c.revision})).status,409)
 }finally{await f.cleanup()}
})
test('idempotent operation does not duplicate commands, and conflicting reuse is rejected',async()=>{
 const f=fixture();try{const clientId=await f.init(),body={clientId,deviceId:'camera-a',action:'night_vision.set',params:{modeKey:7},reason:'切换夜视'},key=randomUUID()
  const pair=await Promise.allSettled([f.ok('/commands',body,{key}),f.ok('/commands',body,{key})]);for(const result of pair)if(result.status==='rejected')throw result.reason
  const [a,b]=pair.map(r=>r.value);assert.equal(a.id,b.id)
  assert.equal((await f.call('/commands',{...body,reason:'别的原因'},{key})).status,409)
  f.restart();assert.equal((await f.ok('/commands',body,{key})).id,a.id);assert.equal((await f.ok('/commands')).length,1)
 }finally{await f.cleanup()}
})
test('SDK success is distinct from verified effect, and stale readback cannot verify',async()=>{
 const f=fixture();try{const clientId=await f.init(),c=await queued(f,clientId),lease=await f.ok('/commands/'+c.id+'/claim',{clientId,expectedRevision:c.revision})
  const receipt=await f.ok('/commands/'+c.id+'/receipt',{clientId,executionToken:lease.executionToken,outcome:'succeeded',durationMs:81});assert.equal(receipt.status,'awaiting_verification')
  assert.equal((await f.call('/commands/'+c.id+'/verify',{clientId,executionToken:lease.executionToken,observedAt:new Date(Date.parse(f.now())-1000).toISOString(),state:{nightVisionModeKey:7}})).status,409)
  const verified=await f.ok('/commands/'+c.id+'/verify',{clientId,executionToken:lease.executionToken,observedAt:f.now(),state:{nightVisionModeKey:7}});assert.equal(verified.status,'verified')
  const listing=await f.ok('/commands');assert.ok(!JSON.stringify(listing).includes(lease.executionToken))
 }finally{await f.cleanup()}
})
test('lost receipt becomes result_unknown and cannot be re-executed after restart',async()=>{
 const f=fixture();try{const clientId=await f.init(),c=await queued(f,clientId),lease=await f.ok('/commands/'+c.id+'/claim',{clientId,expectedRevision:c.revision})
  f.advance(16000);f.restart();const row=(await f.ok('/commands'))[0];assert.equal(row.status,'result_unknown')
  assert.equal((await f.call('/commands/'+c.id+'/claim',{clientId,expectedRevision:row.revision})).status,409)
  assert.equal((await f.ok('/commands/'+c.id+'/verify',{clientId,executionToken:lease.executionToken,observedAt:f.now(),state:{nightVisionModeKey:7}})).status,'verified')
 }finally{await f.cleanup()}
})
test('expired and cancelled actions cannot execute; another App cannot claim a device',async()=>{
 const f=fixture();try{const clientId=await f.init(),c=await queued(f,clientId),other=await f.ok('/clients',{name:'Other',platform:'test',appVersion:'1'})
  assert.equal((await f.call('/commands/'+c.id+'/claim',{clientId:other.id,expectedRevision:c.revision})).status,403)
  const cancelled=await f.ok('/commands/'+c.id+'/decision',{clientId,decision:'cancel',expectedRevision:c.revision});assert.equal(cancelled.status,'cancelled')
  assert.equal((await f.call('/commands/'+c.id+'/claim',{clientId,expectedRevision:cancelled.revision})).status,409)
  const expired=await queued(f,clientId);f.advance(61000)
  assert.equal((await f.ok('/commands')).find(x=>x.id===expired.id).status,'expired')
  assert.equal((await f.call('/commands/'+expired.id+'/claim',{clientId,expectedRevision:3})).status,409)
 }finally{await f.cleanup()}
})
test('heartbeat expiry shows disconnected device and blocks new control requests',async()=>{
 const f=fixture();try{const clientId=await f.init();assert.equal((await f.ok('/devices'))[0].online,true);f.advance(46000)
  assert.equal((await f.ok('/devices'))[0].online,false)
  assert.equal((await f.call('/commands',{clientId,deviceId:'camera-a',action:'night_vision.set',params:{modeKey:7},reason:'切换夜视'})).body.error.code,'DEVICE_OFFLINE')
 }finally{await f.cleanup()}
})
test('grounded setup, trial, activation, event handling and recovery form a complete API loop',async()=>{
 const f=fixture();try{const clientId=await f.init(),w=await watch(f)
  f.setChoices(['other','other','target','target','other','other'])
  for(const t of [3,4,5,6])await f.ok('/watches/'+w.id+'/observe',{clientId,viewRevision:1,frame:frame(t)})
  const events=await f.ok('/events');assert.equal(events.length,1)
  const done=await f.ok('/events/'+events[0].id+'/actions',{clientId,action:'user_completed',expectedRevision:1});assert.equal(done.visualRecoveryAt,null);assert.ok(done.userCompletedAt)
  for(const t of [7,8])await f.ok('/watches/'+w.id+'/observe',{clientId,viewRevision:1,frame:frame(t)})
  const recovered=(await f.ok('/events'))[0];assert.ok(recovered.visualRecoveryAt);assert.ok(recovered.userCompletedAt)
  assert.equal((await f.ok('/watches')).length,1)
  const memory=(await f.ok('/memories'))[0]
  assert.equal(memory.thumbnail,image(3))
  assert.equal(memory.referenceImage,undefined)
 }finally{await f.cleanup()}
})
test('stale, mixed-source and repeated frames cannot generate extra model calls',async()=>{
 const f=fixture();try{const clientId=await f.init(),w=await watch(f),before=f.calls()
  const call=fr=>f.call('/watches/'+w.id+'/observe',{clientId,viewRevision:1,frame:fr})
  assert.equal((await call({...frame(3),sourceId:'camera-b'})).status,409)
  assert.equal((await call({...frame(3),capturedAt:new Date(Date.now()-130000).toISOString()})).status,409)
  assert.equal(f.calls(),before)
  const sameFrame=frame(3);await call(sameFrame);assert.equal((await call(sameFrame)).body.data.duplicate,true);assert.equal(f.calls(),before+1)
  assert.equal((await call({...sameFrame,image:image(99)})).body.error.code,'FRAME_ID_CONFLICT')
 }finally{await f.cleanup()}
})
test('camera movement invalidates old regions and blocks activation of an old trial',async()=>{
 const f=fixture();try{const clientId=await f.init(),w=await watch(f),s=await setup(f),c=await queued(f,clientId,'ptz.preset.goto',{index:1})
  await f.ok('/commands/'+c.id+'/claim',{clientId,expectedRevision:c.revision})
  assert.equal((await f.ok('/watches/'+w.id)).observationStatus,'needs_reconfirmation')
  assert.equal((await f.call('/watches/'+w.id+'/observe',{clientId,viewRevision:1,frame:frame(5)})).status,409)
  assert.equal((await f.call('/setups/'+s.id+'/trial',{frames:[frame(0),frame(1),frame(2)],viewRevision:1})).status,409)
 }finally{await f.cleanup()}
})
test('duplicate and delayed hardware events remain separate from visual conclusions',async()=>{
 const f=fixture();try{const clientId=await f.init(),w=await watch(f),payload={clientId,deviceId:'camera-a',eventId:'sdk-1',type:'motion',occurredAt:f.now()}
  const first=await f.ok('/device-events',payload),second=await f.ok('/device-events',payload)
  assert.equal(first.work[0].watchId,w.id);assert.equal(second.duplicate,true);assert.equal(second.work.length,0);assert.equal((await f.ok('/events')).length,0)
  const old=await f.ok('/device-events',{...payload,eventId:'sdk-old',occurredAt:new Date(Date.parse(f.now())-180000).toISOString()});assert.equal(old.work.length,0)
 }finally{await f.cleanup()}
})
test('memory deletion requires resolving dependencies and erases reference copies and cached results',async()=>{
 const f=fixture();try{await f.init();const w=await watch(f)
  assert.equal((await f.call('/memories/'+w.memoryId+'/delete',{confirmed:true,cascade:false})).status,409)
  await f.ok('/memories/'+w.memoryId+'/delete',{confirmed:true,cascade:true})
  assert.equal((await f.ok('/watches')).length,0);assert.equal((await f.ok('/memories')).length,0)
  assert.equal(f.grounded.repo.list('registration').length,0);assert.equal(f.grounded.repo.list('setup').length,0)
  assert.ok(!fs.readFileSync(path.join(f.root,'.local','app-api','state.json'),'utf8').includes('small dog'))
 }finally{await f.cleanup()}
})
test('HTTP App sessions isolate devices and the specification is accessible without model credentials',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hp-app-http-')),secret='internal-fixture'
 const server=http.createServer(createCloudHandler({dataDir:root,internalKey:secret}));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port
 const call=(route,token,body)=>fetch(base+'/api/v1'+route,{method:body===undefined?'GET':'POST',headers:{'X-Home-Pulse-Internal':secret,...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json','Idempotency-Key':randomUUID()},...(body!==undefined?{body:JSON.stringify(body)}:{})})
 try{
  assert.equal((await call('/devices')).status,401);assert.equal((await(await call('/openapi.json')).json()).openapi,'3.1.0')
  const one=(await(await call('/sessions',null,{})).json()).data.token,two=(await(await call('/sessions',null,{})).json()).data.token;assert.notEqual(one,two)
  const client=(await(await call('/clients',one,{name:'One',platform:'android',appVersion:'1'})).json()).data
  await call('/devices',one,{deviceId:'camera-a',clientId:client.id,name:'Private camera',model:'T8171',capabilities})
  assert.equal((await(await call('/devices',one)).json()).data.length,1);assert.equal((await(await call('/devices',two)).json()).data.length,0)
 }finally{await new Promise(r=>server.close(r));assert.ok(root.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true})}
})

test('expired observation images are removed from both checkpoint and cached engine',async()=>{
 const f=fixture();try{const clientId=await f.init(),w=await watch(f);await f.ok('/watches/'+w.id+'/observe',{clientId,viewRevision:1,frame:frame(3)})
  assert.ok((await f.ok('/watches/'+w.id)).observations[0].evidence)
  f.advance(86410000);const r=await f.ok('/watches/'+w.id);assert.equal(r.observations[0].evidence,null);assert.equal(r.observationStatus,'connection_interrupted')
  assert.equal(f.grounded.repo.get('state',w.id).observations[0].evidence,null)
 }finally{await f.cleanup()}
})
test('model failures record a technical error and never create a normal event',async()=>{
 const f=fixture();try{const clientId=await f.init(),w=await watch(f);f.setChoices(['__error__'])
  const result=await f.call('/watches/'+w.id+'/observe',{clientId,viewRevision:1,frame:frame(3)});assert.equal(result.status,502)
  assert.equal((await f.ok('/events')).length,0);assert.equal(f.journal.list().filter(r=>r.status==='error').length,1)
 }finally{await f.cleanup()}
})
test('executor recovery re-sends the saved receipt and verifies without a second physical action',async()=>{
 let executions=0;const requests=[],lease={id:'command',action:'night_vision.set',executionToken:'a'.repeat(64)}
 const executor=new DeviceExecutor({clientId:'client',newId:()=>randomUUID(),store:{save:async()=>{}},adapter:{execute:async()=>{executions++},readState:async()=>({observedAt:new Date().toISOString(),state:{nightVisionModeKey:7}})},api:{post:async(route,body,key)=>{requests.push({route,body,key});return {status:route.endsWith('/receipt')?'awaiting_verification':'verified'}}}})
 const result=await executor.recover({commandId:'command',phase:'reporting',lease,receiptKey:'saved-request-key',receipt:{outcome:'succeeded',durationMs:70}})
 assert.equal(executions,0);assert.equal(requests[0].key,'saved-request-key');assert.equal(result.status,'verified');assert.equal(requests.length,2)
})

const eventPolicy={mode:'event',intervalSeconds:300,comparisonMaxAgeSeconds:86400}
const separateAlerts={notSeen:{enabled:true,confirmations:2,attentionLevel:2},outside:{enabled:true,confirmations:1,attentionLevel:3},excludeCarried:true}
const locationSetup=(f,extra={})=>f.ok('/setups/prepare',{request:'暂时没看到和明确在围栏外分别提醒',taskKind:'dog_boundary',binding:binding(),answers:[],notification:'auto',confirmed:true,viewRevision:1,capturePolicy:eventPolicy,locationAlerts:separateAlerts,...extra})
test('scheduled checks require registered hardware capability before any model call',async()=>{
 const f=fixture();try{const clientId=await f.init(),before=f.calls()
  await assert.rejects(()=>locationSetup(f,{capturePolicy:{...eventPolicy,mode:'scheduled'}}),/SCHEDULED_CAPTURE_UNAVAILABLE/)
  assert.equal(f.calls(),before)
  await f.ok('/devices',{deviceId:'camera-a',clientId,name:'客厅',model:'T8171',capabilities:{...capabilities,scheduledCapture:true}})
  const s=await locationSetup(f,{capturePolicy:{...eventPolicy,mode:'scheduled',intervalSeconds:900}});assert.equal(s.capturePolicy.intervalSeconds,900)
 }finally{await f.cleanup()}
})
test('location policy activates from one real snapshot and keeps independent alert levels',async()=>{
 const f=fixture();try{const clientId=await f.init(),s=await locationSetup(f,{notification:'quiet',attentionLevel:0})
  f.setChoices(['clear','clear','inside']);const trial=await f.ok('/setups/'+s.id+'/trial',{frames:[frame(0)],viewRevision:1});assert.equal(trial.passed,true)
  const w=await f.ok('/watches',{setupId:s.id,confirmation:{target:true,rule:true},remember:false});assert.equal(w.capturePolicy.mode,'event');assert.equal(w.attentionLevel,3)
  f.setChoices(['outside','unknown','not_seen','inside']);const run=t=>f.ok('/watches/'+w.id+'/observe',{clientId,viewRevision:1,frame:frame(t)})
  await run(1);let e=(await f.ok('/events'))[0];assert.equal(e.ruleId,'outside');assert.equal(e.attentionLevel,3)
  const confirmed=(await f.ok('/watches/'+w.id)).lastConfirmedAt;await run(2);assert.equal((await f.ok('/watches/'+w.id)).lastConfirmedAt,confirmed)
  await run(3);assert.equal((await f.ok('/events'))[0].visualRecoveryAt,null)
  await run(4);assert.ok((await f.ok('/events'))[0].visualRecoveryAt)
 }finally{await f.cleanup()}
})
test('manual policy receives no capture work from motion, and last known state remains visible',async()=>{
 const f=fixture();try{const clientId=await f.init(),s=await locationSetup(f,{capturePolicy:{...eventPolicy,mode:'manual'}})
  f.setChoices(['clear','clear','inside']);await f.ok('/setups/'+s.id+'/trial',{frames:[frame(0)],viewRevision:1});const w=await f.ok('/watches',{setupId:s.id,confirmation:{target:true,rule:true}})
  assert.equal((await f.ok('/device-events',{clientId,deviceId:'camera-a',eventId:'motion-manual',type:'motion',occurredAt:f.now()})).work.length,0)
  f.setChoices(['inside']);await f.ok('/watches/'+w.id+'/observe',{clientId,viewRevision:1,frame:frame(1),manual:true})
  const before=await f.ok('/watches/'+w.id);f.advance(180000)
  await f.ok('/clients/'+clientId+'/heartbeat',{foreground:true,sdkReady:true});await f.ok('/devices/camera-a/status',{clientId,online:true,observedAt:f.now()})
  const after=await f.ok('/watches/'+w.id);assert.equal(after.lastResult,before.lastResult);assert.equal(after.lastConfirmedAt,before.lastConfirmedAt);assert.equal(after.observationStatus,'ready_for_check')
 }finally{await f.cleanup()}
})
test('model recommendations receive verified device context and cannot enable unavailable capture',async()=>{
 const f=fixture();try{await f.init();const draft={title:'位置关注',taskKind:'dog_boundary',targetName:'小狗',targetDescriptionEn:'small dog',regionName:'围栏',regionDescriptionEn:'enclosure',targetBox:null,regionBox:null,summary:'确认对象与提醒方式',questions:[],viewAdvice:'',recommendation:{capturePolicy:eventPolicy,category:'care',attentionLevel:3,reasonZh:'有事件时看画面，分别确认当前位置。',locationAlerts:separateAlerts}}
  f.setDraft(draft);const body={request:'留意这只小狗',image:image(1),source,viewRevision:1,observationContext:{events:false,scheduledCapture:true,continuousRecording:false}}
  const r=await f.ok('/setups/draft',body);assert.equal(r.draft.recommendation.capturePolicy.mode,'event');assert.deepEqual(f.plannerContext().observationContext,{events:true,scheduledCapture:false,foregroundLiveCapture:false,pairedFrames:false,minimumIntervalSeconds:60,continuousRecording:false})
  f.setDraft({...draft,recommendation:{...draft.recommendation,capturePolicy:{...eventPolicy,intervalSeconds:null}}});assert.equal((await f.ok('/setups/draft',body)).draft.recommendation.capturePolicy.intervalSeconds,300);
  f.setDraft({...draft,recommendation:{...draft.recommendation,capturePolicy:{...eventPolicy,mode:'scheduled'}}});assert.equal((await f.call('/setups/draft',body)).body.error.code,'SCHEDULED_CAPTURE_UNAVAILABLE')
 }finally{await f.cleanup()}
})

test('extra behavior cannot be silently replaced by a location-only policy',async()=>{
 const f=fixture();try{await f.init();f.setDraft({targetDescriptionEn:'small dog',regionDescriptionEn:'pet enclosure',locationPolicyCompatible:false,clarificationQuestionZh:'这份约定只检查当前位置，要另设翻越提醒吗？'})
  const s=await locationSetup(f,{answers:[{question:'翻越是否提醒',answer:'身体一半在外也提醒'}]});assert.equal(s.plan.status,'needs_clarification');assert.match(s.plan.clarification_questions[0],/翻越/)
  assert.equal((await f.call('/setups/'+s.id+'/trial',{viewRevision:1,frames:[frame(0)]})).status,409)
 }finally{await f.cleanup()}
})

import {requestedSamplingSeconds, validateSamplingRecommendation} from './server-test-only.mjs';
test('explicit cadence distinguishes recurring requests from duration and negation',()=>{
 for(const [request,value] of [['三秒一次，看看摄像头内有没有人离开',3],['每3秒看一次',3],['每隔一秒看',1],['每十五分钟检查',900],['无人持续三秒',null],['不要每3秒看',null],['每3秒或每5秒',null]]) assert.equal(requestedSamplingSeconds(request),value,request);
});
test('supported recurring request cannot silently become event or 5 minute polling',()=>{
 const input={request:'三秒一次，看看摄像头内有没有人离开',observationContext:{scheduledCapture:true,events:false,foregroundLiveCapture:true,minimumIntervalSeconds:1}};
 for(const policy of [{mode:'event',intervalSeconds:3},{mode:'scheduled',intervalSeconds:300},{mode:'manual',intervalSeconds:3}]) assert.throws(()=>validateSamplingRecommendation({recommendation:{capturePolicy:policy}},input));
 assert.doesNotThrow(()=>validateSamplingRecommendation({recommendation:{capturePolicy:{mode:'scheduled',intervalSeconds:3}}},input));
});
test('1 and 3 second schedules are accepted only from a declared live sampler',async()=>{
 const f=fixture();try{const clientId=await f.init();
 await f.ok('/devices',{deviceId:'camera-a',clientId,name:'客厅',model:'T8171',capabilities:{...capabilities,events:false,scheduledCapture:true}});
 const blocked=await f.call('/setups/prepare',{request:'检查当前位置',taskKind:'dog_boundary',binding:binding(),answers:[],notification:'auto',confirmed:true,viewRevision:1,capturePolicy:{...eventPolicy,mode:'scheduled',intervalSeconds:3}});
 assert.equal(blocked.body.error.code,'LIVE_SAMPLING_UNAVAILABLE');
 await f.ok('/devices',{deviceId:'camera-a',clientId,name:'客厅',model:'T8171',capabilities:{...capabilities,events:false,scheduledCapture:true,foregroundLiveCapture:true}});
 for(const n of [1,3]) {const s=await locationSetup(f,{capturePolicy:{...eventPolicy,mode:'scheduled',intervalSeconds:n}});assert.equal(s.capturePolicy.intervalSeconds,n);}
 const data={title:'人员状态',taskKind:'general',targetName:'人',targetDescriptionEn:'visible people',regionName:'全画面',regionDescriptionEn:'full view',targetBox:null,regionBox:null,summary:'每三秒观察人员状态',questions:[],viewAdvice:'',recommendation:{capturePolicy:{...eventPolicy,mode:'scheduled',intervalSeconds:3},category:'security',attentionLevel:2,reasonZh:'手机前台直播每3秒取图'}};
 f.setDraft(data);const d=await f.ok('/setups/draft',{request:'三秒一次，看看摄像头内有没有人离开',image:image(1),source,viewRevision:1});
 assert.equal(d.draft.recommendation.capturePolicy.intervalSeconds,3);assert.equal(f.plannerContext().observationContext.minimumIntervalSeconds,1);assert.equal(f.plannerContext().observationContext.events,false);
 const log=await f.ok('/diagnostics');assert.ok(log.records.some(r=>r.stages.some(s=>s.phase==='sampling_policy' && s.requestedIntervalSeconds===3)));
 }finally{await f.cleanup()}
});
test('resuming a paused fast watch cannot bypass the active camera source guard',async()=>{
 const f=fixture();try{const clientId=await f.init();
 const caps={...capabilities,scheduledCapture:true,foregroundLiveCapture:true};
 for(const id of ['camera-a','camera-b']) {await f.ok('/devices',{deviceId:id,clientId,name:id,model:'T8171',capabilities:caps});await f.ok('/devices/'+id+'/status',{clientId,online:true,observedAt:f.now(),viewChanged:false,state:{}});}
 const make=async(id,n)=>{const s=await locationSetup(f,{binding:{...binding(),source:{...source,id}},capturePolicy:{...eventPolicy,mode:'scheduled',intervalSeconds:n}});f.setChoices(['clear','clear','inside']);await f.ok('/setups/'+s.id+'/trial',{frames:[{...frame(1),sourceId:id}],viewRevision:1});return s;};
 const a=await make('camera-a',3),wa=await f.ok('/watches',{setupId:a.id,confirmation:{target:true,rule:true},remember:false});
 const b=await make('camera-b',300);assert.equal((await f.call('/watches',{setupId:b.id,confirmation:{target:true,rule:true},remember:false})).body.error.code,'LIVE_SOURCE_BUSY');
 await f.ok('/watches/'+wa.id+'/state',{state:'paused'});
 const wb=await f.ok('/watches',{setupId:b.id,confirmation:{target:true,rule:true},remember:false});
 assert.equal((await f.call('/watches/'+wa.id+'/state',{state:'active'})).body.error.code,'LIVE_SOURCE_BUSY');
 assert.equal((await f.ok('/watches/'+wa.id)).state,'paused');assert.equal((await f.ok('/watches/'+wb.id)).state,'active');
 }finally{await f.cleanup()}
});

test('deadline summary arrives with no new frame, is evidence-aware and deduplicated after restart',async()=>{
 const f=fixture();try {
  await f.init();const w=await watch(f);
  const r=f.grounded.repo.get('registration',w.id);
  const date=new Date();const end=new Date(date.getTime()+120000);
  const hhmm=d=>new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(d);
  r.plan.rules[0].mode='window_summary';r.plan.rules[0].notify='summary';r.plan.rules[0].time_window={start:hhmm(date),end:hhmm(end)};
  f.grounded.repo.save('registration',w.id,r);try{f.grounded.repo.remove('state',w.id)}catch{};f.grounded.forget(w.id);
  assert.equal((await f.ok('/events')).length,0);const calls=f.calls();f.advance(180000);await new Promise(resolve=>setTimeout(resolve,1200));assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(f.root,'.local/app-api/state.json'))).events).length,1,'timer persisted summary before any events fetch');
  const es=await f.ok('/events');assert.equal(es.length,1);assert.equal(es[0].kind,'summary');assert.equal(es[0].summaryStatus,'insufficient_evidence');assert.equal(es[0].evidenceState,'unknown');assert.equal(f.calls(),calls);
  f.restart();assert.equal((await f.ok('/events')).length,1);
 }finally{await f.cleanup()}
});
test('three urgency levels route independently; receiving never marks read and receipts are idempotent',async()=>{
 const f=fixture();try {
  const c=await f.init(),w=await watch(f);const file=path.join(f.root,'.local/app-api/state.json');
  const db=JSON.parse(fs.readFileSync(file));
  for(const level of [1,2,3]) db.events['level-'+level]={id:'level-'+level,watchId:w.id,attentionLevel:level,title:'QA reminder',createdAt:f.now(),handlingState:'unread'};
  fs.writeFileSync(file,JSON.stringify(db));f.restart();
  for(const level of [1,2,3]) {
   const a=await f.ok('/events/level-'+level+'/receipt',{clientId:c});
   const b=await f.ok('/events/level-'+level+'/receipt',{clientId:c});assert.equal(a.receivedAt,b.receivedAt);
  }
  const es=await f.ok('/events');for(const e of es){assert.equal(e.handlingState,'unread');assert.equal(e.delivery.presentation,['','inbox','banner','urgent'][e.attentionLevel]);assert.ok(e.delivery.receipts[c]);}
 }finally{await f.cleanup()}
});
test('pending intents persist and cancellation cannot be undone by a delayed write',async()=>{
 const f=fixture();try {
  await f.init();const body={request:'每三秒看一下有没有人离开',status:'blocked',reason:'暂时无法取图'};
  await f.ok('/intents/test-intent',body);f.restart();assert.equal((await f.ok('/intents')).length,1);
  await f.ok('/intents/test-intent',{...body,status:'cancelled'});assert.equal((await f.ok('/intents')).length,0);
  assert.equal((await f.call('/intents/test-intent',{...body,status:'pending'})).status,409);
  assert.equal((await f.call('/intents/another-intent',{...body,status:'active',watchId:'missing'})).status,409);
 }finally{await f.cleanup()}
});
test('reviewing unknown state records acknowledgement without inventing evidence or pausing',async()=>{
 const f=fixture();try {await f.init();const w=await watch(f);const before=await f.ok('/watches/'+w.id);const after=await f.ok('/watches/'+w.id+'/review',{});assert.ok(after.reviewedAt);assert.equal(after.state,'active');assert.equal(after.lastResult,before.lastResult);assert.equal(after.lastConfirmedAt,before.lastConfirmedAt);}finally{await f.cleanup()}
});
