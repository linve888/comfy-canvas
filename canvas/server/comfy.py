#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ComfyUI 对接层（零依赖，仅标准库）。

从 batch-render/batch_render.py 抽取而来，把已经踩过的坑固化在这里：
  1. 本机 ComfyUI 必须绕过系统代理直连（环境里有 http_proxy 指向本地代理）
  2. /upload/image 的 multipart 字段必须放在文件 part 之前（0.43 的 aiohttp 会 500）
  3. /prompt 的校验错误原文必须透传，不要归一化
  4. 模板永远深拷贝后再填槽位，防止改一次污染全线

画布后端和批量脚本共用这一层。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

COMFY = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")

# 本机 ComfyUI 一律直连
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

# 参考图搜索路径：画布资产 → 批量脚本 refs → ComfyUI input
_SEARCH_BASES = [
    Path(__file__).resolve().parent.parent / "assets",
    Path(__file__).resolve().parent.parent.parent / "batch-render" / "refs",
    Path(os.environ.get("LOCALAPPDATA", "")) / "Comfy-Desktop/ComfyUI-Shared/input",
]


class ComfyError(RuntimeError):
    pass


def http_json(path: str, payload: dict | None = None, timeout: int = 30):
    url = COMFY + path
    data, headers = None, {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        with _OPENER.open(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # 校验错误原文对定位极有用，原样带出
        body = e.read().decode("utf-8", errors="replace")
        raise ComfyError(f"{e.code} {path}: {body[:1200]}") from None
    except urllib.error.URLError as e:
        raise ComfyError(f"连不上 ComfyUI（{COMFY}）：{e.reason}") from None


def download(view_params: dict, dest: Path, timeout: int = 120) -> Path:
    """从 /view 拉产物到本地。

    按 Content-Length 收够就停：ComfyUI 有时不主动关连接，
    只靠 read() 返回空来结束会一直挂到超时（曾导致任务卡在「生成中」八分钟）。
    """
    qs = urllib.parse.urlencode({
        "filename": view_params["filename"],
        "subfolder": view_params.get("subfolder", ""),
        "type": view_params.get("type", "output"),
    })
    dest.parent.mkdir(parents=True, exist_ok=True)
    expect = None
    got = 0
    with _OPENER.open(f"{COMFY}/view?{qs}", timeout=timeout) as r:
        cl = r.headers.get("Content-Length")
        if cl and cl.isdigit():
            expect = int(cl)
        with open(dest, "wb") as f:
            while True:
                chunk = r.read(1 << 16)
                if not chunk:
                    break
                f.write(chunk)
                got += len(chunk)
                if expect is not None and got >= expect:
                    break
    if expect is not None and got < expect:
        raise ComfyError(f"下载不完整：{dest.name} 期望 {expect} 实收 {got}")
    return dest


def upload_image(src: Path, subfolder: str = "canvas") -> str:
    """上传素材到 ComfyUI input，返回加载节点要填的 'subfolder/name'。

    字段顺序是硬约束：文本字段在前、文件 part 在最后。

    subfolder 传空串 = 放到 input 根目录。原生 LoadVideo / LoadAudio 的
    file / audio 是「input 目录里现列的 COMBO」，只列根目录的文件，
    放到子目录里它看不见 —— 所以视频和音频走根目录，图片仍旧放 canvas/。
    """
    src = Path(src)
    raw = src.read_bytes()
    boundary = "wbcanvas" + hashlib.md5(f"{time.time()}{len(raw)}".encode()).hexdigest()[:16]
    ext = src.suffix.lower() or ".png"
    safe_name = "canvas_" + hashlib.md5(raw).hexdigest()[:10] + ext

    parts = []
    fields = [("overwrite", "true"), ("type", "input")]
    if subfolder:
        fields.append(("subfolder", subfolder))
    for field, value in fields:
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"\r\n\r\n{value}\r\n'.encode()
        )
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{safe_name}"\r\n'
        f"Content-Type: application/octet-stream\r\n\r\n".encode()
    )
    parts.append(raw)
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    body = b"".join(parts)

    req = urllib.request.Request(
        COMFY + "/upload/image",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    try:
        with _OPENER.open(req, timeout=120) as r:
            resp = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body_txt = e.read().decode("utf-8", errors="replace")
        raise ComfyError(f"上传失败 {e.code}：{body_txt[:400]}") from None
    sub, name = resp.get("subfolder", ""), resp.get("name", safe_name)
    return f"{sub}/{name}" if sub else name


def resolve_image(value: str) -> Path:
    """把画布上的素材引用（图片/视频/音频）解析成本地文件路径。

    接受：绝对路径 / 相对 assets / 相对 batch-render refs / 相对 ComfyUI input
    """
    if not value:
        raise FileNotFoundError("素材引用为空")
    p = Path(value)
    if p.is_absolute() and p.is_file():
        return p
    for base in _SEARCH_BASES:
        cand = base / value
        if cand.is_file():
            return cand
    raise FileNotFoundError(f"素材找不到：{value}")


# ---------------------------------------------------------------- 模板

SLOT_RE = re.compile(r"^\{\{\s*([A-Za-z0-9_]+)\s*\}\}$")


def collect_slots(node) -> list[str]:
    """扫描模板里所有 {{slot}}，返回去重后的顺序列表。"""
    found: list[str] = []

    def walk(x):
        if isinstance(x, dict):
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
        elif isinstance(x, str):
            m = SLOT_RE.match(x)
            if m and m.group(1) not in found:
                found.append(m.group(1))

    walk(node)
    return found


def fill_slots(node, ctx: dict):
    """深拷贝式填充：返回新对象，模板本体不动。"""
    if isinstance(node, dict):
        return {k: fill_slots(v, ctx) for k, v in node.items()}
    if isinstance(node, list):
        return [fill_slots(v, ctx) for v in node]
    if isinstance(node, str):
        m = SLOT_RE.match(node)
        if m:
            key = m.group(1)
            if key not in ctx:
                raise KeyError(f"模板需要槽位 {{{{{key}}}}}，但没有提供")
            return ctx[key]
    return node


def load_template(path: Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


# ---------------------------------------------------------------- 节点表

_OI: dict = {"at": 0.0, "data": None}


def object_info(max_age: float = 600.0, timeout: float = 180.0) -> dict:
    """整张节点定义表（2200+ 节点，几 MB）。

    工作流导入要逐项查输入类型，每次现拉太慢；ComfyUI 装插件才变，缓存十分钟够。
    timeout 给编译期的辅助校验用：那里只是顺手查一眼，ComfyUI 没起来时不该一起久等。
    """
    if _OI["data"] is not None and time.time() - _OI["at"] < max_age:
        return _OI["data"]
    d = http_json("/object_info", timeout=timeout)
    _OI.update(at=time.time(), data=d)
    return d


# ---------------------------------------------------------------- 队列

def submit(graph: dict, client_id: str = "canvas") -> str:
    resp = http_json("/prompt", {"prompt": graph, "client_id": client_id}, timeout=60)
    pid = resp.get("prompt_id")
    if not pid:
        raise ComfyError(f"ComfyUI 未返回 prompt_id：{json.dumps(resp)[:400]}")
    return pid


def queue_state() -> dict:
    try:
        q = http_json("/queue", timeout=10)
        return {"running": len(q.get("queue_running", [])), "pending": len(q.get("queue_pending", []))}
    except ComfyError:
        return {"running": 0, "pending": 0}


def system_stats() -> dict:
    try:
        s = http_json("/system_stats", timeout=10)
        sysinfo = s.get("system", {})
        dev = (s.get("devices") or [{}])[0]
        return {
            "online": True,
            "version": sysinfo.get("comfyui_version", ""),
            "vram_total": dev.get("vram_total", 0),
            "vram_free": dev.get("vram_free", 0),
            "device": dev.get("name", ""),
        }
    except ComfyError:
        return {"online": False}


def history(pid: str) -> dict | None:
    """返回该次执行的历史记录；未完成返回 None。"""
    for item in (http_json(f"/history/{pid}", timeout=20) or {}).values():
        return item
    return None


def extract_outputs(item: dict) -> list[dict]:
    """从 history item 里取所有产物文件描述。"""
    files = []
    for node_out in (item.get("outputs") or {}).values():
        for key in ("images", "gifs", "videos", "audio"):
            for f in node_out.get(key) or []:
                if f.get("filename"):
                    files.append(f)
    return files


def status_of(item: dict) -> tuple[str, str]:
    """返回 (status, message)。status ∈ done / error / running"""
    st = item.get("status") or {}
    if st.get("status_str") == "error":
        msgs = st.get("messages") or []
        detail = json.dumps(msgs, ensure_ascii=False)[:1500] if msgs else "执行出错（无详情）"
        return "error", detail
    if st.get("completed"):
        return "done", ""
    return "running", ""
