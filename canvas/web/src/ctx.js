import { createContext, useContext } from 'react'

export const CanvasCtx = createContext(null)
export const useCanvas = () => useContext(CanvasCtx)

// 数值型槽位：渲染成 number 输入
export const NUMERIC_SLOTS = new Set([
  'width', 'height', 'resolution', 'seed', 'duration', 'steps', 'cfg', 'batch',
])

// 这些槽位由后端自动填，不在 UI 暴露
export const HIDDEN_SLOTS = new Set(['prefix'])

// 媒体槽（图片 / 视频 / 音频）都从参数表单里排除，它们只走连线。
// 判据优先用后端给的 mediaSlots —— 后端按「槽位落在哪个节点的哪个输入」算，
// 名字里带 image 的参数（ref_image_size 这种 match/max 枚举）不会被误判。
export const isMediaSlot = (s, tpl) => {
  if (tpl && Array.isArray(tpl.mediaSlots)) return tpl.mediaSlots.includes(s)
  return /image|video|audio/i.test(String(s || ''))
}
export const isImageSlot = isMediaSlot

/** 槽位吃哪类媒体，和后端 slot_media_kind 同一套规则：参数槽回 'param' */
export function slotKindOf(slot, tpl) {
  if (tpl) {
    if ((tpl.imageSlots || []).includes(slot)) return 'image'
    if ((tpl.videoSlots || []).includes(slot)) return 'video'
    if ((tpl.audioSlots || []).includes(slot)) return 'audio'
    if (Array.isArray(tpl.mediaSlots)) return 'param'
  }
  const s = String(slot || '').toLowerCase()
  if (s.includes('video')) return 'video'
  if (s.includes('audio')) return 'audio'
  return 'image'
}

/** 模板里非空的媒体分组，顺序固定：图片 → 视频 → 音频 */
export function mediaGroupsOf(tpl) {
  if (!tpl) return []
  return [
    { key: 'image', label: '图片', short: '图', slots: tpl.imageSlots || [] },
    { key: 'video', label: '视频', short: '视', slots: tpl.videoSlots || [] },
    { key: 'audio', label: '音频', short: '音', slots: tpl.audioSlots || [] },
  ].filter((g) => g.slots.length > 0)
}

/** 某个媒体类型在模板里对应的槽位池 */
export function slotsOfKind(tpl, kind) {
  if (!tpl) return []
  if (kind === 'video') return tpl.videoSlots || []
  if (kind === 'audio') return tpl.audioSlots || []
  return tpl.imageSlots || []
}

// 节点类型的语义类别 → 后端模板的 use 字段
export const USE_OF_KIND = { imagegen: 'imagegen', videogen: 'videogen' }

const NEG_RE = /(不要|不能|不得|禁止|避免|不出现|别让|没有(?!人)|\bno\b|\bwithout\b|\bavoid\b)/i
export const negativeHit = (text) => NEG_RE.exec(text || '')

function fallbackField(slot) {
  if (slot === 'prompt') {
    return { slot, label: '提示词', type: 'textarea', rows: 5, placeholder: '只写画面里有什么：物件、材质、光位、景别…' }
  }
  if (slot === 'negative') {
    return { slot, label: '负向', type: 'textarea', rows: 2, placeholder: '不想要什么…' }
  }
  if (slot === 'seed') return { slot, label: '种子', type: 'seed' }
  if (NUMERIC_SLOTS.has(slot)) return { slot, label: slot, type: 'number' }
  return { slot, label: slot, type: 'text' }
}

// 字段：优先用模板 meta 的声明（顺序、中文名、选项都在里面），没声明就按槽位名兜底
export function fieldsOf(tpl) {
  if (!tpl) return []
  // 负向框只在模板真的吃负向时才出现：cfg=1 的模型填了也是白填
  const usable = (s) =>
    !HIDDEN_SLOTS.has(s) &&
    !isMediaSlot(s, tpl) &&
    !(s === 'negative' && tpl.supportsNegative !== true)
  const slots = (tpl.slots || []).filter(usable)
  const declared = tpl.fields && tpl.fields.length ? tpl.fields.filter((f) => usable(f.slot)) : null
  if (!declared || !declared.length) return slots.map(fallbackField)
  const known = new Set(declared.map((f) => f.slot))
  return [...declared, ...slots.filter((s) => !known.has(s)).map(fallbackField)]
}

// 切换模板时重建参数：meta 的 default 优先，其余留空（seed 留空 = 随机）
export function defaultParams(tpl) {
  const p = {}
  for (const f of fieldsOf(tpl)) {
    p[f.slot] = f.default ?? ''
  }
  return p
}

// 节点的有效产物：优先当前选中的版本
export function outputsOf(node) {
  const d = node?.data || {}
  const h = d.history || []
  const v = h[d.activeVersion || 0]
  if (v?.outputs?.length) return v.outputs
  return d.outputs || []
}

// 下游取哪一张：节点上点选的那张，默认第一张
export function pickOutput(node) {
  const outs = outputsOf(node)
  return outs[node?.data?.activeOut || 0] || outs[0] || null
}

export function labelOfSlot(tpl, slot) {
  return tpl?.slotLabels?.[slot] || slot
}

/** `16:9` / `16:9 (Widescreen)` / `9:16竖` → 同一个比例数值 */
export function ratioKeyOf(v) {
  const m = String(v ?? '').match(/(\d+(?:\.\d+)?)\s*[:：]\s*(\d+(?:\.\d+)?)/)
  if (!m) return null
  const a = Number(m[1])
  const b = Number(m[2])
  if (!a || !b) return null
  return Math.round((a / b) * 10000) / 10000
}

