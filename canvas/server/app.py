#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
画布后端：ComfyUI 的模板化执行层 + 产物归档。

零依赖（仅标准库）。启动：
  python canvas/server/app.py            # 默认 127.0.0.1:8770
  python canvas/server/app.py --port 9000

设计要点：
  - 一个 worker 线程串行执行。ComfyUI 本身就是单队列，并发提交只会互相排队并抢显存。
  - 每次执行 = 编译模板 → 上传图片输入 → /prompt → 轮询 /history → 下载产物到 assets/。
  - filename_prefix 强制注入成 jobId，产物天然按任务归档，不再出现 AIGCTYD2_00001.mp4 这种名字。
  - 画布图状态由前端整体 PUT 覆盖保存，后端不拆解节点语义；后端只认「模板 + 参数 + 输入」。
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import mimetypes
import os
import queue
import random
import re
import threading
import time
import traceback
import urllib.parse
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import comfy
import workflow_import

ROOT = Path(__file__).resolve().parent.parent          # canvas/
WORKSPACE = ROOT.parent                                # 工作区根
TEMPLATES = WORKSPACE / "batch-render" / "templates"
ASSETS = ROOT / "assets"
UPLOADS = ASSETS / "uploads"
PROJECTS = ROOT / "projects"
DIST = ROOT / "web" / "dist"
DEFAULT_PROJECT = PROJECTS / "default.json"

# 素材可读目录白名单：画布产物 + 批量脚本的参考图/历史产物 + ComfyUI input
MATERIAL_ROOTS = [
    ASSETS,
    WORKSPACE / "batch-render" / "refs",
    WORKSPACE / "batch-render" / "out",
    Path(os.environ.get("LOCALAPPDATA", "")) / "Comfy-Desktop" / "ComfyUI-Shared" / "input",
]
MEDIA_EXT = {".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm", ".gif", ".wav", ".mp3", ".flac", ".m4a", ".ogg"}

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
VIDEO_EXT = {".mp4", ".webm", ".mov", ".mkv"}
AUDIO_EXT = {".wav", ".mp3", ".flac", ".m4a", ".ogg"}


def kind_of_ext(ext: str) -> str:
    ext = ext.lower()
    if ext in VIDEO_EXT:
        return "video"
    if ext in AUDIO_EXT:
        return "audio"
    return "image"


def slot_landings(graph: dict | None) -> dict[str, list[tuple[str, str]]]:
    """槽位 → 它在图里落在哪些 (class_type, input_name) 上。

    分类只能看落点，不能看槽位名。反例：MiniMaxH3ReferenceToVideo 的
    ref_image_size 是个 match/max 枚举参数，名字里带 image，按名判就成了
    「图片槽」，于是第一张上传图被写进这个枚举输入，ComfyUI 回
    value_not_in_list —— 工作流本身是跑得通的，是分类判错了。
    """
    out: dict[str, list[tuple[str, str]]] = {}

    def walk(node):
        if isinstance(node, dict):
            ins = node.get("inputs")
            if isinstance(ins, dict):
                ct = str(node.get("class_type") or "")
                for k, v in ins.items():
                    if isinstance(v, str):
                        m = comfy.SLOT_RE.match(v)
                        if m:
                            out.setdefault(m.group(1), []).append((ct, str(k)))
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    if isinstance(graph, dict):
        walk(graph)
    return out


def _loader_media_kind(class_type: str, input_name: str) -> str | None:
    """这处落点是不是在「读盘加载媒体」的节点上，是的话吃哪类。

    真正的媒体入口都带 load（LoadImage / LoadAudio / VHS_LoadVideo …）。
    处理节点、编码节点上的输入一律不算，哪怕它名字里带 image。
    """
    c = (class_type or "").lower()
    i = (input_name or "").lower()
    if "load" not in c:
        return None
    if "video" in c or "video" in i:
        return "video"
    if "audio" in c or "audio" in i:
        return "audio"
    if "image" in c or i in ("image", "images", "mask"):
        return "image"
    return None


# meta 里显式声明成这些类型的，一律是参数，不进媒体槽
_PARAM_FIELD_TYPES = {"select", "number", "seed", "textarea", "text", "toggle", "boolean"}


def input_dir_loader(class_type: str, input_name: str) -> bool:
    """这个落点要的是「input 目录里的文件名」还是「磁盘绝对路径」。

    同样叫加载视频，两套节点吃的东西不一样：

    - 原生 `LoadVideo` / `LoadAudio` 的 file / audio 是**从 input 目录现列的 COMBO**，
      传绝对路径会被它的 `validate_inputs` 打回 ——
      `Custom validation failed: Invalid video file: C:/…/xxx.mp4`，整单 400。
    - `VHS_LoadVideoPath` / `VHS_LoadAudio` 是 STRING 路径，直接读绝对路径，
      省一次整段视频的拷贝。

    有 object_info 就按输入类型判（COMBO = 文件名，STRING = 路径），
    拿不到再按类名兜底：带 load 又不带 path 的，按「要上传」处理。
    """
    try:
        oi = comfy.object_info(timeout=8)
    except Exception:
        oi = None
    spec = ((oi or {}).get(class_type) or {}).get("input") or {}
    cfg = (spec.get("required") or {}).get(input_name) or (spec.get("optional") or {}).get(input_name)
    if cfg is not None:
        if _enum_of(cfg) is not None:
            return True
        if isinstance(cfg, list) and cfg and cfg[0] == "STRING":
            return False
    c = (class_type or "").lower()
    return "load" in c and "path" not in c


def slot_media_kind(
    slot: str, landings: dict | None = None, meta: dict | None = None
) -> str:
    """槽位吃哪类媒体：参考图片 / 参考视频 / 参考音频 / 参数。

    判定顺序：meta 显式声明的参数 → 图里的落点 → 名字兜底。
    音视频走带路径的加载节点（VHS_LoadVideoPath），ComfyUI 能直接读绝对路径，
    不用像 LoadImage 那样先拷进 input。
    """
    for f in (meta or {}).get("fields") or []:
        if isinstance(f, dict) and f.get("slot") == slot:
            if f.get("type") in _PARAM_FIELD_TYPES:
                return "param"
            break

    lands = (landings or {}).get(slot) if landings is not None else None
    if lands:
        for ct, name in lands:
            k = _loader_media_kind(ct, name)
            if k:
                return k
        return "param"

    # 图里找不到落点（理论上不会发生）才退回按名字判
    s = (slot or "").lower()
    if "video" in s:
        return "video"
    if "audio" in s:
        return "audio"
    if "image" in s:
        return "image"
    return "param"


for d in (ASSETS, UPLOADS, PROJECTS):
    d.mkdir(parents=True, exist_ok=True)

