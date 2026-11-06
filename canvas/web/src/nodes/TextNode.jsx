import { Handle, Position } from '@xyflow/react'
import { useCanvas } from '../ctx.js'
import { startConnectFromPlus } from '../ui/sideConnect.js'
import Icon from '../ui/Icon.jsx'

/**
 * 文本节点：一段描述，连到图片/视频节点的提示词入口。
 *
 * 短剧里同一段「场景 + 光位 + 景别」要反复用在多个镜头上，
 * 写在文本节点里改一次，下游全跟着变，比散在各节点里抄好。
 *
 * 排版跟生成节点同一套：卡外一行标题，下面一块无边框的深色面板，
 * 字直接写在面板上，底栏只留图标按钮 —— 不再有标题条 + 输入框 + 按钮条三层。
 */
export default function TextNode({ id, data, selected }) {
  const { updateNode, duplicateNode, spawnDownstream } = useCanvas()
  const text = data.text || ''
  const rows = Math.min(12, Math.max(4, Math.ceil(text.length / 26) + 1))

  return (
    <div className={`node textnode ${selected ? 'selected' : ''}`}>
      <div className="node-cap">
        <span className="cap-ico">
          <Icon name="text" size={12.5} stroke={1.8} />
        </span>
        <span className="cap-name">{data.label || '提示词'}</span>
        <span className="cap-right">
          <span className="cap-state">{text.length} 字</span>
        </span>
      </div>

      <div className="tn-panel">
        <textarea
          className="tn-input nodrag nowheel"
          value={text}
          rows={rows}
          placeholder="写一段画面描述，拖右侧 ＋ 接到提示词口…"
          onChange={(e) => updateNode(id, { text: e.target.value })}
        />
        <div className="tn-bar">
          <button className="gc-ic" title="复制这个节点" onClick={() => duplicateNode(id)}>
            <Icon name="copy" size={13} />
          </button>
          <button
            className="gc-ic"
            title="删除这个节点"
            onClick={() => updateNode(id, { __remove: true })}
          >
            <Icon name="close" size={13} />
          </button>
          <span className="spacer" />
          <span className="tn-hint">拖 ＋ 接提示词口</span>
        </div>
      </div>

      {/* 右侧「＋」：拖出去接提示词口，点一下开一个图片节点并接上这段话 */}
      <div
        className="side-add right nodrag"
        role="button"
        title="拖出线接到提示词口 · 点一下用这段话开个图片节点"
        onMouseDown={(e) => startConnectFromPlus(e.currentTarget, e.nativeEvent)}
        onClick={(e) => {
          e.stopPropagation()
          spawnDownstream?.(id)
        }}
      >
        <Handle type="source" position={Position.Right} id="out" />
        ＋
      </div>
    </div>
  )
}