/** 某个 select 字段里，和 value 等价的那一项（比例相同即等价） */
export function matchOption(field, value) {
  const opts = field?.options || []
  const vals = opts.map((o) => (typeof o === 'string' ? o : o.value))
  if (!vals.length) return undefined
  if (vals.some((v) => String(v) === String(value))) {
    return vals.find((v) => String(v) === String(value))
  }
  const want = ratioKeyOf(value)
  if (want == null) return undefined
  const hit = vals.filter((v) => ratioKeyOf(v) === want)
  return hit.length === 1 ? hit[0] : undefined
}

/**
 * 把一个参数值翻译成「目标模板认得的值」。
 *
 * 场景：节点原本跑 Krea2，比例是 `16:9`；点九宫格时模板换成 Qwen 多图编辑，
 * 那个模板的 ResolutionSelector 只认 `16:9 (Widescreen)`。原样搬过去就是
 * value_not_in_list，整单 400。这里按目标模板自己的字段定义收一次：
 * 值不在选项里就找同比例的那一项，再找不到退回默认值。
 *
 * 返回 undefined 表示目标模板没有这个参数，调用方不要硬塞。
 */
export function coerceParam(tpl, slot, value) {
  const f = fieldsOf(tpl).find((x) => x.slot === slot)
  if (!f) return undefined
  const empty = value === undefined || value === null || value === ''
  if (empty) return f.default ?? ''
  if (f.type === 'select') {
    if (!(f.options || []).length) return value
    const hit = matchOption(f, value)
    return hit !== undefined ? hit : f.default ?? ''
  }
  if (f.type === 'number') {
    const n = Number(value)
    if (!Number.isFinite(n)) return f.default ?? ''
    const min = Number.isFinite(f.min) ? f.min : -Infinity
    const max = Number.isFinite(f.max) ? f.max : Infinity
    return Math.min(max, Math.max(min, n))
  }
  return value
}

/** 换模板时沿用旧节点的参数：只带目标模板真有的项，值由 coerceParam 收口 */
export function carryParams(tpl, from, slots) {
  const out = {}
  for (const slot of slots) {
    const v = coerceParam(tpl, slot, from?.[slot])
    if (v !== undefined && v !== '') out[slot] = v
  }
  return out
}

/* ------------------------------------------------------------------
 * 图片工具（LibTV 的斜杠命令那套）：都是「拿当前这张图再加工」。
 * 全部走多图编辑模板，图 1 = 当前图；提示词按正向写法给，不写否定句。
 * ------------------------------------------------------------------ */
export const IMAGE_TOOLS = [
  {
    key: 'grid9',
    label: '九宫格多机位',
    hint: '同一场景九个机位，切分后当分镜用',
    prompt:
      '同一场景同一角色的九宫格拼图，3×3 均匀排布，格与格之间留细白线。九格依次是：正面中景、左侧四分之三侧、右侧四分之三侧、俯拍全景、仰拍近景、背面中景、面部特写、过肩镜头、远景。九格里的角色服装、发型、光线方向完全一致，写实电影摄影质感',
  },
  {
    key: 'grid4',
    label: '四宫格推演',
    hint: '四种剧情走向各一格',
    prompt:
      '同一场景的四宫格拼图，2×2 均匀排布，格与格之间留细白线。四格依次是：人物站在门口、人物走进房间、人物停在桌边、人物转身看向镜头。四格中的角色服装与环境光线保持一致，写实电影摄影质感',
  },
  {
    key: 'tris',
    label: '角色三视图',
    hint: '正/侧/背，锁形象用',
    prompt:
      '同一角色的角色设定三视图，正面、侧面、背面三个视角并排站立，全身入画，角色站在纯浅灰背景前，同一套服装、同一发型、同一光照，写实电影质感，均匀布光',
  },
  {
    key: 'angle_left',
    label: '换角度 · 左 45°',
    prompt: '把机位改成左侧四十五度平视，主体保持不变，背景随之改变透视关系，写实电影摄影质感',
  },
  {
    key: 'angle_right',
    label: '换角度 · 右 45°',
    prompt: '把机位改成右侧四十五度平视，主体保持不变，背景随之改变透视关系，写实电影摄影质感',
  },
  {
    key: 'angle_top',
    label: '换角度 · 俯拍',
    prompt: '把机位改成高角度俯拍，主体保持不变，地面与桌面的形状随之展开，写实电影摄影质感',
  },
  {
    key: 'angle_low',
    label: '换角度 · 仰拍',
    prompt: '把机位改成低角度仰拍，主体保持不变，天花板与顶部结构入画，写实电影摄影质感',
  },
]

// 打光预设：方向 + 色温，各一句可执行的光位描述
export const LIGHT_PRESETS = [
  { key: 'top_cold', label: '冷白顶光', text: '把光线改成冷白顶灯直下，硬光，地面与墙面出现清晰投影，画面整体偏冷' },
  { key: 'side_warm', label: '暖黄侧光', text: '把光线改成暖黄侧光从左前方打来，明暗交界清晰，暗部保留细节' },
  { key: 'rim_blue', label: '冷蓝逆光', text: '把光线改成冷蓝色逆光从背后打来，人物与物体边缘出现轮廓光，正面保持可辨的暗部细节' },
  { key: 'window', label: '窗光', text: '把光线改成单侧窗户自然光，柔和的斜射光斑落在墙面与地面，空气中有细微尘埃' },
  { key: 'neon', label: '霓虹夜', text: '把光线改成夜景霓虹，紫红与青蓝两色光从两侧打来，地面湿滑反光，画面暗部保留细节' },
  { key: 'flat', label: '均匀平光', text: '把光线改成均匀柔和的平光，投影很淡，画面整体明亮，细节清晰可辨' },
]

export function lightText(key) {
  return LIGHT_PRESETS.find((l) => l.key === key)?.text || ''
}
