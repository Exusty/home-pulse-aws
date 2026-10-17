// The UI confirms a specific command before it becomes queued. This executor
// only runs queued commands; it never decides what the user should approve.
// adapter.execute(action, params) -> {outcome,sdkCode,message,durationMs}
// adapter.readState(action) -> {observedAt,state} | null
// store.save(row) MUST persist securely before any physical SDK action.
export class DeviceExecutor {
 constructor({api,clientId,adapter,store,newId=()=>crypto.randomUUID()}){Object.assign(this,{api,clientId,adapter,store,newId});this.running=new Set()}
 async execute(command){
  if(command.status!=='queued'||this.running.has(command.id))return null
  this.running.add(command.id)
  try{
   const claimKey=this.newId()
   await this.store.save({commandId:command.id,phase:'claiming',claimKey,revision:command.revision})
   const lease=await this.api.post('/commands/'+command.id+'/claim',{clientId:this.clientId,expectedRevision:command.revision},claimKey)
   await this.store.save({commandId:command.id,phase:'executing',lease})
   let receipt
   try{receipt=await this.adapter.execute(lease.action,lease.params)}
   catch{receipt={outcome:'unknown',sdkCode:'SDK_INTERRUPTED',message:'需要查询设备当前状态',durationMs:0}}
   const receiptKey=this.newId()
   await this.store.save({commandId:command.id,phase:'reporting',lease,receipt,receiptKey})
   const result=await this.api.post('/commands/'+command.id+'/receipt',{clientId:this.clientId,executionToken:lease.executionToken,...receipt},receiptKey)
   if(['awaiting_verification','result_unknown'].includes(result.status)&&lease.action!=='ptz.preset.goto')return this.verify(lease)
   return result
  }finally{this.running.delete(command.id)}
 }
 async verify(lease){
  const observation=await this.adapter.readState(lease.action)
  if(!observation)return null // No readable property: keep the effect unconfirmed.
  const key=this.newId(),body={clientId:this.clientId,executionToken:lease.executionToken,...observation}
  await this.store.save({commandId:lease.id,phase:'verifying',lease,body,key})
  return this.api.post('/commands/'+lease.id+'/verify',body,key)
 }
 // On App restart, load the saved row. Re-send only transport messages with
 // their original idempotency key. Never call adapter.execute() in recovery.
 async recover(row){
  if(row.phase==='claiming'){
   const lease=await this.api.post('/commands/'+row.commandId+'/claim',{clientId:this.clientId,expectedRevision:row.revision},row.claimKey)
   await this.store.save({commandId:row.commandId,phase:'executing',lease})
   // Claim receipt alone cannot prove whether an SDK call already ran.
   await this.api.post('/commands/'+row.commandId+'/receipt',{clientId:this.clientId,executionToken:lease.executionToken,outcome:'unknown',sdkCode:'APP_RESTART',durationMs:0},this.newId())
   return lease.action==='ptz.preset.goto'?null:this.verify(lease)
  }
  if(row.phase==='reporting'){
   const result=await this.api.post('/commands/'+row.commandId+'/receipt',{clientId:this.clientId,executionToken:row.lease.executionToken,...row.receipt},row.receiptKey)
   if(['awaiting_verification','result_unknown'].includes(result.status)&&row.lease.action!=='ptz.preset.goto')return this.verify(row.lease)
   return result
  }
  if(row.phase==='verifying')return this.api.post('/commands/'+row.commandId+'/verify',row.body,row.key)
  if(row.phase==='executing'){
   await this.api.post('/commands/'+row.commandId+'/receipt',{clientId:this.clientId,executionToken:row.lease.executionToken,outcome:'unknown',sdkCode:'APP_RESTART',durationMs:0},this.newId())
   return row.lease.action==='ptz.preset.goto'?null:this.verify(row.lease)
  }
  return null
 }
}
