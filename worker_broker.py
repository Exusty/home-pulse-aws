"""Authenticated outbound-worker transport for a private ModelScope GPU Notebook."""
import asyncio
import hmac
import json
import secrets
import time
from fastapi import Request
from fastapi.responses import JSONResponse


def install_broker(app, worker_key, model_key):
    queue = asyncio.Queue(maxsize=4)
    pending = {}
    state = {'last_seen':0.0,'runtime':None,'worker_id':None}

    def authorized(request, name, key):
        supplied = request.headers.get(name,'')
        return bool(key and supplied) and hmac.compare_digest(supplied,key)

    def connected(): return time.monotonic()-state['last_seen']<45 and state['runtime'] is not None

    async def payload(request, limit):
        data = bytearray()
        async for chunk in request.stream():
            data.extend(chunk)
            if len(data)>limit: raise ValueError('request too large')
        return json.loads(data or b'{}')

    def update(data):
        worker_id = data.get('workerId')
        runtime = data.get('runtime')
        if not isinstance(worker_id,str) or len(worker_id)>80 or not isinstance(runtime,dict):
            return False
        if connected() and state['worker_id']!=worker_id:
            return False
        state.update(last_seen=time.monotonic(),runtime=runtime,worker_id=worker_id)
        return True

    @app.post('/_worker/heartbeat')
    async def heartbeat(request: Request):
        if not authorized(request,'x-home-pulse-worker',worker_key):
            return JSONResponse({'error':'unauthorized'},status_code=401)
        try: data = await payload(request,32768)
        except (ValueError,TypeError): return JSONResponse({'error':'invalid request'},status_code=400)
        if not update(data): return JSONResponse({'error':'worker already connected or invalid identity'},status_code=409)
        return {'connected':True}

    @app.post('/_worker/poll')
    async def poll(request: Request):
        if not authorized(request,'x-home-pulse-worker',worker_key):
            return JSONResponse({'error':'unauthorized'},status_code=401)
        try: data = await payload(request,32768)
        except (ValueError,TypeError): return JSONResponse({'error':'invalid request'},status_code=400)
        if not update(data): return JSONResponse({'error':'worker already connected or invalid identity'},status_code=409)
        deadline = time.monotonic()+20
        while time.monotonic()<deadline:
            try: job = await asyncio.wait_for(queue.get(),timeout=max(.1,deadline-time.monotonic()))
            except asyncio.TimeoutError: return {'job':None}
            entry = pending.get(job['id'])
            if entry is not None and not entry['future'].done():
                entry['worker_id']=data['workerId']
                return {'job':job}
        return {'job':None}

    @app.post('/_worker/result')
    async def result(request: Request):
        if not authorized(request,'x-home-pulse-worker',worker_key):
            return JSONResponse({'error':'unauthorized'},status_code=401)
        try: data = await payload(request,2*1024*1024)
        except (ValueError,TypeError): return JSONResponse({'error':'invalid request'},status_code=400)
        entry = pending.get(data.get('id'))
        if not entry: return JSONResponse({'error':'job expired'},status_code=410)
        if data.get('workerId')!=entry['worker_id']:
            return JSONResponse({'error':'wrong worker'},status_code=403)
        if not isinstance(data.get('body'),dict) or data.get('status') not in (200,400,422,429,500,502,503,504):
            return JSONResponse({'error':'invalid result'},status_code=400)
        if not entry['future'].done(): entry['future'].set_result(data)
        return {'accepted':True}

    @app.get('/_model/v1/models')
    async def models(request: Request):
        if not authorized(request,'x-bridge-key',model_key):
            return JSONResponse({'error':'unauthorized'},status_code=401)
        if not connected(): return JSONResponse({'error':'GPU worker is offline'},status_code=503)
        return {'data':[{'id':state['runtime'].get('model','imajev-4b-nf4')}],'runtime':state['runtime']}

    @app.post('/_model/v1/systemone')
    async def infer(request: Request):
        if not authorized(request,'x-bridge-key',model_key):
            return JSONResponse({'error':'unauthorized'},status_code=401)
        if not connected(): return JSONResponse({'error':'GPU worker is offline'},status_code=503)
        try: data = await payload(request,6*1024*1024)
        except (ValueError,TypeError): return JSONResponse({'error':'invalid request'},status_code=400)
        if not isinstance(data,dict): return JSONResponse({'error':'invalid request'},status_code=400)
        job_id = secrets.token_hex(16)
        future = asyncio.get_running_loop().create_future()
        pending[job_id]={'future':future,'worker_id':None}
        try:
            queue.put_nowait({'id':job_id,'payload':data})
            value = await asyncio.wait_for(future,timeout=125)
            return JSONResponse(value['body'],status_code=value['status'])
        except asyncio.QueueFull:
            return JSONResponse({'error':'GPU queue is full'},status_code=429)
        except asyncio.TimeoutError:
            return JSONResponse({'error':'GPU request timed out'},status_code=504)
        finally:
            pending.pop(job_id,None)

