import { useCallback, useEffect, useMemo, useState } from 'react'

import { downloadEntries, listEntries, moduleMeta, runAction } from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import {
  cancelSchedule,
  checkIntervalSeconds,
  ConfigError,
  currentVersion,
  evaluatePredecessors,
  finishBatch,
  generatePlan,
  formatTimestamp,
  handOffFailureIntervals,
  loadConfigs,
  pageBatches,
  resumeSchedule,
  saveConfigEdits,
  startBatch,
  sweepTimeouts,
  type BatchStatus,
  type ConfigVersion,
  type ScheduleConfig,
} from '@/lib/scheduler'

const meta = moduleMeta('scheduler')
const columns = [
  '配置编号',
  '关联任务',
  '调度表达式',
  '时区设定',
  '前置任务',
  '最大并发数',
  '失败重试策略',
  '超时终止',
]
const configActions: { label: string; enabledWhen: string[] }[] = [
  { label: '提交校验', enabledWhen: ['草稿'] },
  { label: '启用调度', enabledWhen: ['待校验', '已停用'] },
  { label: '停用调度', enabledWhen: ['已启用'] },
]
const statuses = ['草稿', '待校验', '已启用', '已停用']
const PAGE_SIZE = 6
const HORIZON_DAYS = 7

type EditingState = {
  configId: number
  configNo: string
  version: number
  task: string
  expression: string
  timeZone: string
  predecessors: string
  maxConcurrency: string
  retryPolicy: string
  timeoutSeconds: string
}

const batchStatusClass: Record<BatchStatus, string> = {
  排队中: 'badge queued',
  运行中: 'badge running',
  已完成: 'badge done',
  已超时: 'badge failed',
  已失败: 'badge failed',
  阻塞: 'badge blocked',
  已取消: 'badge muted',
}