# 比例预设：值必须和 ComfyUI ResolutionSelector 的枚举逐字一致，显示名随便起
ASPECT_PRESETS = [
    {"value": "9:16 (Portrait Widescreen)", "label": "9:16 竖屏"},
    {"value": "16:9 (Widescreen)", "label": "16:9 横屏"},
    {"value": "1:1 (Square)", "label": "1:1 方形"},
    {"value": "3:4 (Portrait Standard)", "label": "3:4 竖版"},
    {"value": "4:3 (Standard)", "label": "4:3 横版"},
    {"value": "2:3 (Portrait Photo)", "label": "2:3 竖照片"},
    {"value": "3:2 (Photo)", "label": "3:2 横照片"},
    {"value": "21:9 (Ultrawide)", "label": "21:9 超宽"},
]

# ---------------------------------------------------------------- 状态

LOCK = threading.RLock()
JOBS: dict[str, dict] = {}
JOB_Q: "queue.Queue[str]" = queue.Queue()
CURRENT: dict | None = None

# 最近请求路径，用来诊断「前端到底有没有跑起来」。轮询类请求不计入。
REQ_LOG: "collections.deque[tuple[str, int]]" = collections.deque(maxlen=30)

# worker 自检：线程死掉是静默故障（任务永远卡在 queued），必须能看见
WORKER_STATE = {
    "started_at": "",
    "alive": False,
    "processed": 0,
    "last_job": "",
    "last_action": "",
    "last_error": "",
}


def now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


# ---------------------------------------------------------------- 运行日志
#
# 一条通道、一个文件：画布节点里发生的每一步（前端上报）和后端的任务生命周期
# 按时间写进 projects/runtime.log，交错成一条完整时间线。排查「点了生成什么都没
# 发生」这类问题时，一眼能分清是没发出去、后端没收到、还是卡在 ComfyUI。
#
# 格式刻意保持单行 key=value：tail -f、grep、肉眼扫都行，不需要解析器。
RUNTIME_LOG = PROJECTS / "runtime.log"
RUNTIME_LOG_MAX = 4 * 1024 * 1024          # 超过 4MB 轮转一份 runtime.log.1
LOG_LOCK = threading.Lock()
LOG_RING: "collections.deque[dict]" = collections.deque(maxlen=600)


def _log_val(v) -> str:
    """字段值压成单行短串。带空格/等号的加引号，保证还能按空格切词。"""
    s = "" if v is None else str(v)
    s = s.replace("\r", " ").replace("\n", "\\n").replace("\t", " ")
    if len(s) > 160:
        s = s[:157] + "..."
    if not s or any(c.isspace() for c in s) or "=" in s:
        return '"' + s.replace('"', "'") + '"'
    return s


def rlog(ev: str, level: str = "I", **fields) -> None:
    """写一条运行日志，并留一份在内存里给 /api/log 查。

    绝不抛异常：日志坏掉不能把业务带走。
    """
    try:
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        clean: dict = {}
        parts = [f"{ts}  {level}  {ev}"]
        for k, v in fields.items():
            if v is None or v == "":
                continue
            kk = re.sub(r"[^a-z0-9_]+", "_", str(k).lower()).strip("_") or "f"
            clean[kk] = v
            parts.append(f"{kk}={_log_val(v)}")
        line = "  ".join(parts)
        with LOG_LOCK:
            LOG_RING.append({"ts": ts, "level": level, "ev": ev, "fields": clean})
            try:
                if RUNTIME_LOG.exists() and RUNTIME_LOG.stat().st_size > RUNTIME_LOG_MAX:
                    os.replace(RUNTIME_LOG, RUNTIME_LOG.with_name("runtime.log.1"))
                with RUNTIME_LOG.open("a", encoding="utf-8") as f:
                    f.write(line + "\n")
            except Exception:
                pass
        print(line, flush=True)
    except Exception:
        pass


def save_jobs() -> None:
    """任务表落盘，重启后还能看到历史。"""
    try:
        (PROJECTS / "jobs.json").write_text(
            json.dumps(list(JOBS.values())[-300:], ensure_ascii=False, indent=1), encoding="utf-8"
        )
    except Exception:
        pass


def load_jobs() -> None:
    f = PROJECTS / "jobs.json"
    if not f.is_file():
        return
    try:
        for j in json.loads(f.read_text(encoding="utf-8")):
            if j.get("status") in ("queued", "running"):
                j["status"] = "error"
                j["error"] = "服务重启，任务中断"
            JOBS[j["id"]] = j
    except Exception:
        pass


# ---------------------------------------------------------------- 模板

def template_caps(g: dict) -> dict:
    """探测模板的采样能力，决定 UI 要不要显示负向提示词。

    依据是硬的：
      - CFGGuider cfg=1 时，CFG 公式 out = neg + 1×(pos−neg) = pos，负向被完全抵消
      - BasicGuider（H3 用的）压根没有 negative 输入口
    蒸馏加速模型基本都是 cfg=1，负向框摆在那里只会误导。
    """
    cfg = None
    has_neg = False

    def text_of(nid) -> str | None:
        """这个节点里有没有可直接编辑的文本输入。"""
        ins = ((g.get(str(nid)) or {}).get("inputs") or {})
        for k in ("text", "prompt", "negative_prompt", "text_g"):
            x = ins.get(k)
            if isinstance(x, str) and x.strip():
                return x
        return None

    for v in g.values():
        if not isinstance(v, dict):
            continue
        ct = v.get("class_type", "")
        ins = v.get("inputs", {}) or {}
        if ct == "BasicGuider":
            cfg = 1.0  # 无 negative 分支，等价于 cfg=1
        elif ct in ("CFGGuider", "KSampler", "KSamplerAdvanced") and "cfg" in ins:
            try:
                cfg = float(ins["cfg"])
            except (TypeError, ValueError):
                cfg = None  # 是槽位变量，未知
        if ct == "TextEncodeQwenImage21" and "negative_prompt" in ins:
            has_neg = True
        # 负向口接到一个真带文本的编码节点才算：z_image 那种 ConditioningZeroOut 不算
        neg = ins.get("negative")
        if isinstance(neg, list) and len(neg) == 2 and text_of(neg[0]):
            has_neg = True
    supports = bool(has_neg) and (cfg is None or cfg > 1.0)
    return {"cfg": cfg, "supportsNegative": supports}


def template_meta(name: str) -> dict:
    """模板的展示/交互描述（同名 .meta.json），纯 UI 用，不参与执行。"""
    p = TEMPLATES / f"{name}.meta.json"
    if not p.is_file():
        return {}
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def template_kind(g: dict) -> str:
    """按产物节点判断这是出图还是出片的模板。"""
    classes = {v.get("class_type") for v in g.values() if isinstance(v, dict)}
    if classes & {"SaveVideo", "CreateVideo", "SaveAnimatedWEBP", "VHS_VideoCombine", "SaveWEBM"}:
        return "video"
    return "image"


