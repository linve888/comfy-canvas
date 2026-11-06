#!/usr/bin/env python3
"""全模板的「媒体槽怎么喂」体检。

导出过的模板里，媒体入口有两套完全不同的节点，喂法不能混：

  LoadVideo / LoadAudio / VHS_LoadVideo  →  file 是从 input 目录现列的 COMBO，
                                             必须先把文件放进去，再给「文件名」；
  VHS_LoadVideoPath / VHS_LoadAudio      →  吃绝对路径，直接给路径，省一次拷贝。

喂错的表现不是「参数不对」，而是 ComfyUI 的 validate_inputs 打回
`Custom validation failed: Invalid video file: C:/...`，整单 400 且指不到槽位。
这个脚本把每条媒体槽的落点和喂法列出来，并对几种典型节点做硬断言。

用法：python canvas/tools/slottest.py
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]           # canvas/
sys.path.insert(0, str(ROOT / "server"))

import app  # noqa: E402
import comfy  # noqa: E402

# 已知节点的期望喂法：True = 先上传给文件名，False = 直接给绝对路径
# 注意 VHS_LoadAudio 只有一个 audio_file STRING（VHS_LoadVideo 才有 combo），
# 名字里带 Load 不等于要上传 —— 判据是输入类型，不是类名
EXPECT = {
    "LoadImage": True,
    "LoadVideo": True,
    "LoadAudio": True,
    "VHS_LoadVideo": True,
    "VHS_LoadAudio": False,
    "VHS_LoadVideoPath": False,
}

rows = []
bad = []
seen = set()

for f in sorted(app.TEMPLATES.glob("*.json")):
    if f.stem.endswith(".meta"):
        continue
    try:
        graph = comfy.load_template(f)
    except Exception:
        continue
    if not isinstance(graph, dict) or not any(
        isinstance(v, dict) and "class_type" in v for v in graph.values()
    ):
        continue

    meta = app.template_meta(f.stem)
    landings = app.slot_landings(graph)
    for slot in comfy.collect_slots(graph):
        if slot == "prefix":
            continue
        kind = app.slot_media_kind(slot, landings, meta)
        if kind == "param":
            continue
        land = landings.get(slot) or []
        if not land:
            bad.append(f"{f.stem}.{slot}：没有落点")
            continue
        cls, key = land[0]
        upload = any(app.input_dir_loader(c, k) for c, k in land)
        seen.add(cls)
        rows.append((f.stem, slot, kind, cls, key, "上传→文件名" if upload else "绝对路径"))
        if cls in EXPECT and EXPECT[cls] != upload:
            bad.append(f"{f.stem}.{slot}：{cls}.{key} 判成{'上传' if upload else '绝对路径'}，应相反")

print(f"{'模板':38s} {'槽':10s} {'类型':6s} {'落点':24s} 喂法")
print("-" * 96)
for r in rows:
    print(f"{r[0][:38]:38s} {r[1]:10s} {r[2]:6s} {(r[3] + '.' + r[4])[:24]:24s} {r[5]}")

print()
for cls in sorted(seen):
    if cls not in EXPECT:
        print(f"! 没见过的媒体加载节点：{cls}（默认按类名猜，建议补进 EXPECT）")

if bad:
    print(f"\n{len(bad)} 处有问题：")
    for b in bad:
        print("  ✗", b)
    sys.exit(1)

print(f"\n{len(rows)} 条媒体槽全部有落点且喂法正确")
