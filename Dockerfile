FROM python:3.12-slim
WORKDIR /app
COPY requirements-web.txt ./
RUN pip install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple -r requirements-web.txt nodejs-wheel-binaries==24.19.0
COPY . .
ENV PORT=7860 HOME_PULSE_PROVIDER=modelscope HOME_PULSE_DATA_DIR=/mnt/workspace/home-pulse-data PYTHONUNBUFFERED=1
EXPOSE 7860
CMD ["python", "app.py"]
