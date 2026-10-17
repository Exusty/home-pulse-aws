import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createAppApi,createGroundedService,Journal,ContractEngine,primitivePlan,validateContract,validateSamplingRecommendation,executionCapabilities,executionIssues,pairEvidenceIssue,missingTimeQuestion,boundedVision} from './server-test-only.mjs';
const findings=[];
function evidence() {}
const image=n=>'data:image/jpeg;base64,'+Buffer.from('fixture-'+n).toString('base64')
const capabilities={live:true,frames:true,events:true,actions:['night_vision.set','ptz.preset.goto','alarm.set','motion_detection.set'],nightVisionModes:[{key:7,label:'红外'}],presetIndices:[1],alarmTypes:['SOUND_ONLY'],detectionTypes:['PET','FACE','BODY']}
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hp-app-'))
 fs.writeFileSync(path.join(root,'.env.local'),'ANKER_KIMI_API_KEY=test-only')
 const journal=new Journal(path.join(root,'.local','journal.jsonl'));let time=Date.now(),choices=[],calls=0,imagesSeen=[],draftOutput=null,plannerContext=null,plannedOutput=null,routerFailure=false,plannerFailure=false
 const grounded=createGroundedService(root,{journal:()=>journal,enqueue:fn=>fn(),router:async payload=>{if(routerFailure){routerFailure=false;throw new Error("fetch failed");}if(draftOutput)plannerContext=JSON.parse(payload.messages[1].content[0].text);return {choices:[{message:{content:JSON.stringify(draftOutput||{targetDescriptionEn:'small dog',regionDescriptionEn:'pet enclosure',locationPolicyCompatible:true,clarificationQuestionZh:''})}}]}},planner:async()=>{if(plannerFailure){plannerFailure=false;throw new Error("fetch failed");}assert.ok(plannedOutput,"Unexpected unstubbed planner");return {plan:structuredClone(plannedOutput),model:"audit-fixture",latencyMs:1}},visionFetch:async(url,opts)=>{imagesSeen.push(JSON.parse(opts.body).images);calls++;const choice=choices.shift()||'other';if(choice==='__transient__')throw new Error('fetch failed');if(choice==='__error__')throw new Error('model fixture unavailable');return new Response(JSON.stringify({answers:{q1:{choice,abstained:choice==='unknown'}},usage:{total_ms:1}}))}})
 const wallStart=Date.now();
 const options={grounded:()=>grounded,journal:()=>journal,metrics:()=>({records:journal.list()}),clock:()=>time+(Date.now()-wallStart)}
 let api=createAppApi(root,options)
 const call=async(route,body,opts={})=>api.handle({method:body===undefined?'GET':'POST',headers:{'idempotency-key':opts.key||randomUUID()}},new URL('/api/v1'+route,'http://localhost'),body,'a'.repeat(64))
 const ok=async(route,body,opts)=>{const r=await call(route,body,opts);assert.equal(r.status,200,JSON.stringify(r.body));return r.body.data}
 const init=async()=>{const c=await ok('/clients',{name:'Test App',platform:'test',appVersion:'1.0'});await ok('/clients/'+c.id+'/heartbeat',{foreground:true,sdkReady:true});await ok('/devices',{deviceId:'camera-a',clientId:c.id,name:'客厅',model:'T8171',capabilities});return c.id}
 return {root,grounded,journal,call,ok,init,setChoices:xs=>choices=xs,setDraft:value=>draftOutput=value,setPlan:value=>plannedOutput=value,failRouter:()=>routerFailure=true,failPlanner:()=>plannerFailure=true,plannerContext:()=>plannerContext,calls:()=>calls,imagesSeen:()=>imagesSeen,advance:ms=>time+=ms,now:()=>new Date(time+(Date.now()-wallStart)).toISOString(),restart:()=>{api.close();api=createAppApi(root,options)},cleanup:async()=>{api.close();assert.ok(root.startsWith(path.resolve(os.tmpdir())+path.sep+'hp-app-'));await fs.promises.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100})}}
}
const source={id:'camera-a',camera:'客厅',name:'客厅摄像头',url:'',type:'live'}
const binding=()=>({source,referenceImage:image(1),annotatedReference:image(2),targetCrop:image(3),targetBox:{x:.2,y:.2,w:.2,h:.2},regionBox:{x:.1,y:.1,w:.8,h:.8},targetName:'Buddy',regionName:'围栏',targetDescriptionEn:'small dog',regionDescriptionEn:'enclosure',referenceMediaTime:0,matchMode:'instance'})
const frame=t=>({image:image(t),annotated:image(t),mediaTime:t,capturedAt:new Date().toISOString(),frameId:'frame-'+t,sourceId:'camera-a'})
const baseRule={then:null,duration_seconds:0,within_seconds:0,time_window:null,exclude_window:null,requires:[],notify:'realtime',confirmation_frames:1,cooldown_seconds:0,mode:'occurrence'};
function badgePlan(){return {version:1,status:'ready',title:'绿色工卡访客',summary_zh:'匹配1级，不匹配3级，不清楚不报警',assumptions:[],clarification_questions:[],observers:[{id:'badge',input:'single',title:'可见工卡',question_en:'Classify visible badge evidence of the people in view, including mixed groups.',options:{friend:'Only clearly green badge wearers are present',visitor:'At least one person has a clearly visible chest without a green badge',mixed:'Both a green badge wearer and a clearly unmatched person are visible',empty:'No person',unknown:'Chest obscured or badge unreadable'},labels_zh:{friend:'符合朋友特征',visitor:'有未匹配人员',mixed:'两类人同时出现',empty:'无人',unknown:'无法确认'}}],rules:[{...baseRule,id:'friend',title:'朋友特征',level:1,condition:{operator:'all',terms:[{observer:'badge',values:['friend','mixed']}]}},{...baseRule,id:'visitor',title:'有外人来了',level:3,condition:{operator:'all',terms:[{observer:'badge',values:['visitor','mixed']}]}}]};}
async function ready(f,intent='intent-a'){
 const client=await f.init();
 await f.ok('/devices',{deviceId:'camera-a',clientId:client,name:'camera-a',model:'T8171',capabilities:{...capabilities,scheduledCapture:true,foregroundLiveCapture:true,pairedFrames:true}});
 f.setPlan(badgePlan());const request='绿色工卡特征提醒';
 await f.ok('/intents/'+intent,{request,status:'pending',deviceId:'camera-a'});
 const setup=await f.ok('/setups/prepare',{request,taskKind:'general',binding:binding(),answers:[],notification:'auto',confirmed:true,viewRevision:1,attentionLevel:3,capturePolicy:{mode:'scheduled',intervalSeconds:3,comparisonMaxAgeSeconds:300}});
 f.setChoices(['clear','clear','empty']);assert.equal((await f.ok('/setups/'+setup.id+'/trial',{frames:[frame(0)],viewRevision:1})).passed,true);
 return {client,setup,body:{setupId:setup.id,intentId:intent,confirmation:{target:true,rule:true},remember:false}};
}
test('activation atomically completes intent, survives restart, and repeated new keys do not duplicate',async()=>{
 const f=fixture();try{const {body}=await ready(f);const [a,b]=await Promise.all([f.ok('/watches',body),f.ok('/watches',body)]);assert.equal(a.id,b.id);assert.equal(a.intentId,'intent-a');assert.deepEqual(await f.ok('/intents'),[]);f.restart();assert.equal((await f.ok('/watches',body)).id,a.id);assert.equal((await f.ok('/watches')).length,1);assert.deepEqual(await f.ok('/intents'),[]);
 // Delayed pending/blocked saves after activation never bring back Continue creating.
 for(const status of ['pending','blocked']) {assert.equal((await f.ok('/intents/intent-a',{request:'绿色工卡特征提醒',status})).status,'active');assert.deepEqual(await f.ok('/intents'),[]);}
 }finally{await f.cleanup()}
});
test('cancelled intent cannot activate, while transient disconnect preserves the same existing watch',async()=>{
 const f=fixture();try{const {body,client}=await ready(f);await f.ok('/intents/intent-a',{request:'绿色工卡特征提醒',status:'cancelled'});assert.equal((await f.call('/watches',body)).body.error.code,'INTENT_CANCELLED');assert.equal((await f.ok('/watches')).length,0);
 const w=await f.ok('/watches',{...body,intentId:'intent-b'});f.advance(46000);assert.equal((await f.ok('/watches/'+w.id)).observationStatus,'connection_interrupted');assert.equal((await f.ok('/watches', {...body,intentId:'intent-b'})).id,w.id);assert.equal((await f.ok('/watches')).length,1);assert.deepEqual(await f.ok('/intents'),[]);
 }finally{await f.cleanup()}
});
test('friend is level 1, unmatched is level 3, and uncertain or empty input does not create alerts',async()=>{
 const f=fixture();try{const {body,client}=await ready(f);const w=await f.ok('/watches',body);let n=10;
 for(const choice of ['empty','unknown','friend','empty','visitor','empty','mixed']) {
  f.setChoices([choice]);const r=await f.ok('/watches/'+w.id+'/observe',{clientId:client,viewRevision:1,frame:frame(n++)});assert.equal(r.trace.accepted,true);
  const notices=r.notices || [];
  if(['empty','unknown'].includes(choice))assert.equal(notices.length,0);
 }
 const events=await f.ok('/events');assert.ok(events.some(e=>e.ruleId==='friend'&&e.attentionLevel===1));assert.ok(events.some(e=>e.ruleId==='visitor'&&e.attentionLevel===3));assert.ok(events.every(e=>e.attentionLevel===(e.ruleId==='friend'?1:3)));
 assert.equal(events.filter(e=>e.ruleId==='friend').length,2);assert.equal(events.filter(e=>e.ruleId==='visitor').length,2);
 }finally{await f.cleanup()}
});
