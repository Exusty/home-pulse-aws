"""Authenticated, bounded HTTPS-upstream entry for the existing loopback GPU API."""
import asyncio
from contextlib import asynccontextmanager
import json
import os
import secrets

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

MAX_BODY = 8 * 1024 * 1024


def create_bridge(key, model_url='http://127.0.0.1:8765', upstream_client=None, max_body=MAX_BODY):
    if len(key) < 32: raise ValueError('A private GPU bridge key of at least 32 characters is required')

    @asynccontextmanager
    async def lifespan(app):
        if upstream_client is None:
            app.state.upstream = httpx.AsyncClient(trust_env=False, timeout=125)
        try: yield
        finally:
            if upstream_client is None: await app.state.upstream.aclose()

    app = FastAPI(title='Home Pulse GPU bridge',docs_url=None,redoc_url=None,openapi_url=None,lifespan=lifespan)
    app.state.upstream = upstream_client
    app.state.slot = asyncio.Lock()

    def authorized(request):
        return secrets.compare_digest(request.headers.get('X-Bridge-Key','').encode(),key.encode())

    def failure(message,status):
        return JSONResponse({'error':message},status_code=status,headers={'Cache-Control':'no-store'})

    async def forward(method,path,payload=None):
        try:
            response = await app.state.upstream.request(method,model_url.rstrip('/')+path,
                json=payload,timeout=3 if method=='GET' else 125)
        except httpx.TimeoutException: return failure('GPU request timed out',504)
        except httpx.RequestError: return failure('GPU is not ready',503)
        return Response(response.content,status_code=response.status_code,
            headers={'Content-Type':response.headers.get('Content-Type','application/json'),'Cache-Control':'no-store'})

    @app.get('/v1/models')
    async def models(request:Request):
        if not authorized(request): return failure('Unauthorized',401)
        return await forward('GET','/v1/models')

    @app.post('/v1/systemone')
    async def infer(request:Request):
        if not authorized(request): return failure('Unauthorized',401)
        try:
            length=int(request.headers.get('content-length','0'))
            if length<0:return failure('Invalid content length',400)
            if length>max_body:return failure('Image request is too large',413)
        except ValueError:return failure('Invalid content length',400)
        body=bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body)>max_body:return failure('Image request is too large',413)
        try:payload=json.loads(body)
        except (ValueError,UnicodeDecodeError):return failure('Invalid JSON',400)
        if not isinstance(payload,dict):return failure('A request object is required',422)
        if app.state.slot.locked():return failure('GPU is busy; retry shortly',429)
        async with app.state.slot:
            return await forward('POST','/v1/systemone',payload)

    return app


if __name__=='__main__':
    import uvicorn
    uvicorn.run(create_bridge(os.environ['HOME_PULSE_GPU_BRIDGE_KEY']),host='127.0.0.1',
        port=int(os.getenv('HOME_PULSE_GPU_BRIDGE_PORT','8766')),access_log=False)
