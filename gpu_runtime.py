"""The locally verified imajev NF4 configuration, portable to NVIDIA cloud GPUs."""
from pathlib import Path
import importlib.metadata
import json
import os
import sys

ROOT = Path(__file__).resolve().parent
DATA = Path(os.getenv('HOME_PULSE_DATA_DIR','/mnt/workspace/home-pulse-data'))
MODELS = Path(os.getenv('HOME_PULSE_MODELS_DIR','/mnt/workspace/home-pulse-models'))
for folder in (ROOT/'upstream/src',ROOT/'upstream/scripts',ROOT/'upstream/scripts/playground'):
    sys.path.insert(0,str(folder))
os.environ.setdefault('TOKENIZERS_PARALLELISM','false')
os.environ.setdefault('HF_HUB_DISABLE_IMPLICIT_TOKEN','1')


def build_app():
    import torch
    import torch_decision
    from transformers import BitsAndBytesConfig, Qwen3_5ForConditionalGeneration
    from PIL import Image
    from server import TorchBackend, create_app
    from vision_decision.calibration import TemperatureCalibrator
    from fastapi.responses import JSONResponse

    if not torch.cuda.is_available():
        raise RuntimeError('NVIDIA CUDA GPU is required')
    base, adapter = MODELS/'Qwen3.5-4B', MODELS/'imajev-4b'
    if not (base/'config.json').is_file() or not (adapter/'decision_readout.safetensors').is_file():
        raise RuntimeError('Run download_models.py before starting visual inference')
    compute_dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16

    class NF4Decision(torch_decision.TorchDecision):
        def __init__(self, path, device, dtype=compute_dtype, max_length=4096, pad_multiple=0):
            self.processor = torch_decision._LazyMultimodalProcessor(path)
            self.device, self.max_length, self.pad_multiple = device, max_length, pad_multiple
            quantization = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type='nf4',
                bnb_4bit_compute_dtype=compute_dtype, bnb_4bit_use_double_quant=True,
                llm_int8_skip_modules=['lm_head','visual'])
            self.model = Qwen3_5ForConditionalGeneration.from_pretrained(path,
                local_files_only=True, dtype=compute_dtype, quantization_config=quantization,
                device_map={'':0}, attn_implementation='sdpa').eval()
            self.readout, self._codebook = None, None
            self.codes = torch_decision.MAX_READOUT_CODES
            self.prompt_layout = torch_decision.DEFAULT_PROMPT_LAYOUT

    torch_decision.TorchDecision = NF4Decision

    class ResizedBackend(TorchBackend):
        def score(self, images, request, thinking=None):
            prepared = []
            for original in images:
                image = original.convert('RGB').copy()
                image.thumbnail((640,640), Image.Resampling.LANCZOS)
                prepared.append(image)
            result, usage = super().score(prepared, request, thinking=thinking)
            torch.cuda.synchronize()
            usage['processed_image_sizes'] = [list(image.size) for image in prepared]
            usage['gpu_peak_allocated_gib'] = round(torch.cuda.max_memory_allocated()/2**30,3)
            return result, usage

    DATA.mkdir(parents=True, exist_ok=True)
    bundle = DATA/'model-bundle.json'
    bundle.write_text(json.dumps({'path':str(base)}), encoding='utf-8')
    backend = ResizedBackend(bundle=bundle, adapter=adapter, device='cuda', rotations=1,
        max_input_tokens=4096, fast=False, merge_lora=False)
    backend.model = 'imajev-4b-nf4'
    calibration = TemperatureCalibrator.load(adapter/'calibration.json')
    app = create_app(backend, calibration=calibration)
    info = {'model':backend.model,'gpu':torch.cuda.get_device_name(0),
        'memoryGiB':round(torch.cuda.get_device_properties(0).total_memory/2**30,2),
        'quantization':f'NF4 / {str(compute_dtype).split(".")[-1]}',
        'maxImageSide':640,'loadSeconds':round(backend.load_seconds,3),
        'provider':os.getenv('HOME_PULSE_PROVIDER','standalone'),
        'calibration':'upstream; not recalibrated for NF4',
        'versions':{name:importlib.metadata.version(name) for name in ('torch','transformers','peft','bitsandbytes')}}
    (DATA/'runtime-info.json').write_text(json.dumps(info,ensure_ascii=False,indent=2),encoding='utf-8')

    @app.middleware('http')
    async def metadata(request, call_next):
        if request.url.path=='/v1/models' and request.method=='GET':
            return JSONResponse({'data':[{'id':backend.model}],'runtime':info})
        return await call_next(request)

    print(json.dumps(info,ensure_ascii=False),flush=True)
    return app


if __name__=='__main__':
    import uvicorn
    uvicorn.run(build_app(), host='127.0.0.1', port=int(os.getenv('HOME_PULSE_MODEL_PORT','8765')), access_log=False)
