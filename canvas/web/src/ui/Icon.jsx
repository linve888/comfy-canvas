/**
 * 工具条图标：一律手写 SVG，不用 ✥ ▭ ⊞ 这类字符。
 *
 * 为什么：字符图标在不同字体下粗细、基线、留白全不一样，
 * 凑成一条工具条就像把几种字体剪下来拼在一起 —— 那是界面显旧的元凶之一。
 * 这里统一 24 格、1.7 描边、圆头圆角，永远跟着 currentColor 走。
 */
const PATHS = {
  plus: ['M12 5v14', 'M5 12h14'],
  move: ['M12 3v18', 'M3 12h18', 'M9 6l3-3 3 3', 'M9 18l3 3 3-3', 'M6 9l-3 3 3 3', 'M18 9l3 3-3 3'],
  select: ['M5 3l13.5 6.2-5.6 1.9-1.9 5.6z', 'M13 13l5 5'],
  images: ['M3 5.5h18v13H3z', 'M3 15l5-4.6 4.4 4.1 3-2.8 5.6 4.3', 'M8.4 9.2h.01'],
  grid: [
    'M4.5 4.5h6v6h-6z',
    'M13.5 4.5h6v6h-6z',
    'M4.5 13.5h6v6h-6z',
    'M13.5 13.5h6v6h-6z',
  ],
  list: ['M4 7h16', 'M4 12h16', 'M4 17h10'],
  keyboard: [
    'M3 7.5h18v9H3z',
    'M7 11h.01',
    'M11 11h.01',
    'M15 11h.01',
    'M8 14h8',
  ],
  compact: ['M8 9.5l4-4 4 4', 'M8 14.5l4 4 4-4'],
  arrange: ['M4 4.5h6v6H4z', 'M14 4.5h6v6h-6z', 'M9 19.5h6', 'M7 10.5v5h10v-5'],
  map: ['M3.5 4.5h17v15h-17z', 'M8 9.5h8v5H8z'],
  wire: ['M6.5 8.5a3.5 3.5 0 1 0 0 7', 'M17.5 8.5a3.5 3.5 0 1 1 0 7', 'M7 12h10'],
  snap: ['M6 6h.01', 'M12 6h.01', 'M18 6h.01', 'M6 12h.01', 'M12 12h.01', 'M18 12h.01', 'M6 18h.01', 'M12 18h.01', 'M18 18h.01'],
  image: ['M3.5 5.5h17v13h-17z', 'M3.5 15l5-4.6 4.4 4.1 3-2.8 5.1 4.3', 'M8.6 9.2h.01'],
  play: ['M9 7.5l8 4.5-8 4.5z'],
  text: ['M5 6.5h14', 'M12 6.5v11'],
  template: ['M4 4.5h7v7H4z', 'M13 4.5h7v7h-7z', 'M4 13.5h16v6H4z'],
  copy: [
    'M9 9.5A1.5 1.5 0 0 1 10.5 8h7A1.5 1.5 0 0 1 19 9.5v7A1.5 1.5 0 0 1 17.5 18h-7A1.5 1.5 0 0 1 9 16.5z',
    'M15 8V6.5A1.5 1.5 0 0 0 13.5 5h-7A1.5 1.5 0 0 0 5 6.5v7A1.5 1.5 0 0 0 6.5 15H8',
  ],
  split: ['M4 4.5h16v15H4z', 'M12 4.5v15', 'M4 12h16'],
  expand: ['M14 4.5h5.5V10', 'M19.5 4.5l-8 8', 'M10 19.5H4.5V14', 'M4.5 19.5l8-8'],
  download: ['M12 4v11', 'M7.5 11L12 15.5 16.5 11', 'M5 20h14'],
  upload: ['M12 20V9', 'M7.5 13.5L12 9l4.5 4.5', 'M5 4.5h14'],
  sun: [
    'M12 8.3a3.7 3.7 0 1 0 0 7.4 3.7 3.7 0 0 0 0-7.4z',
    'M12 3v1.8',
    'M12 19.2V21',
    'M3 12h1.8',
    'M19.2 12H21',
    'M5.6 5.6l1.3 1.3',
    'M17.1 17.1l1.3 1.3',
    'M18.4 5.6l-1.3 1.3',
    'M6.9 17.1l-1.3 1.3',
  ],
  spark: [
    'M11 3l1.5 4.2L16.7 8.7l-4.2 1.5L11 14.4 9.5 10.2 5.3 8.7l4.2-1.5z',
    'M17.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z',
  ],
  close: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
  clock: ['M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17z', 'M12 7.6V12l3 1.8'],
  edit: ['M4.5 19.5h3.6L19 8.6l-3.6-3.6L4.5 15.9z', 'M14.4 6.4l3.6 3.6'],
  'chev-up': ['M6 14.5l6-6 6 6'],
  'chev-down': ['M6 9.5l6 6 6-6'],
  // 参数抽屉：三条滑轨 + 滑块（比「齿轮」更像调参，也比齿轮细节少、缩到 14px 不糊）
  sliders: ['M4 7.5h4', 'M13 7.5h7', 'M4 16.5h7', 'M16 16.5h4', 'M10.5 7.5a2 2 0 1 0 4 0 2 2 0 0 0-4 0', 'M13.5 16.5a2 2 0 1 0 4 0 2 2 0 0 0-4 0'],
  refresh: ['M19.5 12a7.5 7.5 0 1 1-2.3-5.4', 'M19.5 4.5V9H15'],
  link: ['M9.5 14.5l5-5', 'M8.2 10.6 6 12.8a3.3 3.3 0 0 0 4.6 4.6l2.2-2.2', 'M15.8 13.4l2.2-2.2a3.3 3.3 0 0 0-4.6-4.6l-2.2 2.2'],
  info: ['M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17z', 'M12 11.2v5', 'M12 7.9h.01'],
  check: ['M5 12.6l4.6 4.6L19 7.8'],
}

/** 老数据里存的是字符图标，这里给它们一个对应的 SVG，别让两种图标混在一屏 */
const GLYPH = {
  '▣': 'image',
  '▶': 'play',
  T: 'text',
  '◇': 'template',
  '⧉': 'split',
  '⧫': 'copy',
  '⤢': 'expand',
  '＋': 'plus',
  '✦': 'spark',
  '☀': 'sun',
  '⇪': 'upload',
  '⌘': 'keyboard',
  '↓': 'download',
  '✕': 'close',
}

export function ToolIcon({ glyph, size = 15, ...rest }) {
  const name = GLYPH[glyph]
  if (!name) return <span>{glyph}</span>
  return <Icon name={name} size={size} {...rest} />
}

export default function Icon({ name, size = 16, stroke = 1.7, className = '' }) {
  const d = PATHS[name]
  if (!d) return null
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block' }}
    >
      {d.map((p, i) => (
        <path key={i} d={p} />
      ))}
    </svg>
  )
}
