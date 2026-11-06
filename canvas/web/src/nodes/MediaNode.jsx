import { useState } from 'react'
import { Handle, Position } from '@xyflow/react'
import { useCanvas, outputsOf } from '../ctx.js'
import NodeTools from '../ui/NodeTools.jsx'
import { startConnectFromPlus } from '../ui/sideConnect.js'

/**
 * 素材节点：画布上的一个已有图片/视频，作为数据源。
 * 产物优先从版本历史里取（同一节点可以留着几版，下游取选中的那张）。
 */
export default function MediaNode({ id, data, selected }) {
  const { updateNode, spawnVideoFrom, duplicateNode, openViewer, openSplit } = useCanvas()
  const outs = outputsOf({ data })
  const out = outs[data.activeOut || 0] || outs[0] || { url: data.url, kind: data.kind, filename: data.filename }
  const kind = data.kind || out.kind || 'image'
  // 右上角报尺寸：短线项目里判断能不能直接当首帧用，看的就是这个
  const [dims, setDims] = useState('')

  const tools = [
    { key: 'view', icon: '⤢', label: '全屏查看', onClick: () => openViewer(outs.length ? outs : [out], data.activeOut || 0) },
    { key: 'dl', icon: '↓', label: '下载', onClick: () => window.open(out.url, '_blank') },
    kind === 'image' && { key: 'split', icon: '⧉', label: '宫格切分', onClick: () => openSplit(id) },
    kind === 'image' && { key: 'video', icon: '▶', label: '用这张图生视频', onClick: () => spawnVideoFrom(id) },
    { key: 'dup', icon: '⧫', label: '复制节点', onClick: () => duplicateNode(id) },
    { key: 'del', icon: '✕', label: '删除', danger: true, onClick: () => updateNode(id, { __remove: true }) },
  ].filter(Boolean)

  return (
    <div className={`node media-node ${selected ? 'selected' : ''}`} style={{ width: 232 }}>
      <div className="node-cap">
        <span className={`kind-dot k-${kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : 'image'}`} />
        <span className="cap-name">{data.label || data.filename || '素材'}</span>
        {dims && <span className="cap-state">{dims}</span>}
      </div>

      <div className="shell">
        <div className="bd" style={{ padding: 0 }}>
          {/* 单击不再放大看图：鼠标在图上就是拖动节点，全屏靠双击或工具条上的按钮 */}
          <div
            className="preview"
            title="拖动可移动节点 · 双击全屏查看"
            onDoubleClick={(e) => {
              e.stopPropagation()
              openViewer(outs.length ? outs : [out], data.activeOut || 0)
            }}
          >
            {kind === 'video' ? (
              <video
                src={out.url}
                controls
                preload="metadata"
                onLoadedMetadata={(e) =>
                  setDims(`${e.currentTarget.videoWidth} × ${e.currentTarget.videoHeight}`)
                }
              />
            ) : kind === 'audio' ? (
              <audio src={out.url} controls style={{ width: '100%' }} />
            ) : (
              <img
                src={out.url}
                alt={data.filename || ''}
                draggable={false}
                onLoad={(e) => setDims(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)}
              />
            )}
          </div>
        </div>
      </div>

      {/* 动作按钮浮在卡片上方，不压在图上 */}
      <NodeTools items={tools} />

      {/* 右侧「＋」：拖出去拉线，点一下派生（图片 → 生视频） */}
      <div
        className="side-add right nodrag"
        role="button"
        title={kind === 'image' ? '拖出线接下游 · 点一下用这张图生视频' : '拖出线接下游'}
        onMouseDown={(e) => startConnectFromPlus(e.currentTarget, e.nativeEvent)}
        onClick={(e) => {
          e.stopPropagation()
          if (kind === 'image') spawnVideoFrom(id)
        }}
      >
        <Handle type="source" position={Position.Right} id="out" />
        ＋
      </div>
    </div>
  )
}
