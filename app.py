"""Provider-neutral Home Pulse gateway for an independent GPU deployment."""
import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import os
import json
import importlib.util
from pathlib import Path
import re
import secrets
import shutil

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
import httpx
from starlette.background import BackgroundTask

ROOT = Path(__file__).resolve().parent
DATA = Path(os.getenv('HOME_PULSE_DATA_DIR', '/mnt/workspace/home-pulse-data'))
PROVIDER = os.getenv('HOME_PULSE_PROVIDER', 'standalone')
API_PORT = int(os.getenv('HOME_PULSE_API_PORT', '8791'))
MODEL_URL = os.getenv('HOME_PULSE_MODEL_URL', 'http://127.0.0.1:8765').rstrip('/')
INTERNAL_KEY = secrets.token_hex(32)
WORKSPACE = re.compile(r'^[a-f0-9]{64}$')
WORKER_KEY = os.getenv('HOME_PULSE_WORKER_KEY','')
if WORKER_KEY:
    MODEL_URL = f'http://127.0.0.1:{os.getenv("PORT","7860")}/_model'


@asynccontextmanager
async def lifespan(app):
    DATA.mkdir(parents=True, exist_ok=True)
    node = shutil.which('node')
    if not node:
        package = importlib.util.find_spec('nodejs_wheel')
        candidate = Path(package.origin).parent/'bin/node' if package and package.origin else None
        if candidate and candidate.is_file(): node = str(candidate)
    if not node:
        raise RuntimeError('Node.js is required')
    environment = dict(os.environ, HOME_PULSE_CLOUD='1',
        HOME_PULSE_DATA_DIR=str(DATA), HOME_PULSE_INTERNAL_KEY=INTERNAL_KEY,
        HOME_PULSE_MEDIA_ROOT=str(ROOT/'media-library'), HOME_PULSE_STORAGE='persistent_disk',
        HOME_PULSE_PROVIDER=PROVIDER, HOME_PULSE_VISUAL_BACKEND='imajev-4b-dedicated',
        HOME_PULSE_API_PORT=str(API_PORT), HOME_PULSE_MODEL_URL=MODEL_URL,
        HOME_PULSE_MODEL_AUTH=INTERNAL_KEY if WORKER_KEY else '')
    child = await asyncio.create_subprocess_exec(node, str(ROOT/'web/server-bundle.mjs'),
        cwd=ROOT/'web', env=environment)
    app.state.node = child
    app.state.client = httpx.AsyncClient(trust_env=False, timeout=240)
    try:
        for _ in range(80):
            if child.returncode is not None:
                raise RuntimeError('Workspace API exited during startup')
            try:
                reply = await app.state.client.get(f'http://127.0.0.1:{API_PORT}/api/v1/openapi.json',
                    headers={'X-Home-Pulse-Internal': INTERNAL_KEY}, timeout=1)
                if reply.status_code == 200:
                    break
            except httpx.RequestError:
                pass
            await asyncio.sleep(.1)
        else:
            raise RuntimeError('Workspace API did not become ready')
        yield
    finally:
        await app.state.client.aclose()
        if child.returncode is None:
            child.terminate()
            try:
                await asyncio.wait_for(child.wait(), timeout=10)
            except asyncio.TimeoutError:
                child.kill()
                await child.wait()


app = FastAPI(title='Home Pulse', docs_url=None, redoc_url=None, lifespan=lifespan)
if WORKER_KEY:
    from worker_broker import install_broker
    install_broker(app, WORKER_KEY, INTERNAL_KEY)


def error(code, message, status, retryable=False):
    return JSONResponse({'error': {'code':code, 'message':message, 'retryable':retryable},
        'apiVersion':'1.2.0', 'requestId':secrets.token_hex(16),
        'serverTime':datetime.now(timezone.utc).isoformat()}, status_code=status)


