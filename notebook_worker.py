"""Connect this GPU to its own ModelScope Studio using outbound HTTPS only."""
import asyncio
import os
import secrets
import time
import httpx


async def main():
    endpoint = os.environ['HOME_PULSE_WORKER_URL'].rstrip('/')
    if not endpoint.startswith('https://'): raise RuntimeError('Worker endpoint must use HTTPS')
    secret = os.environ['HOME_PULSE_WORKER_KEY']
    model = os.getenv('HOME_PULSE_MODEL_URL','http://127.0.0.1:8765').rstrip('/')
    worker_id = secrets.token_hex(16)
    async with httpx.AsyncClient(trust_env=False,timeout=150) as local, httpx.AsyncClient(
        trust_env=False,timeout=40,headers={'X-Home-Pulse-Worker':secret}) as remote:
        while True:
            try:
                response = await local.get(model+'/v1/models',timeout=3)
                response.raise_for_status()
                runtime = response.json()['runtime']
                break
            except (httpx.HTTPError,KeyError): await asyncio.sleep(3)
        identity = {'workerId':worker_id,'runtime':runtime}

        async def heartbeat():
            while True:
                try:
                    response = await remote.post(endpoint+'/_worker/heartbeat',json=identity,timeout=10)
                    response.raise_for_status()
                except httpx.HTTPError as exc:
                    print('Worker heartbeat: '+type(exc).__name__,flush=True)
                await asyncio.sleep(12)

        heartbeat_task = asyncio.create_task(heartbeat())
        print('GPU worker ready: '+runtime['gpu'],flush=True)
        try:
            while True:
                try:
                    response = await remote.post(endpoint+'/_worker/poll',json=identity)
                    response.raise_for_status()
                    job = response.json().get('job')
                    if not job: continue
                    started=time.perf_counter()
                    try:
                        output = await local.post(model+'/v1/systemone',json=job['payload'],timeout=120)
                        body = output.json()
                        status = output.status_code if output.status_code in (200,400,422,429,500,502,503,504) else 502
                    except (httpx.HTTPError,ValueError):
                        status,body=503,{'error':'GPU inference unavailable'}
                    if status==200:
                        body.setdefault('usage',{})['worker_roundtrip_ms']=round((time.perf_counter()-started)*1000,2)
                    result={'id':job['id'],'workerId':worker_id,'status':status,'body':body}
                    posted=await remote.post(endpoint+'/_worker/result',json=result,timeout=15)
                    if posted.status_code not in (200,410): posted.raise_for_status()
                except (httpx.HTTPError,KeyError,ValueError) as exc:
                    print('Worker reconnect: '+type(exc).__name__,flush=True)
                    await asyncio.sleep(3)
        finally:
            heartbeat_task.cancel()


if __name__=='__main__': asyncio.run(main())
