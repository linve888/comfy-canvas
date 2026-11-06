import { ToolIcon } from './Icon.jsx'

/** 节点卡片上的工具条：悬停/选中时出现。图标走统一 SVG 集，不混字符。 */
export default function NodeTools({ items }) {
  if (!items?.length) return null
  return (
    <div className="node-tools" onMouseDown={(e) => e.stopPropagation()}>
      {items.map((it) => (
        <button
          key={it.key}
          className={`nt ${it.danger ? 'danger' : ''}`}
          title={it.label}
          onClick={(e) => {
            e.stopPropagation()
            it.onClick()
          }}
        >
          <span className="ico">
            <ToolIcon glyph={it.icon} size={14} />
          </span>
          <span className="tip">{it.label}</span>
        </button>
      ))}
    </div>
  )
}
