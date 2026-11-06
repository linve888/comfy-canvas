#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把上传的 ComfyUI API 工作流拆成「模板 + 槽位」。

判断依据优先取 /object_info：输入类型、默认值、取值范围、AUTOGROW 的最小路数
都是节点自己声明的，比按输入名猜可靠得多。只有 object_info 里没有这个节点
（缺插件）时才退回按名字 / 扩展名判断，并记一条警告。

产出两个文件：
  templates/<name>.json      把选中的输入换成 {{slot}} 之后的图
  templates/<name>.meta.json 槽位标签、字段声明、可选槽位

槽位命名沿用旧规矩：媒体槽一律 image_N / video_N / audio_N，普通参数撞上这三个词
就加 p_ 前缀（如 p_ref_image_size）。分类本身已经不看名字了 —— 后端
slot_media_kind 按槽位在图上落在哪个节点的哪个输入判定，前端读后端给的
imageSlots / videoSlots / audioSlots —— 这里的命名只为可读性和兼容旧模板。
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
VIDEO_EXT = {".mp4", ".webm", ".mov", ".mkv", ".avi"}
AUDIO_EXT = {".wav", ".mp3", ".flac", ".m4a", ".ogg"}

# 出片的模板：这几个节点只要有一个就算视频
VIDEO_OUT = {"SaveVideo", "CreateVideo", "VHS_VideoCombine", "SaveWEBM", "SaveAnimatedWEBP", "SaveAnimatedPNG"}

# 真会落文件的节点。CreateVideo 只是把帧拼成 VIDEO 对象，不写盘，不能算
SAVE_CLASSES = {"VHS_VideoCombine", "PreviewImage", "PreviewAudio", "PreviewVideo", "SaveImageWebp"}


def _saves(ct: str) -> bool:
    return ct.startswith("Save") or ct in SAVE_CLASSES