def expand_fields(meta: dict) -> list[dict]:
    """把 meta 里的字段声明补全成前端可直接渲染的列表。"""
    out = []
    for f in meta.get("fields") or []:
        if not isinstance(f, dict) or not f.get("slot"):
            continue
        f = dict(f)
        if f.get("preset") == "aspect":
            f.setdefault("options", ASPECT_PRESETS)
        out.append(f)
    return out


def list_templates() -> list[dict]:
    if not TEMPLATES.is_dir():
        return []
    out = []
    for f in sorted(TEMPLATES.glob("*.json")):
        if f.stem.endswith(".meta"):
            continue
        try:
            g = comfy.load_template(f)
        except Exception:
            continue
        if not isinstance(g, dict) or not any(isinstance(v, dict) and "class_type" in v for v in g.values()):
            continue
        slots = comfy.collect_slots(g)
        classes = sorted({v.get("class_type", "") for v in g.values() if isinstance(v, dict)})
        # 从节点里挖出模型名，纯做展示，不参与执行
        model = ""
        for v in g.values():
            if not isinstance(v, dict):
                continue
            ct = v.get("class_type", "")
            if ct in ("UNETLoader", "CheckpointLoaderSimple"):
                ins = v.get("inputs", {})
                model = ins.get("unet_name") or ins.get("ckpt_name") or ""
                if model:
                    break
        meta = template_meta(f.stem)
        kind = template_kind(g)

        def _idx(s: str) -> int:
            try:
                return int(s.rsplit("_", 1)[-1])
            except (ValueError, IndexError):
                return 0

        # 槽位按媒体类型分组：判据是它在图里落在哪个节点的哪个输入，
        # 不是名字里有没有 image（参数 ref_image_size 之流会被名字骗到）
        landings = slot_landings(g)
        image_slots = sorted([s for s in slots if slot_media_kind(s, landings, meta) == "image"], key=_idx)
        video_slots = sorted([s for s in slots if slot_media_kind(s, landings, meta) == "video"], key=_idx)
        audio_slots = sorted([s for s in slots if slot_media_kind(s, landings, meta) == "audio"], key=_idx)
        optional = [s for s in (meta.get("optionalSlots") or []) if s in slots]
        out.append({
            "name": f.stem,
            "slots": slots,
            "imageSlots": image_slots,
            "videoSlots": video_slots,
            "audioSlots": audio_slots,
            "mediaSlots": image_slots + video_slots + audio_slots,
            "requiredImageSlots": [s for s in image_slots if s not in optional],
            "optionalSlots": optional,
            "minImages": int(meta.get("minImages") or 0),
            "slotLabels": meta.get("slotLabels") or {},
            "fields": expand_fields(meta),
            "label": meta.get("label") or f.stem,
            "note": meta.get("note") or "",
            "use": meta.get("use") or kind,
            "kind": kind,
            "imported": bool(meta.get("imported")),
            "source": meta.get("source") or {},
            "nodes": len(g),
            "classes": classes[:12],
            "model": model.split("\\")[-1] if model else "",
            "mtime": datetime.fromtimestamp(f.stat().st_mtime).strftime("%m-%d %H:%M"),
            **template_caps(g),
        })
    return out


# ---------------------------------------------------------------- 素材

def _under(target: Path, root: Path) -> bool:
    try:
        target.relative_to(Path(root).resolve())
        return True
    except (ValueError, OSError):
        return False


def scan_materials(per_root: int = 160) -> list[dict]:
    """扫描白名单目录里的图片/视频，供画布左侧素材栏使用。

    按修改时间倒序，只取最近的一批——素材会越攒越多，全列出来没法用。
    """
    seen: set[str] = set()
    out: list[dict] = []
    for root in MATERIAL_ROOTS:
        r = Path(root)
        if not r.is_dir():
            continue
        try:
            files = [f for f in r.rglob("*") if f.is_file() and f.suffix.lower() in MEDIA_EXT]
        except OSError:
            continue
        files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        for f in files[:per_root]:
            key = str(f.resolve()).lower()
            if key in seen:
                continue
            try:
                rel = f.relative_to(r).as_posix()
            except ValueError:
                rel = f.name
            # 跳过脚本上传到 ComfyUI input 的临时副本，它们只是原素材的 hash 分身
            if r.name == "input" and rel.startswith("canvas/"):
                continue
            seen.add(key)
            out.append({
                "assetId": str(f),
                "filename": f.name,
                # 列表里只显示文件名：assets 下的相对路径是一串任务号，看了也没用
                "label": f.name,
                "path": rel,
                "kind": kind_of_ext(f.suffix),
                "url": "/api/raw?p=" + urllib.parse.quote(str(f)),
                "mtime": int(f.stat().st_mtime),
                "from": r.name,
            })
    out.sort(key=lambda m: -m["mtime"])
    return out[:400]


# ---------------------------------------------------------------- 执行

def prune_slot(graph: dict, slot: str) -> list[str]:
    """可选槽没接线时，把喂这个槽的整枝摘掉。

    H3 的 ref_images 是 AUTOGROW(min 0)，少一路照样能跑；但模板里的 LoadImage
    节点留着仍会要求传文件，所以节点和指向它的连线必须一起删干净。
    只对 meta 里声明过 optionalSlots 的槽生效——必填槽缺了就老实报错。
    """
    token = "{{" + slot + "}}"
    doomed = [
        nid
        for nid, v in graph.items()
        if isinstance(v, dict)
        and any(isinstance(x, str) and x.strip() == token for x in (v.get("inputs") or {}).values())
    ]
    if not doomed:
        return []
    for nid in doomed:
        graph.pop(nid, None)
    drop = {str(n) for n in doomed}
    for v in graph.values():
        if not isinstance(v, dict):
            continue
        ins = v.get("inputs")
        if not isinstance(ins, dict):
            continue
        for k in [k for k, ref in ins.items() if isinstance(ref, list) and len(ref) == 2 and str(ref[0]) in drop]:
            del ins[k]
    return doomed


def drop_orphan_unknown(graph: dict) -> list[str]:
    """扔掉「本机不认识、又没人引用」的节点。

    /prompt 会校验整张图，包括根本不会执行的部分：导入工作流时混进来的笔记 /
    占位节点（class_type 被写成了一句中文标题）会让整次提交 400 missing_node_type，
    而它既没有输入、也没人引用，删掉不影响任何产物。

    有人引用的未知节点不删 —— 那是真缺插件，得让人看见。
    """
    try:
        oi = comfy.object_info(timeout=8)
    except Exception:
        return []          # 拿不到节点表就不动：宁可让它报错，也不猜着删
    if not oi:
        return []
    used: set[str] = set()
    for v in graph.values():
        if not isinstance(v, dict):
            continue
        for x in (v.get("inputs") or {}).values():
            if isinstance(x, list) and len(x) == 2:
                used.add(str(x[0]))
    dead = [
        f"{nid}:{v.get('class_type')}"
        for nid, v in graph.items()
        if isinstance(v, dict) and str(nid) not in used and (v.get("class_type") or "") not in oi
    ]
    for nid in [d.split(":", 1)[0] for d in dead]:
        graph.pop(nid, None)
    return dead


