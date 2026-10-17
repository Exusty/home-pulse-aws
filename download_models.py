"""Download the exact model revisions already used by Home Pulse."""
import os
from pathlib import Path
os.environ.setdefault('HF_HUB_DISABLE_XET','1')
from huggingface_hub import snapshot_download

target = Path(os.getenv('HOME_PULSE_MODELS_DIR','/mnt/workspace/home-pulse-models'))
for repo, revision, name, patterns in [
    ('Qwen/Qwen3.5-4B','851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a','Qwen3.5-4B',['*.json','*.safetensors','*.txt','*.jinja']),
    ('mohit67890/imajev-4b','f8d8234cebc6c99065c07731e59716dc0a6e27ab','imajev-4b',['*.json','*.safetensors']),
]:
    snapshot_download(repo, revision=revision, local_dir=target/name,
        allow_patterns=patterns, ignore_patterns=['mlx/*','assets/*'], token=False, max_workers=4)
    print(name+' ready',flush=True)
