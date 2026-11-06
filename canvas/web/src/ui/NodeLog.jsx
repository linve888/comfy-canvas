import { DEBUG, fmtAt, fmtFields, useNodeLog } from '../log.js'

/**
 * 节点调试条：只在 ?log=1 时出现。
 *
 * 读的是前端本地缓冲 —— 不额外发请求，跑一次就在这儿能看见
 * 「点了没有 / 参数是什么 / 后端收没收 / 错在哪」。
 * 完整时间线（含后端任务生命周期）在 canvas/projects/runtime.log。
 */
export default function NodeLog({ nodeId, limit = 8 }) {
  const lines = useNodeLog(nodeId, limit)
  if (!DEBUG) return null
  return (
    <div className="nodelog nodrag nowheel">
      <div className="nodelog-hd">
        <span>运行日志</span>
        <span className="nodelog-tip">{lines.length ? `最近 ${lines.length} 条` : '还没有记录'}</span>
      </div>
      {lines.length ? (
        lines.map((e) => (
          <div key={e.seq} className={`nl-row nl-${e.lvl.toLowerCase()}`}>
            <span className="nl-t">{fmtAt(e.at)}</span>
            <span className="nl-ev">{e.ev}</span>
            <span className="nl-f" title={fmtFields(e)}>
              {fmtFields(e)}
            </span>
          </div>
        ))
      ) : (
        <div className="nl-row nl-empty">跑一次生成就出现在这里 · 由 ?log=1 打开</div>
      )}
    </div>
  )
}