MODEL_SUFFIX = (".safetensors", ".sft", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".onnx")

# 少数「同一个东西换了名字」的取值：本机清单里没有，但语义等价。
# 只写有把握的等价关系 —— 在这里猜模型，猜错会悄悄改掉出图。
ENUM_ALIASES = {
    # 新版 ComfyUI 的 flow-matching 调度器就是这个，本机旧版叫 simple
    ("KSampler", "scheduler"): {"FlowMatchEulerDiscreteScheduler": "simple"},
}


def _enum_of(cfg):
    """object_info 里「下拉框」输入的候选清单。

    两种写法都见过：[["a","b"], {}] 和 ["COMBO", {"options": [...]}]。
    """
    if not isinstance(cfg, list) or not cfg:
        return None
    head = cfg[0]
    if isinstance(head, list):
        return head
    if head == "COMBO" and len(cfg) > 1 and isinstance(cfg[1], dict):
        opts = cfg[1].get("options")
        if isinstance(opts, list):
            return opts
    return None


_RATIO_RE = re.compile(r"(\d+(?:\.\d+)?)\s*[:：]\s*(\d+(?:\.\d+)?)")


def _ratio_key(value):
    """把 `16:9` / `16:9 (Widescreen)` / `9:16竖` 都归到一个比例数值上。"""
    m = _RATIO_RE.search(str(value or ""))
    if not m:
        return None
    a, b = float(m.group(1)), float(m.group(2))
    if not a or not b:
        return None
    return round(a / b, 4)


def align_enum_params(
    ctx: dict, landings: dict, meta: dict, template: str
) -> tuple[list[str], list[str]]:
    """把参数值对齐到「落点节点真实的可选清单」上。

    同一个比例有两种写法：模板里是 ResolutionSelector 的原始枚举
    `16:9 (Widescreen)`，画布上比例卡存的是 `16:9`。换个模板时把旧值原样搬过去，
    就是 value_not_in_list，整单 400 —— 而 ComfyUI 只回一个节点号，看不出差在
    后面那截括注上。这里按「比例相同且候选唯一」还原成落点认可的写法；
    还原不了的当场报出可选清单，不让错值去撞 /prompt。

    只校验 meta 声明为参数的槽：媒体槽落点的枚举是 input 目录里的文件名，
    object_info 有十分钟缓存，按它校验刚上传的图会误报。
    """
    try:
        oi = comfy.object_info(timeout=8)
    except Exception:
        return [], []
    if not oi:
        return [], []
    param_slots = {
        f.get("slot")
        for f in meta.get("fields") or []
        if isinstance(f, dict) and f.get("type") in _PARAM_FIELD_TYPES
    }
    swaps: list[str] = []
    unresolved: list[str] = []
    for slot, value in list(ctx.items()):
        if slot not in param_slots or not isinstance(value, str) or not value:
            continue
        for cls, key in landings.get(slot) or []:
            spec = (oi.get(cls) or {}).get("input") or {}
            cfg = (spec.get("required") or {}).get(key) or (spec.get("optional") or {}).get(key)
            choices = _enum_of(cfg)
            if not choices or value in choices:
                continue
            alias = (ENUM_ALIASES.get((cls, key)) or {}).get(value)
            if alias and alias in choices:
                ctx[slot] = alias
                swaps.append(f"{slot}: {value} -> {alias}（等价改名）")
                break
            want = _ratio_key(value)
            same = [c for c in choices if isinstance(c, str) and want is not None and _ratio_key(c) == want]
            if len(same) == 1:
                ctx[slot] = same[0]
                swaps.append(f"{slot}: {value} -> {same[0]}")
                break
            shown = "、".join(str(c) for c in choices[:8])
            unresolved.append(f"{slot}=「{value}」（{cls}.{key} 只认：{shown}）")
            break
    return swaps, unresolved


def align_model_names(graph: dict):
    """把 Loader 里的模型名对齐到本机实际文件。

    别的机器上导出的工作流，模型名常常少了子目录这一层：模板里写
    `qwen_image_vae.safetensors`，本机文件其实在 `qwen\\` 下。ComfyUI 只认
    object_info 里那张清单，写错一个值就整单 400 prompt_outputs_failed_validation，
    而且报错指向的是节点号，看不出「差了一层目录」。

    只在「同名文件唯一」时替换；有零个或多个候选就报出来让人决定 ——
    选错量化版本会悄悄改变出图，这种事不能替用户猜。
    """
    try:
        oi = comfy.object_info(timeout=8)
    except Exception:
        return [], []
    if not oi:
        return [], []
    swaps: list[str] = []
    unresolved: list[str] = []
    for nid, node in graph.items():
        if not isinstance(node, dict):
            continue
        ins = node.get("inputs")
        if not isinstance(ins, dict):
            continue
        spec = (oi.get(node.get("class_type") or "") or {}).get("input") or {}
        cls = node.get("class_type") or ""
        for key, val in list(ins.items()):
            if not isinstance(val, str) or not val:
                continue
            cfg = (spec.get("required") or {}).get(key) or (spec.get("optional") or {}).get(key)
            choices = _enum_of(cfg)
            if not choices or val in choices:
                continue
            # 少数「同一个东西换了名字」的取值，本机清单里没有但语义等价
            alias = (ENUM_ALIASES.get((cls, key)) or {}).get(val)
            if alias and alias in choices:
                ins[key] = alias
                swaps.append(f"{nid}.{key}: {val} -> {alias}（等价改名）")
                continue
            base = val.replace("\\", "/").rsplit("/", 1)[-1]
            # 只管模型文件：LoadImage 那种上传进 input 目录的图不在 object_info 里
            # 及时刷新，按这张表校验会误报
            if not base.lower().endswith(MODEL_SUFFIX):
                continue
            same = [
                c for c in choices
                if isinstance(c, str) and c.replace("\\", "/").rsplit("/", 1)[-1] == base
            ]
            if len(same) == 1:
                ins[key] = same[0]
                swaps.append(f"{nid}.{key}: {val} -> {same[0]}")
                continue
            tok = base.split(".")[0].lower().split("_")[0]
            near = [c for c in choices if isinstance(c, str) and tok and tok in c.lower()][:3]
            unresolved.append(
                f"{node.get('class_type')}.{key}={val}" + (f"（本机相近：{'、'.join(near)}）" if near else "")
            )
    return swaps, unresolved


