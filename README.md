# Home Pulse · AWS 服务端源码

2026-10-17 AWS 部署源码快照，按用户授权公开发布。部署文件已与当日线上服务核对；发布仓库不会改动线上服务或用户数据。

## 项目背景

传统家庭摄像头主要提供实时画面、录像回放与移动事件，用户仍需自己反复查看，才能回答“我关心的事情现在怎么样了”。Home Pulse 希望把这种反复查看，转换为围绕具体事项的观察与提醒。

例如“帮我看看指定位置的包裹是否还在”。系统让用户确认目标和观察区域，先试观察，再根据新画面报告“仍在／未看见／无法确认”。它不把普通移动事件当作包裹变化，也不从单次未看见推断丢失或失窃。用户点击处理提醒，也不等于现场状态已经恢复。

整个项目由三个部分协作：iOS App 负责用户交互与获授权摄像头的前台采样，AWS 服务负责规划、规则执行和视觉判断，桌面小屏用于呈现关注状态。**本公开仓库仅包含 AWS 服务端；iOS 工程、小屏固件和它们的资源不在本仓库公开。** 此处对客户端与小屏的介绍仅用于说明整体产品背景。

## 项目简介

本仓库交付 Home Pulse 的服务端实现：

- 接收自然语言关注需求，生成可确认的目标、区域与观察规则。
- 接收客户端提交的新画面，调用 GPU 视觉服务执行判断。
- 管理关注、证据、提醒、幂等请求与失败恢复。
- 提供 FastAPI 网关、Node 业务服务、网页入口，以及可选远程 GPU 工作端。

数据流为：**摄像头 → iOS 前台采样 → AWS 规则与视觉判断 → App 提醒与小屏展示**。服务端不直接常驻控制摄像头；当前链路需要 App 保持前台，证据不足保留未知。

主后端 `web/server-bundle.mjs` 是部署快照中的未压缩 JavaScript ESM 文件，可直接编辑和运行。SHA-256：`24d7ef12d533735825d9a35b8ef1dfd99222dcb13185131bf9b2f0954f2d58f7`。

服务器没有保留 `web/src`、`web/server` 等原始模块开发目录；这里交付的是实际部署源码及网页构建产物，不把历史模块源码冒充最新版。后端无需重新打包即可运行。当前网页 `web/dist` 来自已核对的线上快照，JS/CSS/HTML 已校验。

## 根目录结构

| 路径 | 用途 |
|---|---|
| `app.py` | FastAPI 网关，启动 Node 业务进程，代理 API 与静态网页 |
| `gpu_runtime.py` | NVIDIA GPU / NF4 视觉推理服务 |
| `web/server-bundle.mjs` | 当前运行的全部 Node 业务代码 |
| `web/dist/` | 当前线上网页构建产物（非 React 原始模块） |
| `worker_broker.py`、`notebook_worker.py`、`inference_bridge.py` | 可选的远程 GPU 工作端与访问桥接 |
| `download_models.py`、`prewarm_models.py`、`install_gpu.sh` | 固定模型版本下载、预热与原部署安装脚本 |
| `requirements-*.txt` | 线上 Python 依赖版本 |
| `scripts/` | 本次补充的启动、公开依赖取回、离线测试脚本 |
| `tests/` | 现行后端回归测试（使用合成输入与模型桩） |
| `config/`、`.env.example` | 外部依赖校验清单、无密钥配置模板 |
| `docs/` | 来源和文件哈希 |
| `licenses/` | 第三方许可 |

## 安装步骤

需要 Python 3.12+、Node.js 24（线上使用 24.19.0）。视觉服务需要 NVIDIA CUDA GPU；项目此前使用 L4；本次打包不重跑 GPU。Mac 可做代码审阅、前端展示、API 与离线测试，不能直接复现 CUDA 推理。

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements-web.txt
cp .env.example .env
```

编辑 `.env`，填写你自己获授权的规划服务 `ANKER_KIMI_API_KEY`，并配置数据、模型目录。目录应使用绝对路径。该 Key 的变量名只是配置入口，包内没有真实 Key。业务仍使用项目现有规划网关，需该服务的有效权限。

在 GPU 主机上取回公开依赖和模型：

```bash
python3 scripts/fetch_upstream.py
.venv/bin/python -m pip install torch==2.12.1 torchvision==0.27.1 --index-url https://download.pytorch.org/whl/cu126
.venv/bin/python -m pip install -r requirements-gpu.txt
set -a; source .env; set +a
.venv/bin/python download_models.py
```

`fetch_upstream.py` 只取回 Imajev 必需的 14 个公开文件，固定 Git 提交，并按线上文件 SHA-256 校验。开源实现和模型权重属于外部依赖，不计为团队自研代码，不在本源码包复制一整个开源仓库。模型具体修订号见 `download_models.py`。下载模型需要网络和足够磁盘。

## 使用方法

在两个终端分别启动（项目根目录）：

```bash
bash scripts/run_gpu.sh
bash scripts/run_web.sh
```

打开 `http://127.0.0.1:7860`，查看 `/healthz` 的 `apiReady` 与 `modelReady`。iPhone 访问时应自行配置有效 HTTPS 域名与反向代理，并把 iOS 的 `API_BASE_URL` 指向该 origin。不要将 iPhone 的 `127.0.0.1` 当作电脑或服务器地址。

主流程：建立空间 → 登记客户端及 SDK 能力 → 输入需求 → 确认目标/区域/规则 → 试观察 → 建立关注 → iOS 前台采样 → 云端判断与提醒 → 查看/处理/暂停。图片不足、超时或不清晰保留未知。

网页素材库 `media-library/` 与 `web/dist/media/` 默认为空：原始比赛视频、私人观察图片及运行数据库未打包。自选本地视频或通过 iOS 上传实际新画面可走自己的观察流程；预置网页素材入口需要另行提供获授权素材。目录占位保留，网关可启动。

## 验证

```bash
node --check web/server-bundle.mjs
python3 scripts/test_backend.py
```

本次实际检查结果见 `docs/验证结果.md`。模型桩测试不证明视觉准确率；本次没有重跑收费模型、真实摄像头或线上部署。

## 当前边界

需要 App 前台。支持能力仍受客户端与当前规则校验约束；没有承诺后台无人值守、锁屏 APNs、身份识别或任意连续行为。前台一台摄像头流串行取图。云端空间令牌机制属于当前演示实现，完整账户与成员权限体系未包含。源码不携带现有家庭空间或任务，10 秒演示去重等个别任务参数也不作为全局默认配置。

## 敏感信息与 SDK

没有 `.env`、账号密码、API Key、摄像头会话、用户数据库、SSH 私钥、原始日志、设备备份、安克 SDK 源码/二进制/通信协议资料。源码内的 Home Pulse HTTP 接口和自行定义的小屏同步格式属于本项目应用层逻辑，不是安克设备底层通信协议。