export default function SchedulerView() {
  const [configs, setConfigs] = useState<ScheduleConfig[]>([])
  const [issuesByConfig, setIssuesByConfig] = useState<Record<number, string[]>>({})
  const [versions, setVersions] = useState<Record<number, ConfigVersion>>({})
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [page, setPage] = useState(1)
  const [notice, setNotice] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [issuesShown, setIssuesShown] = useState<string[]>([])
  const [editing, setEditing] = useState<EditingState | null>(null)
  const [keyword, setKeyword] = useState('')
  const [revision, setRevision] = useState(0)

  const reloadConfigs = useCallback(() => {
    const payload = loadConfigs()
    setConfigs(payload.configs)
    setIssuesByConfig(payload.issuesByConfig)
    const versionMap: Record<number, ConfigVersion> = {}
    for (const config of payload.configs) {
      versionMap[config.id] = currentVersion(config)
    }
    setVersions(versionMap)
    setSelectedId((previous) => {
      if (previous && payload.configs.some((config) => config.id === previous)) {
        return previous
      }
      return payload.configs[0]?.id ?? null
    })
  }, [])

  useEffect(() => {
    reloadConfigs()
  }, [reloadConfigs])

  const selectedConfig = useMemo(
    () => configs.find((config) => config.id === selectedId) ?? null,
    [configs, selectedId],
  )

  const rowsById = useMemo(() => {
    const map = new Map<number, EntryRow>()
    for (const row of listEntries(meta.key).items) {
      map.set(Number(row.id), row)
    }
    return map
  }, [configs, notice])

  // 过滤只作用于配置列表；执行计划页始终只属于当前选中的配置，不混入过滤结果。
  const filteredConfigs = useMemo(() => {
    const text = keyword.trim()
    if (!text) {
      return configs
    }
    return configs.filter((config) => {
      const row = rowsById.get(config.id)
      return (
        config.configNo.includes(text) ||
        config.task.includes(text) ||
        config.expression.includes(text) ||
        String(row?.['关联任务'] ?? '').includes(text)
      )
    })
  }, [configs, keyword, rowsById])

  const planPage = useMemo(() => {
    if (!selectedConfig) {
      return { items: [], total: 0, page: 1, size: PAGE_SIZE, totalPages: 1, currentBatchNo: null }
    }
    return pageBatches(selectedConfig.configNo, page, PAGE_SIZE)
  }, [selectedConfig, page, revision])

  function flash(message: string, kind: 'ok' | 'error' = 'ok') {
    setRevision((value) => value + 1)
    if (kind === 'error') {
      setErrorMessage(message)
      setNotice('')
      return
    }
    setNotice(message)
    setErrorMessage('')
  }

  function openEditor(config: ScheduleConfig) {
    const version = versions[config.id]
    setEditing({
      configId: config.id,
      configNo: config.configNo,
      version: version.version,
      task: config.task,
      expression: config.expression,
      timeZone: config.timeZone,
      predecessors: config.predecessorIds.length === 0 ? '无' : config.predecessorIds.join(','),
      maxConcurrency: String(config.maxConcurrency ?? ''),
      retryPolicy: config.retryPolicy,
      timeoutSeconds: String(config.timeoutSeconds ?? ''),
    })
    setIssuesShown(issuesByConfig[config.id] ?? [])
    flash('编辑窗口已打开，保存时按版本裁决')
  }

  function submitEditor() {
    if (!editing) {
      return
    }
    try {
      const outcome = saveConfigEdits(
        editing.configId,
        {
          task: editing.task,
          expression: editing.expression,
          timeZone: editing.timeZone,
          predecessors: editing.predecessors,
          maxConcurrency: editing.maxConcurrency,
          retryPolicy: editing.retryPolicy,
          timeoutSeconds: editing.timeoutSeconds,
        },
        editing.version,
      )
      if (!outcome.ok) {
        // 另一个编辑窗口已经用更高版本保存：这里必须显示被哪个版本裁决。
        setIssuesShown([outcome.message])
        flash(outcome.message, 'error')
        reloadConfigs()
        return
      }
      setIssuesShown([])
      setEditing({ ...editing, version: outcome.version.version })
      flash(
        `配置已保存为 v${outcome.version.version}；已启动的批次沿用保存前的快照与执行凭据，改动只影响下一批次`,
      )
      reloadConfigs()
    } catch (error) {
      if (error instanceof ConfigError) {
        setIssuesShown(error.issues)
        flash(`保存被拒绝：${error.issues.join('；')}`, 'error')
        return
      }
      flash(error instanceof Error ? error.message : '保存失败', 'error')
    }
  }

  function buildPlan() {
    if (!selectedConfig) {
      return
    }
    try {
      const result = generatePlan({ configId: selectedConfig.id, horizonDays: HORIZON_DAYS })
      setPage(1)
      flash(
        `已生成 ${result.batches.length} 个执行批次（按 ${selectedConfig.timeZone} 时区解释 ${selectedConfig.expression}）`,
      )
    } catch (error) {
      if (error instanceof ConfigError) {
        setIssuesShown(error.issues)
        flash(`无法生成计划：${error.issues.join('；')}`, 'error')
        return
      }
      flash(error instanceof Error ? error.message : '生成计划失败', 'error')
    }
  }

  function cancel(carry: boolean) {
    if (!selectedConfig) {
      return
    }
    const result = cancelSchedule(selectedConfig.configNo, carry)
    setPage(1)
    flash(
      carry
        ? `已取消调度，${result.carried} 个排队批次继续执行并标记为「取消后续跑」`
        : `已取消调度，${result.dropped} 个排队批次一并取消`,
    )
  }

  function resume() {
    if (!selectedConfig) {
      return
    }
    try {
      const result = resumeSchedule(selectedConfig.configNo, { horizonDays: HORIZON_DAYS })
      setPage(1)
      flash(
        `已恢复调度：只从恢复时刻往后排批次，停机期间 ${result.skippedMissed} 个错过批次不补造`,
      )
    } catch (error) {
      flash(error instanceof Error ? error.message : '恢复调度失败', 'error')
    }
  }

  function checkTimeouts() {
    const result = sweepTimeouts()
    flash(
      result.timedOut.length === 0
        ? `检查周期 ${checkIntervalSeconds()} 秒：没有批次超时`
        : `超时 ${result.timedOut.length} 个批次，其余 ${result.queued.length} 个排队批次不受影响`,
    )
  }

  function handOff() {
    const result = handOffFailureIntervals()
    flash(
      result.handedOff === 0
        ? '没有需要交给分析流水线的失败区间'
        : `已把 ${result.handedOff} 个失败区间交给分析流水线：${result.nodeNos.join('、')}`,
    )
  }

  function applyConfigAction(configId: number, action: string) {
    const result = runAction(meta.key, configId, action)
    if (!result.ok) {
      flash(result.message, 'error')
      return
    }
    reloadConfigs()
    flash(result.message)
  }

  function start(configNo: string, batchNo: string) {
    const result = startBatch(configNo, batchNo)
    flash(result.ok ? `批次 ${batchNo} 已启动，执行凭据已冻结` : result.message, result.ok ? 'ok' : 'error')
    reloadConfigs()
  }

  function archive(configNo: string, batchNo: string, status: '已完成' | '已失败') {
    const result = finishBatch(configNo, batchNo, status)
    flash(result.ok ? `批次 ${batchNo} 已标记${status}` : result.message, result.ok ? 'ok' : 'error')
  }

  const selectedIssues = selectedConfig ? issuesByConfig[selectedConfig.id] ?? [] : []
  const visibleIssues = editing ? issuesShown : selectedIssues
  const stats = [
    { label: '调度配置总数', value: configs.length },
    { label: '已启用配置', value: configs.filter((config) => config.status === '已启用').length },
    {
      label: '待校验配置',
      value: configs.filter((config) => config.status === '待校验').length,
    },
  ]

  return (
    <section className="page" data-module="scheduler">
      <header className="page-head">
        <div>
          <h2>调度管理</h2>
          <p className="page-desc">
            按配置里的时区解释调度表达式，生成带执行批次的调度计划；前置任务、最大并发与超时终止都会参与计划。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={buildPlan} disabled={!selectedConfig}>
            生成调度计划
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出调度管理清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <p className="status-legend">
        {statuses.map((status) => (
          <span key={status} className="legend-item">
            {status}：{configs.filter((config) => config.status === status).length}
          </span>
        ))}
      </p>

      <div className="panel">
        <div className="panel-head">
          <h3 className="panel-title">调度配置</h3>
          <label className="filter-item">
            <span>按编号 / 关联任务 / 表达式检索</span>
            <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="检索调度配置" />
          </label>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
              <th>当前状态</th>
              <th>版本</th>
              <th>可执行动作</th>
            </tr>
          </thead>
          <tbody>
            {filteredConfigs.map((config) => {
              const row: EntryRow = rowsById.get(config.id) ?? {
                id: config.id,
                status: config.status,
                pending: false,
                abnormal: false,
              }
              return (
                <tr key={config.id} className={config.id === selectedId ? 'row-selected' : ''}>
                  {columns.map((column) => (
                    <td key={column}>{row[column] ?? '—'}</td>
                  ))}
                  <td>{config.status}</td>
                  <td>
                    v{versions[config.id]?.version ?? 1}
                    {(issuesByConfig[config.id]?.length ?? 0) > 0 && (
                      <span className="badge blocked">待修复</span>
                    )}
                  </td>
                  <td className="row-actions">
                    <button className="link" type="button" onClick={() => openEditor(config)}>
                      编辑
                    </button>
                    <button className="link" type="button" onClick={() => { setSelectedId(config.id); setPage(1) }}>
                      查看计划
                    </button>
                    {configActions.map((action) => (
                      <button
                        key={action.label}
                        className="link"
                        type="button"
                        disabled={!action.enabledWhen.includes(config.status)}
                        onClick={() => applyConfigAction(config.id, action.label)}
                      >
                        {action.label}
                      </button>
                    ))}
                  </td>
                </tr>
              )
            })}
            {filteredConfigs.length === 0 && (
              <tr>
                <td className="empty-state" colSpan={columns.length + 3}>
                  没有匹配的调度配置
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {visibleIssues.length > 0 && (
        <div className="issue-box" role="alert">
          <strong>保存阶段发现的问题</strong>
          <ul>
            {visibleIssues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}

      {editing && (
        <div className="panel editor">
          <h3 className="panel-title">
            编辑配置 · {editing.configNo} · 基于版本 v{editing.version}
            （同时保存时只有最新版本的窗口生效）
          </h3>
          <div className="filter-bar">
            <label className="filter-item">
              <span>关联任务</span>
              <input value={editing.task} onChange={(event) => setEditing({ ...editing, task: event.target.value })} />
            </label>
            <label className="filter-item">
              <span>调度表达式</span>
              <input
                value={editing.expression}
                onChange={(event) => setEditing({ ...editing, expression: event.target.value })}
              />
            </label>
            <label className="filter-item">
              <span>时区设定</span>
              <input
                value={editing.timeZone}
                onChange={(event) => setEditing({ ...editing, timeZone: event.target.value })}
              />
            </label>
            <label className="filter-item">
              <span>前置任务</span>
              <input
                value={editing.predecessors}
                onChange={(event) => setEditing({ ...editing, predecessors: event.target.value })}
              />
            </label>
            <label className="filter-item">
              <span>最大并发数</span>
              <input
                value={editing.maxConcurrency}
                onChange={(event) => setEditing({ ...editing, maxConcurrency: event.target.value })}
              />
            </label>
            <label className="filter-item">
              <span>失败重试策略</span>
              <input
                value={editing.retryPolicy}
                onChange={(event) => setEditing({ ...editing, retryPolicy: event.target.value })}
              />
            </label>
            <label className="filter-item">
              <span>超时终止（秒）</span>
              <input
                value={editing.timeoutSeconds}
                onChange={(event) => setEditing({ ...editing, timeoutSeconds: event.target.value })}
              />
            </label>
          </div>
          <div className="page-actions">
            <button className="btn primary" type="button" onClick={submitEditor}>
              保存（按 v{editing.version} 裁决）
            </button>
            <button
              className="btn ghost"
              type="button"
              onClick={() => {
                setEditing(null)
                setIssuesShown([])
              }}
            >
              关闭编辑窗口
            </button>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <h3 className="panel-title">
            执行批次 · {selectedConfig?.configNo ?? '未选择配置'}
            {selectedConfig && `（${selectedConfig.timeZone}）`}
          </h3>
          <div className="page-actions">
            <button className="btn" type="button" onClick={() => cancel(true)} disabled={!selectedConfig}>
              取消并保留排队批次
            </button>
            <button className="btn" type="button" onClick={() => cancel(false)} disabled={!selectedConfig}>
              取消并一并作废
            </button>
            <button className="btn" type="button" onClick={resume} disabled={!selectedConfig}>
              恢复调度
            </button>
            <button className="btn" type="button" onClick={checkTimeouts}>
              检查超时
            </button>
            <button className="btn" type="button" onClick={handOff}>
              失败区间交给分析流水线
            </button>
          </div>
        </div>

        {selectedConfig && selectedIssues.length > 0 && (
          <p className="error-text">
            该配置存在保存阶段问题，生成计划前需要先修复：
            {selectedIssues.join('；')}
          </p>
        )}

        <table className="data-table">
          <thead>
            <tr>
              <th>执行批次</th>
              <th>触发时间</th>
              <th>状态</th>
              <th>来源</th>
              <th>配置快照</th>
              <th>前置条件</th>
              <th>执行凭据 / 失败区间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {planPage.items.map((batch) => {
              const predecessor = evaluatePredecessors(batch)
              return (
                <tr key={batch.batchNo}>
                  <td>{batch.batchNo}</td>
                  <td>
                    {formatTimestamp(batch.triggerAt, batch.snapshot.timeZone)}
                    <span className="muted-cell">（{batch.snapshot.timeZone}）</span>
                  </td>
                  <td>
                    <span className={batchStatusClass[batch.status]}>{batch.status}</span>
                  </td>
                  <td>{batch.source}</td>
                  <td>
                    {batch.snapshot.expression} · 并发 {batch.snapshot.maxConcurrency} · 超时{' '}
                    {batch.snapshot.timeoutSeconds}s · v{batch.snapshot.version}
                  </td>
                  <td className={predecessor.state === 'blocked' ? 'error-text' : ''}>
                    {predecessor.state === 'ready' ? '就绪' : predecessor.reason}
                  </td>
                  <td>
                    {batch.executionCredential ?? '—'}
                    {batch.failureInterval && (
                      <span className="failure-interval">
                        失败区间 {formatTimestamp(batch.failureInterval.startedAt, batch.snapshot.timeZone)} ~{' '}
                        {formatTimestamp(batch.failureInterval.failedAt, batch.snapshot.timeZone)}
                      </span>
                    )}
                  </td>
                  <td className="row-actions">
                    {(batch.status === '排队中' || batch.status === '阻塞') && (
                      <button className="link" type="button" onClick={() => start(batch.configNo, batch.batchNo)}>
                        启动
                      </button>
                    )}
                    {batch.status === '运行中' && (
                      <>
                        <button className="link" type="button" onClick={() => archive(batch.configNo, batch.batchNo, '已完成')}>
                          完成
                        </button>
                        <button className="link" type="button" onClick={() => archive(batch.configNo, batch.batchNo, '已失败')}>
                          失败
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              )
            })}
            {planPage.items.length === 0 && (
              <tr>
                <td className="empty-state" colSpan={8}>
                  还没有执行批次，先点「生成调度计划」
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <footer className="page-foot">
          <span>
            共 {planPage.total} 个批次，第 {planPage.page}/{planPage.totalPages} 页，当前页执行批次{' '}
            {planPage.currentBatchNo ?? '—'}（只包含 {selectedConfig?.configNo ?? '当前配置'} 的批次）
          </span>
          <span className="pager">
            <button
              className="btn ghost"
              type="button"
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={planPage.page <= 1}
            >
              上一页
            </button>
            <button
              className="btn ghost"
              type="button"
              onClick={() => setPage((current) => Math.min(planPage.totalPages, current + 1))}
              disabled={planPage.page >= planPage.totalPages}
            >
              下一页
            </button>
          </span>
        </footer>
      </div>

      <footer className="page-foot">
        {notice && <span className="notice-text">{notice}</span>}
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