# 选模型 / 选算法这类输入做成槽位没有意义，只会把节点面板塞满
NOISE_KEYS = {
    "filename_prefix", "sampler_name", "scheduler", "weight_dtype", "device",
    "format", "codec", "bit_depth", "color_space", "format.codec", "multiple",
    "attention", "selection", "verbose", "dense_blocks", "sink_conditioning",
    "head_chunks", "chunks", "seq_threshold", "min_tokens", "extra_tokens",
    "start_percent", "end_percent", "start_at_step", "end_at_step",
    "force_rate", "custom_width", "custom_height", "frame_load_cap",
    "skip_first_frames", "select_every_nth", "seek_seconds",
    "expression", "type", "strength_model", "strength_clip", "strength",
}
MODEL_EXT = (".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".sft", ".onnx")

# 默认就勾上的参数（其余参数照样列出来，默认不勾）
CORE_KEYS = {
    "aspect_ratio", "megapixels", "resolution", "width", "height",
    "batch_size", "batch", "length", "duration", "num_frames", "frame_count",
}

LABELS = {
    "prompt": "提示词", "negative": "负向", "negative_prompt": "负向",
    "seed": "种子", "noise_seed": "种子",
    "aspect_ratio": "比例", "megapixels": "像素（MP）", "resolution": "像素预算",
    "width": "宽", "height": "高", "batch": "张数", "batch_size": "张数",
    "length": "帧数", "duration": "时长（秒）", "fps": "帧率",
    "steps": "步数", "cfg": "引导强度", "denoise": "重绘幅度",
    "scale_by": "放大倍数", "denoise_strength": "重绘幅度",
}

PROMPT_ALIASES = {"prompt", "text", "text_g", "text_l", "caption", "positive", "prompt_text"}

ASPECT_VALUES = [
    "9:16 (Portrait Widescreen)", "16:9 (Widescreen)", "1:1 (Square)",
    "3:4 (Portrait Standard)", "4:3 (Standard)", "2:3 (Portrait Photo)",
    "3:2 (Photo)", "21:9 (Ultrawide)",
]


# ---------------------------------------------------------------- 基础工具

def clean_name(name: str) -> str:
    """模板名只能是安全字符：它是文件名，也会进 URL。"""
    n = re.sub(r"[^A-Za-z0-9_-]+", "_", (name or "").strip()).strip("_-")
    return n[:48]


def is_link(graph: dict, v) -> bool:
    """ComfyUI 的连线记法：[节点id, 输出序号]。"""
    return (
        isinstance(v, list) and len(v) == 2
        and isinstance(v[1], int) and not isinstance(v[1], bool)
        and isinstance(v[0], (str, int)) and not isinstance(v[0], bool)
        and str(v[0]) in graph
    )


def _spec(oi_node: dict | None, key: str):
    """查输入声明。AUTOGROW 的输入在图上记成 "ref_images.ref_image_0" 这种扁平点号键，
    查表时得退回第一段。"""
    inp = (oi_node or {}).get("input") or {}
    keys = [key]
    if "." in key:
        keys.append(key.split(".")[0])
    for k in keys:
        for sect in ("required", "optional"):
            d = inp.get(sect) or {}
            if k in d:
                return sect, d[k]
    return "", None


def _type_of(spec):
    """拆成 (类型名, 选项表, 附加声明)。COMBO 的选项表可能是裸 list。"""
    if not isinstance(spec, list) or not spec:
        return "?", [], {}
    t = spec[0]
    opts = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
    if isinstance(t, list):                       # 老式下拉：直接把选项当类型
        return "COMBO", t, opts
    return str(t), opts.get("options") or [], opts


def _media_kind(ct: str, key: str, val, opts: dict, options: list) -> str:
    """这个输入吃哪类媒体。空串 = 不是媒体输入。"""
    if isinstance(val, str):
        ext = Path(val).suffix.lower()
        if ext in IMAGE_EXT:
            return "image"
        if ext in VIDEO_EXT:
            return "video"
        if ext in AUDIO_EXT:
            return "audio"
    # VHS 的加载节点会把可选扩展名声明出来，连默认值都没填也能认
    exts = [str(x).lower().lstrip(".") for x in (opts.get("vhs_path_extensions") or [])]
    if exts:
        if any(e in ("mp4", "webm", "mkv", "mov", "avi") for e in exts):
            return "video"
        if any(e in ("wav", "mp3", "flac", "m4a", "ogg") for e in exts):
            return "audio"
    if opts.get("image_upload"):
        return "image"
    # LoadImage 这类节点：输入是「input 目录里现存的文件名」下拉，选项全是图片
    if options and isinstance(val, str) and val in options:
        exts = {Path(o).suffix.lower() for o in options if isinstance(o, str)}
        if exts & IMAGE_EXT:
            return "image"
        if exts & VIDEO_EXT:
            return "video"
        if exts & AUDIO_EXT:
            return "audio"
    k = key.lower()
    if k in ("image", "image_path", "image_file") and "load" in ct.lower():
        return "image"
    return ""


def _consumers(graph: dict, nid: str) -> list[tuple[str, str]]:
    """谁在吃这个节点的输出（含 AUTOGROW 组里的，组名也算）。"""
    out = []
    for cid, node in graph.items():
        ins = node.get("inputs")
        if not isinstance(ins, dict):
            continue
        for k, v in ins.items():
            if isinstance(v, dict):
                if any(is_link(graph, x) and str(x[0]) == nid for x in v.values()):
                    out.append((cid, k))
            elif is_link(graph, v) and str(v[0]) == nid:
                out.append((cid, k))
    return out


def _prune_safe(graph: dict, oi: dict, nid: str) -> tuple[bool, str]:
    """没接线时能不能把这个节点整枝剪掉。

    只有 AUTOGROW 且 min=0 的输入才安全：剪掉上游后下游那个口消失，图仍然合法。
    普通必填口被剪掉会直接校验失败，所以这种槽默认必须接。
    """
    cons = _consumers(graph, nid)
    if not cons:
        return True, ""
    for cid, key in cons:
        ct = (graph.get(cid) or {}).get("class_type") or ""
        _, spec = _spec(oi.get(ct), key)
        t0, _, opts = _type_of(spec)
        if t0 != "COMFY_AUTOGROW_V3":
            return False, f"{ct}.{key} 不是自动增长口"
        if int(opts.get("min") or 0) > 0:
            return False, f"{ct}.{key} 至少 {opts.get('min')} 路"
    return True, ""


# ---------------------------------------------------------------- 分析

def analyze(graph, oi: dict) -> dict:
    """拆出「哪些输入值得做成槽位」。不改图，只给候选清单。"""
    if isinstance(graph, str):
        try:
            graph = json.loads(graph)
        except Exception as e:
            raise ValueError(f"不是合法 JSON：{e}") from None
    if not isinstance(graph, dict) or not graph:
        raise ValueError("读不到节点表，这不像 ComfyUI 的 API 格式工作流")

    if isinstance(graph.get("nodes"), list):
        raise ValueError(
            "这是界面格式的 workflow.json。请在 ComfyUI 里用「工作流 → 导出（API）」"
            "或开启开发者模式后「保存（API 格式）」导出，再传那个文件。"
        )

    nodes = {str(k): v for k, v in graph.items() if isinstance(v, dict) and v.get("class_type")}
    if not nodes:
        raise ValueError("工作流里没有节点")

    warnings: list[str] = []
    classes = sorted({v.get("class_type") or "" for v in nodes.values()})
    unknown = [c for c in classes if c not in oi]
    if unknown:
        warnings.append("本机 ComfyUI 不认识这些节点（可能缺插件，导入后跑会报错）：" + "、".join(unknown[:8]))

    cands: list[dict] = []
    counter = {"image": 0, "video": 0, "audio": 0, "prompt": 0, "negative": 0}

    # 接在采样器 negative 口上的文本节点就是负向：它的输入名叫 text，光看名字会误判成提示词
    neg_nodes: set[str] = set()
    for node in nodes.values():
        neg = (node.get("inputs") or {}).get("negative")
        if isinstance(neg, list) and len(neg) == 2:
            neg_nodes.add(str(neg[0]))

    for nid, node in nodes.items():
        ct = node.get("class_type") or ""
        oi_node = oi.get(ct)
        ins = node.get("inputs")
        if not isinstance(ins, dict):
            continue
        for key, val in ins.items():
            if val is None or isinstance(val, dict) or is_link(graph, val):
                continue
            k = key.lower()
            if k in NOISE_KEYS:
                continue
            if isinstance(val, str) and val.lower().endswith(MODEL_EXT):
                continue

            sect, spec = _spec(oi_node, key)
            t0, options, opts = _type_of(spec)

            kind, media, label, priority = "", "", "", 1

            mk = _media_kind(ct, key, val, opts, options)
            if mk:
                media, kind, priority = mk, "media", 0
                optional = False
                hint = ""
                if media == "image":
                    counter["image"] += 1
                    idx = counter["image"]
                    suggest = f"image_{idx}"
                    label = f"图 {idx}"
                elif media == "video":
                    counter["video"] += 1
                    idx = counter["video"]
                    suggest = f"video_{idx}"
                    label = f"视频 {idx}"
                else:
                    counter["audio"] += 1
                    idx = counter["audio"]
                    suggest = f"audio_{idx}"
                    label = f"音频 {idx}"
                ok, why = _prune_safe(graph, oi, nid)
                # 一组的第一个槽默认必接（工作流里既然接了，说明缺它不成立）；
                # 多路时才默认可选 —— 九图那种模板没人会次次接满
                same_group = counter[media]
                optional = ok and same_group > 1
                if not ok:
                    hint = "必接：" + why
                cands.append({
                    "id": f"{nid}.{key}", "node": nid, "input": key, "class": ct,
                    "value": _short(val), "kind": kind, "media": media,
                    "suggest": suggest, "label": label, "priority": 0, "checked": True,
                    "optional": optional, "pruneable": ok, "hint": hint,
                    "spec": {}, "options": [],
                })
                continue

            if t0 == "STRING":
                # 名字优先：TextEncodeQwenImage21 这类节点一个节点里同时有 prompt 和
                # negative_prompt，"接到 negative 口上"这条规则不能盖过字段名
                if "negative" in k:
                    kind = "negative"
                    priority = 0
                elif "prompt" in k or k in PROMPT_ALIASES:
                    kind = "prompt"
                    priority = 0
                elif nid in neg_nodes:
                    # 普通 CLIPTextEncode 的字段就叫 text，只能靠它接到哪个口来判断
                    kind = "negative"
                    priority = 0
                elif opts.get("multiline"):
                    # 多行但名字不带 prompt：当普通文本参数，默认不勾，别抢提示词的位置
                    kind = "text"
                    priority = 1
                else:
                    continue
                if kind == "negative":
                    counter["negative"] += 1
                    suggest = "negative" if counter["negative"] == 1 else f"negative_{counter['negative']}"
                    label = "负向提示词"
                elif kind == "prompt":
                    counter["prompt"] += 1
                    suggest = "prompt" if counter["prompt"] == 1 else f"prompt_{counter['prompt']}"
                    label = "提示词" if counter["prompt"] == 1 else f"提示词 {counter['prompt']}"
                else:
                    suggest = _slotify(key)
                    label = LABELS.get(k, key)
                cands.append(_cand(nid, key, ct, val, kind, suggest, label, priority, spec, t0, options, opts))
                continue

            if t0 == "?" or not spec:
                # 节点不在 object_info 里：只能按名字兜
                if "prompt" in k:
                    counter["prompt"] += 1
                    cands.append(_cand(nid, key, ct, val, "prompt", f"prompt_{counter['prompt']}" if counter["prompt"] > 1 else "prompt",
                                       "提示词", 0, spec, "STRING", [], {}))
                continue

            if k in ("seed", "noise_seed", "rand_seed") or (t0 == "INT" and opts.get("control_after_generate")):
                cands.append(_cand(nid, key, ct, val, "seed", "seed", "种子", 0, spec, t0, options, opts))
                continue

            priority = 0 if k in CORE_KEYS else 1
            if t0 in ("INT", "FLOAT"):
                kind = "number"
            elif t0 == "COMBO":
                kind = "select"
            else:
                # BOOLEAN 之类先不做：前端下拉会把布尔转成字符串，提交时 ComfyUI 会打回
                continue
            if k == "aspect_ratio" and priority == 0:
                suggest, label = "aspect", "比例"
            else:
                suggest, label = _slotify(key), LABELS.get(k, key)
            cands.append(_cand(nid, key, ct, val, kind, suggest, label, priority, spec, t0, options, opts))

    # 去重：同名参数在不同节点上很常见（宽高两个节点各一份），加序号区分
    seen: dict[str, int] = {}
    for c in cands:
        if c["kind"] == "media":
            continue
        base = c["suggest"]
        n = seen.get(base, 0) + 1
        seen[base] = n
        if n > 1 and base not in ("prompt", "negative"):
            c["suggest"] = f"{base}_{n}"

    # 顺序：媒体 → 提示词 → 种子 → 核心参数 → 其他参数
    rank = {"media": 0, "prompt": 1, "negative": 2, "seed": 3}
    cands.sort(key=lambda c: (c["priority"], rank.get(c["kind"], 4), _nid_key(c["node"]), c["input"]))

    has_save = any(_saves(v.get("class_type") or "") for v in nodes.values())
    if not has_save:
        warnings.append("没找到保存节点（SaveImage / SaveVideo / VHS_VideoCombine），跑完不会有产物文件。")

    kind = "video" if any((v.get("class_type") or "") in VIDEO_OUT for v in nodes.values()) else "image"
    return {
        "nodes": len(nodes),
        "classes": classes,
        "kind": kind,
        "use": "videogen" if kind == "video" else "imagegen",
        "candidates": cands,
        "warnings": warnings,
        "counts": {
            "image": counter["image"], "video": counter["video"], "audio": counter["audio"],
            "params": len([c for c in cands if c["kind"] not in ("media", "prompt", "negative", "seed")]),
        },
    }


def _nid_key(nid: str):
    """节点 id 排序：'178:166' 这种带冒号的按数字段比，别按字典序。"""
    return [int(x) if x.isdigit() else 0 for x in re.split(r"[:\-_]", str(nid))]


def _short(val, n: int = 90) -> str:
    if isinstance(val, bool):
        return "是" if val else "否"
    if isinstance(val, (int, float)):
        return str(val)
    s = str(val).replace("\n", " ")
    return s if len(s) <= n else s[: n - 1] + "…"


def _slotify(key: str) -> str:
    """参数槽名：不许带 image/video/audio，否则会被当成媒体口。"""
    s = re.sub(r"[^a-z0-9_]+", "_", str(key).lower()).strip("_") or "param"
    if re.search(r"image|video|audio", s):
        s = "p_" + s
    if s[0].isdigit():
        s = "p_" + s
    return s


def _cand(nid, key, ct, val, kind, suggest, label, priority, spec, t0, options, opts) -> dict:
    s: dict = {"type": t0}
    for f in ("min", "max", "step"):
        if opts.get(f) is not None:
            s[f] = opts[f]
    if opts.get("default") is not None:
        s["default"] = opts["default"]
    if opts.get("multiline"):
        s["multiline"] = True
    return {
        "id": f"{nid}.{key}", "node": nid, "input": key, "class": ct,
        "value": _short(val), "kind": kind, "media": "",
        "suggest": suggest, "label": label, "priority": priority,
        "checked": priority == 0, "optional": False, "pruneable": False, "hint": "",
        "spec": s, "options": [o for o in (options or []) if isinstance(o, str)][:120],
        "aspect": key.lower() == "aspect_ratio",
    }


# ---------------------------------------------------------------- 生成模板

def build(graph: dict, selections: list[dict]) -> tuple[dict, dict]:
    """按勾选结果把输入换成 {{slot}}，返回 (模板图, meta)。"""
    g = json.loads(json.dumps(graph))
    nodes = {str(k): v for k, v in g.items() if isinstance(v, dict)}

    used: set[str] = set()
    fields: list[dict] = []
    labels: dict[str, str] = {}
    optional: list[str] = []
    n = {"image": 0, "video": 0, "audio": 0}
    skipped: list[str] = []

    def take(name: str) -> str:
        base = name
        i = 2
        while name in used:
            name = f"{base}_{i}"
            i += 1
        used.add(name)
        return name

    for s in selections:
        if not s.get("checked"):
            continue
        nid, key = str(s.get("node") or ""), str(s.get("input") or "")
        node = nodes.get(nid)
        ins = (node or {}).get("inputs")
        if not node or not isinstance(ins, dict) or key not in ins:
            skipped.append(f"{nid}.{key}")
            continue
        kind = s.get("kind") or ""
        media = s.get("media") or ""

        if kind == "media" and media in n:
            n[media] += 1
            slot = take(f"{media}_{n[media]}")
            ins[key] = "{{%s}}" % slot
            labels[slot] = s.get("label") or f"{media} {n[media]}"
            if s.get("optional"):
                optional.append(slot)
            continue

        orig = ins[key]
        if kind == "negative":
            slot = take("negative")
        elif kind == "prompt":
            slot = take("prompt" if "prompt" not in used else "prompt_2")
        elif kind == "seed":
            slot = take("seed")
        else:
            slot = take(_slotify(s.get("suggest") or key))
        if slot.startswith("negative") and slot != "negative":
            skipped.append(f"{nid}.{key}（同一张图里第二个负向口，先不导出）")
            continue

        ins[key] = "{{%s}}" % slot
        fields.append(_field(slot, s, orig))
        labels[slot] = s.get("label") or slot

    # 产物前缀强制走 jobId：否则产物全叫 ComfyUI_00001_.png，归档时对不上任务
    for node in nodes.values():
        ins = node.get("inputs")
        if isinstance(ins, dict) and "filename_prefix" in ins and not is_link(g, ins["filename_prefix"]):
            ins["filename_prefix"] = "{{prefix}}"

    meta = {
        "label": "",
        "use": "",
        "note": "",
        "imported": True,
        "optionalSlots": optional,
        "minImages": 0,
        "slotLabels": labels,
        "fields": fields,
    }
    if skipped:
        meta["skipped"] = skipped
    return g, meta


def _field(slot: str, s: dict, val) -> dict:
    """把候选变成前端能直接渲染的字段声明。默认值取工作流里的原值。

    注意 val 必须来自原图，不能取候选里的 value —— 那个是为列表展示截断过的。
    """
    kind = s.get("kind") or "text"
    spec = s.get("spec") or {}
    out: dict = {"slot": slot, "label": s.get("label") or slot}

    if kind == "seed":
        out["type"] = "seed"
        return out

    if kind == "number":
        out["type"] = "number"
        for f in ("min", "max", "step"):
            if spec.get(f) is not None:
                out[f] = spec[f]
        out["default"] = _num(val)
        return out

    if kind == "select":
        opts = list(s.get("options") or [])
        if s.get("aspect") and set(opts) == set(ASPECT_VALUES):
            out["type"] = "select"
            out["preset"] = "aspect"
            out["default"] = str(val)
            return out
        if not opts:
            out["type"] = "text"
            out["default"] = "" if val is None else str(val)
            return out
        if str(val) not in opts:
            opts.insert(0, str(val))
        out["type"] = "select"
        out["options"] = opts
        out["default"] = str(val)
        return out

    # 文本
    if kind == "prompt" or kind == "negative":
        out["type"] = "textarea"
        out["rows"] = 6 if kind == "prompt" else 2
        out["default"] = "" if val is None else str(val)
        out["placeholder"] = "只写画面里有什么：主体、材质、光位、景别…" if kind == "prompt" else "不想要什么…"
        return out
    out["type"] = "text"
    out["default"] = "" if val is None else str(val)
    return out


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return ""
    return int(f) if f == int(f) else f


def summarize(graph: dict) -> dict:
    """给前端一个「这工作流会出什么」的粗略判断。"""
    classes = {v.get("class_type") for v in graph.values() if isinstance(v, dict)}
    return {
        "kind": "video" if classes & VIDEO_OUT else "image",
        "save": any(_saves(str(c or "")) for c in classes),
    }


def now_text() -> str:
    return time.strftime("%Y-%m-%d %H:%M")
