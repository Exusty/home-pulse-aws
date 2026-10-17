#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
PYTHON="${HOME_PULSE_PYTHON:-python3}"
if [[ ! -x .venv/bin/python ]]; then
  if "$PYTHON" -c 'import sys;raise SystemExit(0 if sys.version_info >= (3,12) else 1)'; then
    "$PYTHON" -m venv .venv
  else
    "$PYTHON" -m pip install --user uv -i https://mirrors.aliyun.com/pypi/simple
    "$PYTHON" -m uv venv --python 3.12 --seed .venv
  fi
fi
.venv/bin/python -m pip install --upgrade pip -i https://mirrors.aliyun.com/pypi/simple
.venv/bin/python -m pip install torch==2.12.1 torchvision==0.27.1 --index-url https://download.pytorch.org/whl/cu126
.venv/bin/python -m pip install -r requirements-gpu.txt nodejs-wheel-binaries==24.19.0 -i https://mirrors.aliyun.com/pypi/simple
.venv/bin/python download_models.py