def compile_graph(template: str, params: dict, inputs: dict, prefix: str) -> tuple[dict, dict, list[str]]:
    """把模板 + 参数 + 输入编译成可提交的 API 图。

    返回 (graph, 实际使用的 ctx, 被摘掉的节点头)。ctx 里带实际 seed，前端要回填，否则没法复现。
    """
    tpl_path = TEMPLATES / f"{template}.json"
    if not tpl_path.is_file():
        raise ValueError(f"模板不存在：{template}")

    graph = comfy.load_template(tpl_path)
    meta = template_meta(template)
    optional = set(meta.get("optionalSlots") or [])
    slots = comfy.collect_slots(graph)
    landings = slot_landings(graph)
    field_defaults = {
        f["slot"]: f["default"]
        for f in meta.get("fields") or []
        if isinstance(f, dict) and f.get("slot") and f.get("default") not in (None, "")
    }

    ctx: dict = {}
    missing = []
    pruned: list[str] = []
    for slot in slots:
        if slot == "prefix":
            ctx["prefix"] = prefix
            continue
        kind = slot_media_kind(slot, landings, meta)
        ref = inputs.get(slot) if isinstance(inputs, dict) else None
        if ref:
            if kind == "param":
                # 素材挂在了参数槽上（典型：ref_image_size 这种 match/max 枚举）：
                # 路径写进枚举输入会被 /prompt 判 value_not_in_list，整单 400。
                # 这里丢掉这条并留痕，让它按普通参数走，而不是污染编译结果。
                rlog("tpl.stray_media", "W", tpl=template, slot=slot, ref=str(ref)[:80])
            else:
                local = comfy.resolve_image(str(ref))
                land = landings.get(slot) or []
                if kind == "image":
                    # LoadImage 只认 input 目录里的相对路径，必须先拷进去
                    ctx[slot] = comfy.upload_image(local)
                elif any(input_dir_loader(cls, key) for cls, key in land):
                    # 原生 LoadVideo / LoadAudio：file 是 input 目录里现列的 COMBO，
                    # 绝对路径会被 validate_inputs 判成 Invalid video file。
                    # 先放进 input 根目录（不能放 canvas/ 子目录，它只列根目录），再给文件名
                    ctx[slot] = comfy.upload_image(local, subfolder="")
                else:
                    # VHS_LoadVideoPath / VHS_LoadAudio 直接读绝对路径，省一次拷贝
                    ctx[slot] = local.as_posix()
                continue
        if slot in optional:
            pruned += prune_slot(graph, slot)
            continue
        if slot in params:
            v = params[slot]
            # negative 允许显式空字符串（cfg=1 模型本来就该留空），不能按「缺失」处理
            if str(v).strip() != "" or slot == "negative":
                ctx[slot] = v
                continue
        if slot == "negative":
            # UI 不渲染负向框时这个槽根本不会传过来，按空串补上，别让整个任务卡在校验上
            ctx[slot] = ""
            continue
        if slot in field_defaults:
            # 模板后加的字段（比如 ref_image_size 从误判的图片槽改回枚举参数），
            # 老项目里没有这个键，用 meta 声明的 default 顶上，别让旧节点点一下就报缺失
            ctx[slot] = field_defaults[slot]
            continue
        if slot == "seed":
            # 种子留空就随机，但要记下来
            ctx["seed"] = random.randint(0, 2**48)
            continue
        missing.append(slot)

    if missing:
        raise ValueError(f"参数缺失：{', '.join(missing)}")

    swaps, bad = align_enum_params(ctx, landings, meta, template)
    if swaps:
        # 同一比例的两种写法，改的是措辞不是语义，留痕即可
        rlog("tpl.enum_map", "W", tpl=template, n=len(swaps), pairs=" | ".join(swaps[:4]))
    if bad:
        # 值真的对不上（换了模板、旧节点存着别家的枚举），提前说清可选范围，
        # 别等 ComfyUI 回一个只有节点号的 400
        rlog("tpl.enum_bad", "E", tpl=template, n=len(bad), items=" | ".join(bad[:4]))
        raise ValueError(
            "参数取值不在模板允许的范围里：" + "；".join(bad[:3])
            + ("…" if len(bad) > 3 else "")
            + "。在参数面板里重选一下再跑。"
        )

    filled = comfy.fill_slots(graph, ctx)
    orphans = drop_orphan_unknown(filled)
    if orphans:
        # 不静默：日志里留一条，谁再遇到「模板能编译但 400」能顺着这里查到
        rlog("tpl.drop_orphan", "W", tpl=template, n=len(orphans), nodes=",".join(orphans[:6]))
        pruned += [f"orphan:{n}" for n in orphans]

    swaps, unresolved = align_model_names(filled)
    if swaps:
        rlog("tpl.model_alias", "W", tpl=template, n=len(swaps), pairs=" | ".join(swaps[:4]))
    if unresolved:
        # 提前把「本机没这个文件」说清楚，别等 ComfyUI 回一个只有节点号的 400
        rlog("tpl.model_missing", "E", tpl=template, n=len(unresolved), items=" | ".join(unresolved[:4]))
        raise ValueError(
            "模板里的模型本机没有：" + "；".join(unresolved[:3])
            + ("…" if len(unresolved) > 3 else "")
            + "。改模板里对应的文件名，或先把模型装到 ComfyUI 的 models 目录。"
        )
    return filled, ctx, pruned


def worker() -> None:
    """串行执行器。

    这个循环必须做到「无论如何都不退出」——线程死掉是静默故障：
    任务全部卡在 queued，界面上看起来只是「没反应」，找不到原因。
    所以外层套 try/except BaseException，任何异常都记下来继续取下一个。
    """
    global CURRENT
    WORKER_STATE["started_at"] = now()
    WORKER_STATE["alive"] = True
    while True:
        try:
            job_id = JOB_Q.get()
            WORKER_STATE["last_action"] = f"取到 {job_id}"
            with LOCK:
                job = JOBS.get(job_id)
                if not job or job["status"] != "queued":
                    continue
                job["status"] = "running"
                job["startedAt"] = now()
                CURRENT = job
            WORKER_STATE["last_job"] = job_id
            save_jobs()
            rlog("job.start", job=job_id, node=job.get("nodeId"), tpl=job.get("template"),
                 queued_from=job.get("createdAt"))

            try:
                run_job(job)
            except Exception as e:
                WORKER_STATE["last_error"] = f"{type(e).__name__}: {e}"
                with LOCK:
                    job["status"] = "error"
                    job["error"] = f"{type(e).__name__}: {e}"
                    job["finishedAt"] = now()
                    job["phase"] = "失败"
                save_jobs()
                rlog("job.fail", "E", job=job_id, node=job.get("nodeId"),
                     err=f"{type(e).__name__}: {e}",
                     at=traceback.format_exc().strip().splitlines()[-1][:160])
            finally:
                with LOCK:
                    CURRENT = None
                WORKER_STATE["processed"] += 1
                WORKER_STATE["last_action"] = f"完成 {job_id}"
        except BaseException as e:  # noqa: BLE001 - 这里的唯一目的是不让线程死掉
            WORKER_STATE["last_error"] = f"worker 循环异常 {type(e).__name__}: {e}"
            rlog("worker.crash", "E", err=f"{type(e).__name__}: {e}")
            try:
                (PROJECTS / "worker-errors.log").open("a", encoding="utf-8").write(
                    f"{now()} {traceback.format_exc()}\n"
                )
            except Exception:
                pass
            time.sleep(1)


