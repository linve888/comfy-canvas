/**
 * 整链运行的执行计划预览。
 *
 * 为什么要先看一眼再跑：一条链动辄十几分钟 GPU，
 * 而不该跑的上游如果被重跑一遍，纯是白等。所以把「跑哪几个、跳过哪几个」摆出来。
 */
export default function ChainPlan({ plan, nodes, templates, onCancel, onStart, running }) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const info = (id) => {
    const n = byId.get(id)
    const tpl = templates.find((t) => t.name === n?.data?.template)
    return {
      label: tpl?.label || n?.data?.label || n?.data?.template || id,
      kind: tpl?.kind || (n?.type === 'videogen' ? 'video' : 'image'),
    }
  }
  const order = plan?.order || []
  const skipped = plan?.skipped || []

  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal chain-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-hd">
          <b>运行整链</b>
          <span className="muted">
            {order.length} 个按顺序跑
            {skipped.length ? ` · ${skipped.length} 个已有产物，跳过` : ''}
          </span>
        </div>

        <div className="chain-body">
          {plan?.reason ? <div className="err-box">{plan.reason}</div> : null}

          <ol className="chain-list">
            {order.map((id, i) => {
              const it = info(id)
              return (
                <li key={id}>
                  <span className="chain-no">{i + 1}</span>
                  <span className={`chain-kind k-${it.kind}`}>{it.kind === 'video' ? '视频' : '图片'}</span>
                  <span className="chain-name">{it.label}</span>
                </li>
              )
            })}
            {!order.length && <li className="chain-empty">这条链上没有要跑的节点</li>}
          </ol>

          {skipped.length > 0 && (
            <div className="chain-skip">
              跳过（已有产物，参数没改）：
              {skipped.map((id) => info(id).label).join('、')}
            </div>
          )}

          <div className="hint dim">
            每个节点按顺序跑完才提交下一个 —— 下游要拿上游这次产出的图，提前提交会拿到旧图。
          </div>
        </div>

        <div className="modal-ft">
          <button onClick={onCancel} disabled={running}>
            取消
          </button>
          <button className="primary" onClick={onStart} disabled={running || !order.length || !!plan?.stuck?.length}>
            {running ? '正在跑…' : `开始跑 ${order.length} 个`}
          </button>
        </div>
      </div>
    </div>
  )
}
