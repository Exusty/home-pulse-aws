"""Sequentially prefetch immutable weights before mmap-based model loading."""
from pathlib import Path
import os
import time


def main():
    root=Path(os.getenv('HOME_PULSE_MODELS_DIR','/mnt/workspace/home-pulse-models'))
    started=time.perf_counter();total=0
    buffer=bytearray(8*1024*1024)
    paths=[p for folder in ('Qwen3.5-4B','imajev-4b') for p in sorted((root/folder).glob('*.safetensors'))]
    if not paths:raise SystemExit('Model weights are missing; run download_models.py first.')
    for source in paths:
        count=0
        with source.open('rb',buffering=0) as stream:
            while True:
                size=stream.readinto(buffer)
                if not size:break
                count+=size
        total+=count
        print(f'Model cache: {source.parent.name}/{source.name}, {count/2**20:.1f} MiB',flush=True)
    print(f'Model cache ready: {total/2**30:.2f} GiB in {time.perf_counter()-started:.1f}s',flush=True)


if __name__=='__main__':main()