def run_job(job: dict) -> None:
    prefix = job["id"]
    t_start = time.time()
    graph, ctx, pruned = compile_graph(job["template"], job.get("params") or {}, job.get("inputs") or {}, prefix)
    rlog("job.compiled", job=prefix, nodes=len(graph), pruned=len(pruned or []),
         seed=ctx.get("seed"), ms=int((time.time() - t_start) * 1000))
    with LOCK:
        job["phase"] = "已提交"
        job["usedSeed"] = ctx.get("seed", "")
        if pruned:
            job["pruned"] = pruned
    pid = comfy.submit(graph, client_id=f"canvas-{job['id'][:8]}")
    rlog("job.submitted", job=prefix, prompt=pid)
    with LOCK:
        job["promptId"] = pid
        job["phase"] = "生成中"

    # 轮询。ComfyUI 单队列，这里只需要等自己这条。
    t0 = time.time()
    last_beat = 0.0
    while True:
        time.sleep(0.6)
        # 守卫：一旦状态已定型就退出，避免任何原因导致的空转
        # （曾出现「已完成但循环不退出」，任务耗时从 20 秒涨到 669 秒）
        if job["status"] not in ("running", "queued"):
            return
        if job.get("canceled"):
            try:
                comfy.http_json("/interrupt", {}, timeout=10)
            except Exception:
                pass
            with LOCK:
                job["status"] = "canceled"
                job["finishedAt"] = now()
                job["phase"] = "已取消"
            save_jobs()
            rlog("job.canceled", job=prefix, after=round(time.time() - t0, 1))
            return

        item = comfy.history(pid)
        if item is None:
            if time.time() - t0 > 3600:
                raise TimeoutError("超过 1 小时未返回结果")
            # 队列位置用于进度反馈
            if time.time() - last_beat > 2:
                last_beat = time.time()
                qs = comfy.queue_state()
                with LOCK:
                    job["elapsed"] = round(time.time() - t0, 1)
                    job["queue"] = qs
            continue

        status, msg = comfy.status_of(item)
        if status == "running":
            with LOCK:
                job["elapsed"] = round(time.time() - t0, 1)
            continue

        if status == "error":
            with LOCK:
                job["status"] = "error"
                job["error"] = msg
                job["finishedAt"] = now()
                job["phase"] = "失败"
            save_jobs()
            rlog("job.comfy.error", "E", job=prefix, prompt=pid, err=msg,
                 after=round(time.time() - t0, 1))
            return

        # 完成：把所有产物拉回本地（带上 graph：加载节点的预览不算产物）
        files = comfy.extract_outputs(item, graph)
        saved = []
        for f in files:
            name = f["filename"]
            dest = ASSETS / job["id"] / name
            try:
                comfy.download(f, dest)
            except Exception as e:
                saved.append({"error": str(e)[:200], "filename": name})
                rlog("job.download.error", "E", job=prefix, file=name, err=str(e)[:160])
                continue
            kind = "video" if dest.suffix.lower() in (".mp4", ".webm", ".mov") else (
                "audio" if dest.suffix.lower() in (".wav", ".mp3", ".flac") else "image")
            saved.append({
                "assetId": f"{job['id']}/{name}",
                "url": f"/assets/{job['id']}/{urllib.parse.quote(name)}",
                "filename": name,
                "kind": kind,
            })

        if not saved:
            raise RuntimeError("执行完成但没有产物（模板里缺少 SaveImage / SaveVideo 节点？）")

        with LOCK:
            job["status"] = "done"
            job["outputs"] = saved
            job["finishedAt"] = now()
            job["elapsed"] = round(time.time() - t0, 1)
            job["phase"] = "完成"
            job["seed"] = extract_seed(item) or str(ctx.get("seed", ""))
        save_jobs()
        rlog("job.done", job=prefix, files=sum(1 for s in saved if not s.get("error")),
             failed=sum(1 for s in saved if s.get("error")),
             secs=round(time.time() - t0, 1), seed=job["seed"])
        return