@app.get('/healthz')
async def health(request: Request):
    ready = False
    runtime = None
    try:
        result = await request.app.state.client.get(MODEL_URL+'/v1/models', timeout=2,
            headers={'X-Bridge-Key':INTERNAL_KEY} if WORKER_KEY else {})
        data = result.json()
        ready = result.is_success and 'imajev' in str(data).lower()
        runtime = data.get('runtime')
    except (httpx.RequestError, ValueError):
        pass
    api_ready = request.app.state.node.returncode is None
    return JSONResponse({'service':'Home Pulse', 'provider':PROVIDER,
        'apiVersion':'1.2.0', 'apiReady':api_ready, 'modelReady':ready,
        'runtime':runtime, 'serverTime':datetime.now(timezone.utc).isoformat()},
        status_code=200 if api_ready else 503)


@app.api_route('/api/{route:path}', methods=['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'])
async def proxy(route: str, request: Request):
    public = request.method=='OPTIONS' or (request.method=='POST' and route=='v1/sessions') or (request.method in ('GET','HEAD') and route=='v1/openapi.json')
    authorization = request.headers.get('authorization','')
    bearer = authorization[7:] if authorization.startswith('Bearer ') else ''
    workspace = (request.headers.get('x-home-pulse-workspace','')
        or (bearer if WORKSPACE.fullmatch(bearer) else '') or request.cookies.get('hp_workspace',''))
    if not public and not WORKSPACE.fullmatch(workspace):
        return error('UNAUTHORIZED','请提供 Home Pulse 空间令牌',401)
    origin = request.headers.get('origin')
    host = request.headers.get('host','')
    allowed = {f'https://{host}', f'http://{host}'}
    allowed.update(filter(None, os.getenv('HOME_PULSE_ALLOWED_ORIGINS','').split(',')))
    if origin and origin not in allowed:
        return error('ORIGIN_NOT_ALLOWED','访问来源不匹配',403)
    if request.method == 'OPTIONS':
        return JSONResponse({}, headers={'Access-Control-Allow-Origin':origin or f'https://{host}',
            'Access-Control-Allow-Methods':'GET, POST, PUT, PATCH, DELETE, OPTIONS',
            'Access-Control-Allow-Headers':'Content-Type, X-Home-Pulse-Workspace, Idempotency-Key, Authorization, X-File-Name'})
    headers = {k:v for k,v in request.headers.items()
        if k.lower() in ('content-type','content-length','range','x-file-name','idempotency-key')}
    headers.update({'X-Home-Pulse-Internal':INTERNAL_KEY,'X-Home-Pulse-Workspace':workspace})
    target = f'http://127.0.0.1:{API_PORT}/api/{route}' + ('?'+request.url.query if request.url.query else '')
    client = request.app.state.client
    try:
        outbound = client.build_request(request.method, target, headers=headers, content=request.stream())
        response = await client.send(outbound, stream=True)
    except httpx.RequestError:
        return error('GATEWAY_UNAVAILABLE','空间连接暂时中断，请重试',502,True)
    kept = {k:v for k,v in response.headers.items() if k.lower() in
        ('content-type','content-length','content-range','accept-ranges','cache-control','content-disposition')}
    if origin:
        kept['Access-Control-Allow-Origin'] = origin
        kept['Vary'] = 'Origin'
    return StreamingResponse(response.aiter_raw(), status_code=response.status_code,
        headers=kept, background=BackgroundTask(response.aclose))


for folder in ('assets','media'):
    app.mount('/'+folder, StaticFiles(directory=ROOT/'web/dist'/folder), name=folder)
for folder in ('docs','releases'):
    if (ROOT/folder).is_dir():
        app.mount('/'+folder, StaticFiles(directory=ROOT/folder), name=folder)


@app.get('/favicon.svg')
async def favicon():
    return FileResponse(ROOT/'web/dist/favicon.svg')


@app.get('/{route:path}', include_in_schema=False)
async def page(route: str):
    if route.startswith(('_', 'v1/')) or '..' in route:
        return error('NOT_FOUND','页面不存在',404)
    html = (ROOT/'web/dist/index.html').read_text(encoding='utf-8').replace('<head>',
        '<head><script>window.__HOME_PULSE_CLOUD__=true;window.__HOME_PULSE_VISUAL_TRANSPORT__="rest";window.__HOME_PULSE_PROVIDER__='+json.dumps(PROVIDER).replace('<','\\u003c')+';</script>')
    return HTMLResponse(html, headers={'Cache-Control':'no-cache'})


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='0.0.0.0', port=int(os.getenv('PORT','7860')), access_log=False)
