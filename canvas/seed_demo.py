#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
往画布里塞一个演示图：素材 ×2 → 双图模板节点。

用途：验证「连线 → 数据流 → 执行」整条链路，也当新用户的起始画布。

  python canvas/seed_demo.py            # 覆盖当前画布
  python canvas/seed_demo.py --append   # 追加到现有画布
"""

import argparse
import json
import os
import urllib.parse
import urllib.request
from pathlib import Path

SERVER = os.environ.get("CANVAS_URL", "http://127.0.0.1:8770")
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

INPUT = Path(os.environ.get("LOCALAPPDATA", "")) / "Comfy-Desktop" / "ComfyUI-Shared" / "input"


def media_node(nid, path: Path, label: str, pos: dict) -> dict:
    url = "/api/raw?p=" + urllib.parse.quote(str(path))
    kind = "video" if path.suffix.lower() in (".mp4", ".webm") else "image"
    return {
        "id": nid,
        "type": "media",
        "position": pos,
        "data": {
            "kind": kind,
            "url": url,
            "label": label,
            "filename": path.name,
            "assetId": str(path),
            # 作为数据源，outputs 里放自己的资产，下游连过来就能取到
            "outputs": [{"assetId": str(path), "url": url, "kind": kind, "filename": path.name}],
        },
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--append", action="store_true", help="追加到现有画布而不是覆盖")
    args = ap.parse_args()

    scene = INPUT / "02图1_治安所正门_场景母版_s1001.png"
    char = INPUT / "ep01sb" / "char_linye.png"
    if not scene.is_file() or not char.is_file():
        print(f"缺素材：{scene} / {char}")
        return 1

    nodes = [
        media_node("m_scene", scene, "治安所正门（场景）", {"x": 40, "y": 90}),
        media_node("m_char", char, "林野（角色板）", {"x": 40, "y": 330}),
        {
            "id": "t_shoot",
            "type": "template",
            "position": {"x": 400, "y": 150},
            "data": {
                "template": "qwen21_edit_2img",
                "params": {
                    "prompt": (
                        "把 <image2> 中的人物放进 <image1> 的场景里：年轻男性穿黑色立领皮夹克，"
                        "从画面右侧走上门前台阶，全身入镜，高度约占画面三分之二，微微低头；"
                        "<image1> 的建筑结构、门头、左侧那盏冷蓝路灯及其在湿地面上的反光保持完全不变；"
                        "人物脸部保留 <image2> 的五官特征，身上带来自左侧路灯的侧光，光影方向与环境一致；"
                        "写实电影摄影质感"
                    ),
                    "negative": "低质量 模糊 变形 水印 动漫 卡通 多余人物 文字乱码",
                    "width": 752,
                    "height": 1344,
                    "resolution": 1024,
                },
                "status": "idle",
                "outputs": [],
                "error": "",
            },
        },
    ]
    edges = [
        {"id": "e1", "source": "m_scene", "sourceHandle": "out", "target": "t_shoot",
         "targetHandle": "in:scene_image", "animated": True},
        {"id": "e2", "source": "m_char", "sourceHandle": "out", "target": "t_shoot",
         "targetHandle": "in:char_image", "animated": True},
    ]

    if args.append:
        cur = json.loads(OPENER.open(f"{SERVER}/api/graph", timeout=10).read())
        nodes = (cur.get("nodes") or []) + nodes
        edges = (cur.get("edges") or []) + edges

    body = json.dumps({"nodes": nodes, "edges": edges,
                       "viewport": {"x": 0, "y": 0, "zoom": 0.85}}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(f"{SERVER}/api/graph", data=body, method="PUT",
                                 headers={"Content-Type": "application/json"})
    r = json.loads(OPENER.open(req, timeout=20).read())
    print("已写入画布：", r)
    for n in nodes:
        print(f"  {n['id']:10s} {n['type']:9s} @ {n['position']}")
    for e in edges:
        print(f"  连线 {e['source']} → {e['target']}.{e['targetHandle']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