def extract_seed(item: dict) -> str:
    """从执行图里把实际 seed 挖出来，便于复现。"""
    try:
        prompt = (item.get("prompt") or [None, None, {}])[2] or {}
        for v in prompt.values():
            if isinstance(v, dict):
                ins = v.get("inputs") or {}
                for k in ("noise_seed", "seed"):
                    if k in ins:
                        return str(ins[k])
    except Exception:
        pass
    return ""


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "CanvasServer/1.0"

    def log_message(self, fmt, *args):
        pass  # 静音，避免每 0.6 秒的轮询刷屏

    # ---- 工具
    def _send(self, code: int, body: bytes, ctype: str = "application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, obj, code: int = 200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _err(self, msg: str, code: int = 400):
        self._json({"error": msg}, code)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    def _files(self) -> list[tuple[str, bytes]]:
        """极简 multipart 解析：够收几张 png 就行，不引第三方库。

        只按 CRLF 精确裁掉分隔符两侧的两个字节，绝不用 strip——
        图片二进制尾部很可能就是 \\r\\n 或 0x2d，strip 会啃掉真实数据。
        """
        ctype = self.headers.get("Content-Type") or ""
        m = re.search(r'boundary=(?:"([^"]+)"|([^;]+))', ctype)
        if not m:
            raise ValueError("不是 multipart 请求")
        boundary = (m.group(1) or m.group(2) or "").strip().encode()
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n)
        out: list[tuple[str, bytes]] = []
        for part in raw.split(b"--" + boundary):
            if part.startswith(b"\r\n"):
                part = part[2:]
            if part.endswith(b"\r\n"):
                part = part[:-2]
            head, sep, body = part.partition(b"\r\n\r\n")
            if not sep or not body:
                continue
            fname = ""
            text = head.decode("utf-8", "replace")
            mf = re.search(r'filename="([^"]*)"', text)
            if mf:
                fname = mf.group(1)
            if fname:
                out.append((fname, body))
        return out

    def do_OPTIONS(self):
        self._send(204, b"")

    # ---- 路由
    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        if path not in ("/api/health", "/api/jobs", "/api/log"):
            REQ_LOG.append((f"GET {path}", int(time.time())))

        if path == "/api/health":
            st = comfy.system_stats()
            st["queue"] = comfy.queue_state()
            with LOCK:
                st["jobs"] = {
                    "queued": sum(1 for j in JOBS.values() if j["status"] == "queued"),
                    "running": sum(1 for j in JOBS.values() if j["status"] == "running"),
                }
            st["recent"] = list(REQ_LOG)[-12:]
            st["worker"] = dict(WORKER_STATE, queue_size=JOB_Q.qsize())
            return self._json(st)

        if path == "/api/templates":
            return self._json({"templates": list_templates()})

        if path == "/api/graph":
            if DEFAULT_PROJECT.is_file():
                return self._send(200, DEFAULT_PROJECT.read_bytes())
            return self._json({"nodes": [], "edges": [], "viewport": {"x": 0, "y": 0, "zoom": 1}})

        if path == "/api/jobs":
            with LOCK:
                items = sorted(JOBS.values(), key=lambda j: j.get("createdAt", ""), reverse=True)
            limit = int((qs.get("limit") or ["80"])[0])
            return self._json({"jobs": items[:limit]})

        if path == "/api/log":
            # 取最近日志：节点调试条和「刚才到底发生了什么」都查这里
            limit = int((qs.get("limit") or ["200"])[0])
            node = (qs.get("node") or [""])[0]
            session = (qs.get("session") or [""])[0]
            with LOG_LOCK:
                items = list(LOG_RING)
            if node:
                items = [it for it in items if str(it["fields"].get("node")) == node]
            if session:
                items = [it for it in items if str(it["fields"].get("session")) == session]
            return self._json({"entries": items[-max(1, min(limit, 600)):], "file": str(RUNTIME_LOG)})

        if path == "/api/models":
            kind = (qs.get("kind") or [""])[0]
            try:
                oi = comfy.http_json("/object_info", timeout=60)
            except comfy.ComfyError as e:
                return self._err(str(e), 502)
            field_map = {
                "checkpoints": ("CheckpointLoaderSimple", "ckpt_name"),
                "unet": ("UNETLoader", "unet_name"),
                "vae": ("VAELoader", "vae_name"),
                "clip": ("CLIPLoader", "clip_name"),
                "lora": ("LoraLoaderModelOnly", "lora_name"),
            }
            if kind not in field_map:
                return self._json({"kinds": list(field_map)})
            node, field = field_map[kind]
            try:
                opts = oi[node]["input"]["required"][field][0]
            except Exception:
                return self._json({"kind": kind, "items": []})
            return self._json({"kind": kind, "items": opts if isinstance(opts, list) else []})

        if path == "/api/materials":
            return self._json({"materials": scan_materials()})

        if path == "/api/raw":
            raw = (qs.get("p") or [""])[0]
            if not raw:
                return self._err("缺 p", 400)
            target = Path(raw).resolve()
            if not any(_under(target, r) for r in MATERIAL_ROOTS) or not target.is_file():
                return self._err("不在允许目录内或不存在", 403)
            ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            return self._send(200, target.read_bytes(), ctype)

        if path.startswith("/assets/"):
            rel = urllib.parse.unquote(path[len("/assets/"):])
            target = (ASSETS / rel).resolve()
            if not str(target).startswith(str(ASSETS.resolve())) or not target.is_file():
                return self._err("not found", 404)
            ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            return self._send(200, target.read_bytes(), ctype)

        # 静态前端（vite 构建产物）
        if DIST.is_dir():
            rel = path.lstrip("/") or "index.html"
            target = (DIST / rel).resolve()
            if not str(target).startswith(str(DIST.resolve())):
                return self._err("forbidden", 403)
            if not target.is_file():
                target = DIST / "index.html"
            ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            return self._send(200, target.read_bytes(), ctype)

        return self._err("前端还没构建：cd canvas/web && npm install && npm run build", 404)

    def do_PUT(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/graph":
            body = self._body()
            DEFAULT_PROJECT.write_text(json.dumps(body, ensure_ascii=False, indent=1), encoding="utf-8")
            return self._json({"ok": True, "nodes": len(body.get("nodes") or [])})
        return self._err("not found", 404)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path

        if path == "/api/error":
            body = self._body()
            msg = f"[{body.get('kind', '?')}] {body.get('detail', '')}"
            REQ_LOG.append((msg[:180], int(time.time())))
            try:
                with open(PROJECTS / "client-errors.log", "a", encoding="utf-8") as f:
                    f.write(f"{now()} {msg}\n  url={body.get('url', '')}\n")
            except Exception:
                pass
            return self._json({"ok": True})

        if path == "/api/log":
            # 前端运行日志上报（批量）。字段一律当不可信输入压平、截断。
            body = self._body()
            entries = body.get("entries")
            if not isinstance(entries, list):
                return self._err("entries 必须是数组")
            session = str(body.get("session") or "")[:8]
            n = 0
            for it in entries[:200]:
                if not isinstance(it, dict):
                    continue
                ev = re.sub(r"[^A-Za-z0-9_.]+", "_", str(it.get("ev") or "?"))[:60] or "?"
                lvl = str(it.get("lvl") or "I")[:1].upper()
                if lvl not in ("I", "D", "W", "E"):
                    lvl = "I"
                fields = {"src": "ui"}
                if session:
                    fields["session"] = session
                if it.get("node"):
                    fields["node"] = str(it["node"])[:40]
                f = it.get("f")
                if isinstance(f, dict):
                    for k, v in list(f.items())[:12]:
                        if isinstance(v, (dict, list)):
                            v = json.dumps(v, ensure_ascii=False)
                        fields[str(k)[:24]] = v
                rlog(ev, lvl, **fields)
                n += 1
            return self._json({"ok": True, "written": n})

        if path == "/api/upload":
            try:
                files = self._files()
            except ValueError as e:
                return self._err(str(e))
            if not files:
                return self._err("没有收到文件")
            saved = []
            for fname, blob in files:
                ext = Path(fname).suffix.lower()
                if ext not in IMAGE_EXT | VIDEO_EXT | AUDIO_EXT:
                    continue
                stem = re.sub(r"[^A-Za-z0-9_-]+", "_", Path(fname).stem)[:40] or "upload"
                safe = f"{stem}-{hashlib.md5(blob).hexdigest()[:8]}{ext}"
                dest = UPLOADS / safe
                dest.write_bytes(blob)
                saved.append({
                    "assetId": str(dest),
                    "url": "/assets/uploads/" + urllib.parse.quote(safe),
                    "filename": safe,
                    "label": safe,
                    "kind": kind_of_ext(ext),
                })
            if not saved:
                rlog("upload.reject", "W", files=len(files), why="no-image-video-audio")
                return self._err("只收图片 / 视频 / 音频")
            rlog("upload.ok", files=len(saved), names=",".join(s["filename"] for s in saved[:4]))
            return self._json({"files": saved})

        if path == "/api/compile":
            # dry-run：只编译不提交，用来验槽位/剪枝，不占 GPU
            body = self._body()
            name = (body.get("template") or "").strip()
            try:
                graph, ctx, pruned = compile_graph(name, body.get("params") or {}, body.get("inputs") or {}, "dryrun")
            except Exception as e:
                return self._err(f"{type(e).__name__}: {e}")
            return self._json({
                "nodes": sorted(graph),
                "pruned": pruned,
                "ctx": {k: (str(v)[:120] if k != "prefix" else v) for k, v in ctx.items()},
            })

        if path == "/api/run":
            body = self._body()
            template = (body.get("template") or "").strip()
            if not template:
                return self._err("缺 template")
            job = {
                "id": datetime.now().strftime("%m%d%H%M%S") + "-" + uuid.uuid4().hex[:5],
                "nodeId": body.get("nodeId"),
                "label": (body.get("label") or template)[:80],
                "template": template,
                "params": body.get("params") or {},
                "inputs": body.get("inputs") or {},
                "status": "queued",
                "phase": "排队中",
                "createdAt": now(),
                "outputs": [],
                "elapsed": 0,
            }
            with LOCK:
                JOBS[job["id"]] = job
            JOB_Q.put(job["id"])
            save_jobs()
            rlog(
                "job.queued",
                job=job["id"],
                node=job.get("nodeId"),
                tpl=template,
                ins=len(job["inputs"]),
                prompt_chars=len(str((job["params"] or {}).get("prompt") or "")),
                params=json.dumps(job["params"], ensure_ascii=False)[:150],
            )
            return self._json({"job": job})

        m = re.match(r"^/api/jobs/([^/]+)/cancel$", path)
        if m:
            jid = m.group(1)
            with LOCK:
                job = JOBS.get(jid)
                if not job:
                    return self._err("任务不存在", 404)
                if job["status"] in ("queued", "running"):
                    job["canceled"] = True
                    if job["status"] == "queued":
                        job["status"] = "canceled"
                        job["finishedAt"] = now()
            save_jobs()
            rlog("job.cancel.req", job=jid, was=job.get("status"))
            return self._json({"ok": True})

        if path == "/api/template/preview":
            body = self._body()
            name = (body.get("template") or "").strip()
            try:
                g = comfy.load_template(TEMPLATES / f"{name}.json")
            except Exception as e:
                return self._err(f"读模板失败：{e}", 404)
            return self._json({"slots": comfy.collect_slots(g), "graph": g})

        # ---- 工作流导入
        if path == "/api/workflow/analyze":
            body = self._body()
            try:
                oi = comfy.object_info()
            except comfy.ComfyError as e:
                return self._err(f"拿不到 ComfyUI 节点表：{e}", 502)
            try:
                r = workflow_import.analyze(body.get("graph"), oi)
            except ValueError as e:
                return self._err(str(e))
            except Exception as e:  # noqa: BLE001 - 别把栈丢在前端
                return self._err(f"解析失败：{type(e).__name__}: {e}", 500)
            r["file"] = str(body.get("file") or "")[:120]
            return self._json(r)

        if path == "/api/workflow/save":
            body = self._body()
            name = workflow_import.clean_name(body.get("name") or "")
            if not name:
                return self._err("模板名不能为空（只能用字母、数字、下划线、横线）")
            target = TEMPLATES / f"{name}.json"
            if target.is_file() and not template_meta(name).get("imported"):
                return self._err(f"「{name}」是内置模板，不能覆盖，换个名字")
            if target.is_file() and not body.get("overwrite"):
                return self._err(f"「{name}」已存在，确认覆盖再提交")

            graph = body.get("graph")
            sels = body.get("selections") or []
            if not isinstance(graph, dict) or not sels:
                return self._err("缺 graph 或没勾选任何输入")
            use = body.get("use") or "imagegen"
            if use not in ("imagegen", "videogen", "template"):
                use = "imagegen"

            try:
                tpl, meta = workflow_import.build(graph, sels)
            except Exception as e:
                return self._err(f"生成模板失败：{type(e).__name__}: {e}")

            # 导入文件里常混着笔记/占位节点：class_type 被写成一句人话，本机没有这个节点。
            # 它不会执行，却会让 /prompt 整单 400 —— 没人引用就当场扔掉，并告诉用户扔了什么。
            orphans = drop_orphan_unknown(tpl)
            if orphans:
                rlog("tpl.import.orphan", "W", tpl=name, n=len(orphans), nodes=",".join(orphans[:6]))

            # 槽位名不能和图上已有的 {{...}} 撞：撞了就会互相覆盖
            slots = comfy.collect_slots(tpl)
            landings = slot_landings(tpl)
            fields = {f["slot"] for f in meta.get("fields") or []}
            media = {s for s in slots if slot_media_kind(s, landings, meta) != "param"}
            unknown = [s for s in slots if s != "prefix" and s not in fields and s not in media]
            if unknown:
                return self._err("这些槽位没有对应的字段声明：" + "、".join(unknown[:6]))

            meta["label"] = str(body.get("label") or name)[:60]
            meta["use"] = use
            meta["note"] = str(body.get("note") or "")[:300]
            meta["source"] = {
                "file": str(body.get("file") or "")[:120],
                "at": workflow_import.now_text(),
                "nodes": len([v for v in tpl.values() if isinstance(v, dict)]),
            }
            target.write_text(json.dumps(tpl, ensure_ascii=False, indent=1), encoding="utf-8")
            (TEMPLATES / f"{name}.meta.json").write_text(
                json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8"
            )
            made = next((t for t in list_templates() if t["name"] == name), None)
            return self._json({
                "ok": True,
                "name": name,
                "template": made,
                "skipped": meta.get("skipped") or [],
                "dropped": orphans,
            })

        if path == "/api/template/delete":
            body = self._body()
            name = workflow_import.clean_name(body.get("name") or "")
            if not name:
                return self._err("缺 name")
            if not template_meta(name).get("imported"):
                return self._err("内置模板不能删，只能删自己导入的")
            for f in (TEMPLATES / f"{name}.json", TEMPLATES / f"{name}.meta.json"):
                try:
                    f.unlink()
                except FileNotFoundError:
                    pass
            return self._json({"ok": True})

        return self._err("not found", 404)


def main() -> int:
    ap = argparse.ArgumentParser(description="画布后端")
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()

    load_jobs()
    threading.Thread(target=worker, daemon=True).start()

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"画布后端 http://{args.host}:{args.port}", flush=True)
    print(f"  ComfyUI -> {comfy.COMFY}", flush=True)
    print(f"  模板目录 -> {TEMPLATES}", flush=True)
    print(f"  产物目录 -> {ASSETS}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n停止")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
