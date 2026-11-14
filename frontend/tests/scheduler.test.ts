import assert from 'node:assert/strict'
import { before, beforeEach, describe, it } from 'node:test'

import { invalidateRowsCache } from '../src/data/local-store'
import { nextTriggerUtc, parseCron, zonedParts } from '../src/lib/cron'

type SchedulerModule = typeof import('../src/lib/scheduler')

let scheduler: SchedulerModule

before(async () => {
  const storage = new Map<string, string>()
  globalThis.window = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value)
      },
      removeItem: (key: string) => {
        storage.delete(key)
      },
    },
  } as unknown as Window & typeof globalThis
  scheduler = await import('../src/lib/scheduler')
})

function resetStorage(): void {
  window.localStorage.removeItem('interactive-analytics-lab:entries')
  window.localStorage.removeItem('interactive-analytics-lab:scheduler-versions')
  scheduler.resetScheduleBatches()
  invalidateRowsCache()
}

describe('cron 解析与时区解释', () => {
  it('按 Asia/Shanghai 解释跨日触发，落成正确的 UTC 时刻', () => {
    const parsed = parseCron('30 23 * * *')
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    const next = nextTriggerUtc(parsed.spec, 'Asia/Shanghai', Date.UTC(2026, 0, 1, 0, 0))
    assert.ok(next)
    // 上海 2026-01-01 23:30 == UTC 2026-01-01 15:30，跨日靠时区解释
    assert.equal(next.toISOString(), '2026-01-01T15:30:00.000Z')
  })

  it('同一表达式在不同时区得到不同的绝对时刻', () => {
    const parsed = parseCron('0 2 * * *')
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    const after = Date.UTC(2026, 0, 1, 0, 0)
    const shanghai = nextTriggerUtc(parsed.spec, 'Asia/Shanghai', after)
    const newYork = nextTriggerUtc(parsed.spec, 'America/New_York', after)
    assert.ok(shanghai && newYork)
    assert.equal(shanghai.toISOString(), '2026-01-01T18:00:00.000Z')
    assert.equal(newYork.toISOString(), '2026-01-01T07:00:00.000Z')
  })

  it('识别没有未来触发时间的表达式', () => {
    const parsed = parseCron('0 0 30 2 *')
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    assert.equal(nextTriggerUtc(parsed.spec, 'Asia/Shanghai', Date.UTC(2026, 0, 1)), null)
  })

  it('拒绝非法表达式', () => {
    assert.equal(parseCron('').ok, false)
    assert.equal(parseCron('0 2 * *').ok, false)
    assert.equal(parseCron('61 * * * *').ok, false)
  })

  it('夏令时跳过的墙上时间不会被当作触发', () => {
    const parsed = parseCron('30 2 * * *')
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    // 纽约 2026-03-08 02:30 不存在，应落到下一个存在的日期的 02:30。
    const next = nextTriggerUtc(parsed.spec, 'America/New_York', Date.UTC(2026, 2, 8, 5, 0))
    assert.ok(next)
    const parts = zonedParts(next, 'America/New_York')
    assert.equal(parts.hour, 2)
    assert.equal(parts.minute, 30)
    assert.ok(next.getTime() > Date.UTC(2026, 2, 8, 6, 0))
  })
})

describe('配置保存阶段的校验', () => {
  beforeEach(resetStorage)

  it('拒绝无未来触发、并发为零、超时过短并逐条说明', () => {
    window.localStorage.setItem(
      'interactive-analytics-lab:entries',
      JSON.stringify({
        scheduler: [
          {
            id: 9,
            status: '草稿',
            pending: true,
            abnormal: false,
            配置编号: 'SCHE-9',
            关联任务: 'PIPE-0001',
            调度表达式: '0 0 30 2 *',
            时区设定: 'Asia/Shanghai',
            前置任务: '无',
            最大并发数: '0',
            失败重试策略: '不重试',
            超时终止: '30',
          },
        ],
      }),
    )
    invalidateRowsCache()
    scheduler.resetScheduleBatches()
    const { configs, issuesByConfig } = scheduler.loadConfigs()
    const issues = issuesByConfig[configs[0].id]
    assert.ok(issues)
    assert.ok(issues.some((text) => text.includes('没有未来触发时间')))
    assert.ok(issues.some((text) => text.includes('最大并发数为 0')))
    assert.ok(issues.some((text) => text.includes('短于检查周期')))
  })
})

describe('批次计划', () => {
  beforeEach(resetStorage)

  it('按编号排序，并可按页翻页且每页只带当前配置批次', () => {
    const plan = scheduler.generatePlan({ configId: 1, from: Date.UTC(2026, 0, 1), horizonDays: 12 })
    const page1 = scheduler.pageBatches('SCHE-0001', 1, 4)
    const page2 = scheduler.pageBatches('SCHE-0001', 2, 4)
    assert.equal(page1.total, plan.batches.length)
    assert.equal(page1.items.length, 4)
    assert.ok(page1.items.every((batch) => batch.configNo === 'SCHE-0001'))
    assert.ok(page2.items.every((batch) => batch.configNo === 'SCHE-0001'))
    const sorted = [...plan.batches].sort((a, b) => a.batchNo.localeCompare(b.batchNo))
    assert.deepEqual(page1.items.map((batch) => batch.batchNo), sorted.slice(0, 4).map((b) => b.batchNo))
    assert.notEqual(page1.currentBatchNo, page2.currentBatchNo)
  })

  it('批次携带生成时的配置快照，之后改配置不重写正在运行的凭据', () => {
    scheduler.generatePlan({ configId: 1, from: Date.UTC(2026, 0, 1), horizonDays: 2 })
    const page = scheduler.pageBatches('SCHE-0001', 1, 8)
    const first = page.items.find((batch) => batch.status === '排队中')
    assert.ok(first)
    const started = scheduler.startBatch('SCHE-0001', first.batchNo)
    assert.equal(started.ok, true)
    if (!started.ok) return
    assert.ok(started.batch.executionCredential)

    const beforeVersion = scheduler.currentVersion(
      scheduler.loadConfigs().configs.find((item) => item.id === 1)!,
    )
    const modified = scheduler.loadConfigs().configs.find((item) => item.id === 1)!
    modified.maxConcurrency = 3
    const saved = scheduler.saveConfigVersion(modified, [], beforeVersion.version)
    assert.equal(saved.ok, true)

    const after = scheduler.pageBatches('SCHE-0001', 1, 8)
    const running = after.items.find((batch) => batch.batchNo === first.batchNo)
    assert.equal(running?.executionCredential, started.batch.executionCredential)
    assert.equal(running?.snapshot.maxConcurrency, 1)
  })

  it('两个编辑窗口同时保存只有一个生效，另一个显示被哪个版本裁决', () => {
    const config = scheduler.loadConfigs().configs.find((item) => item.id === 1)!
    const baseVersion = scheduler.currentVersion(config).version

    const windowA = { ...config, maxConcurrency: 5 }
    const windowB = { ...config, maxConcurrency: 7 }
    const outcomeA = scheduler.saveConfigVersion(windowA, [], baseVersion)
    const outcomeB = scheduler.saveConfigVersion(windowB, [], baseVersion)

    assert.equal(outcomeA.ok, true)
    assert.equal(outcomeB.ok, false)
    if (outcomeB.ok) return
    assert.equal(outcomeB.rejectedBy.version, baseVersion + 1)
    assert.match(outcomeB.message, /已被版本 v\d+/)
  })

  it('超时只失败自己的批次，下一批仍保持排队', () => {
    scheduler.generatePlan({ configId: 1, from: Date.UTC(2026, 0, 1), horizonDays: 3 })
    const page = scheduler.pageBatches('SCHE-0001', 1, 8)
    const queued = page.items.filter((batch) => batch.status === '排队中')
    assert.ok(queued.length >= 2)
    const started = scheduler.startBatch('SCHE-0001', queued[0].batchNo)
    assert.equal(started.ok, true)
    if (!started.ok) return
    const finishedAt = (started.batch.startedAt ?? 0) + 3600 * 1000
    const swept = scheduler.sweepTimeouts(finishedAt + 1000)
    assert.equal(swept.timedOut.length, 1)
    const after = scheduler.pageBatches('SCHE-0001', 1, 8)
    assert.equal(after.items.filter((batch) => batch.status === '已超时').length, 1)
    assert.ok(after.items.some((batch) => batch.status === '排队中' && batch.batchNo !== queued[0].batchNo))
    assert.ok(after.items.find((batch) => batch.batchNo === queued[0].batchNo)?.failureInterval)
  })

  it('前置任务未完成时保持排队，被停用时转为阻塞并拦住后续节点', () => {
    window.localStorage.setItem(
      'interactive-analytics-lab:entries',
      JSON.stringify({
        scheduler: [
          {
            id: 1,
            status: '已启用',
            pending: false,
            abnormal: false,
            配置编号: 'SCHE-0001',
            关联任务: 'PIPE-0001',
            调度表达式: '0 2 * * *',
            时区设定: 'Asia/Shanghai',
            前置任务: '无',
            最大并发数: 1,
            失败重试策略: '不重试',
            超时终止: 3600,
          },
          {
            id: 2,
            status: '已启用',
            pending: false,
            abnormal: false,
            配置编号: 'SCHE-0002',
            关联任务: 'PIPE-0002',
            调度表达式: '0 3 * * *',
            时区设定: 'Asia/Shanghai',
            前置任务: 'SCHE-0001',
            最大并发数: 1,
            失败重试策略: '不重试',
            超时终止: 3600,
          },
          {
            id: 3,
            status: '已停用',
            pending: false,
            abnormal: false,
            配置编号: 'SCHE-0003',
            关联任务: 'PIPE-0003',
            调度表达式: '0 4 * * *',
            时区设定: 'Asia/Shanghai',
            前置任务: 'SCHE-0002',
            最大并发数: 1,
            失败重试策略: '不重试',
            超时终止: 3600,
          },
        ],
        pipeline: [
          { id: 1, status: '运行中', pending: false, abnormal: false, 节点编号: 'PIPE-0001' },
          { id: 2, status: '待调度', pending: true, abnormal: false, 节点编号: 'PIPE-0002' },
          { id: 3, status: '待调度', pending: true, abnormal: false, 节点编号: 'PIPE-0003' },
        ],
      }),
    )
    invalidateRowsCache()
    scheduler.resetScheduleBatches()
    scheduler.generatePlan({ configId: 2, from: Date.UTC(2026, 0, 1), horizonDays: 2 })
    const page2 = scheduler.pageBatches('SCHE-0002', 1, 8)
    const batch = page2.items[0]
    // 前置配置已启用但还没有完成批次 → 保持排队，不能跳过。
    const startQueued = scheduler.startBatch('SCHE-0002', batch.batchNo)
    assert.equal(startQueued.ok, false)
    assert.match(startQueued.message, /保持排队/)

    // 前置任务被停用 → 显式阻塞。
    const entries = JSON.parse(window.localStorage.getItem('interactive-analytics-lab:entries')!) as Record<
      string,
      Record<string, string | number | boolean>[]
    >
    entries.scheduler.find((row) => row.配置编号 === 'SCHE-0001')!.status = '已停用'
    window.localStorage.setItem('interactive-analytics-lab:entries', JSON.stringify(entries))
    invalidateRowsCache()
    const startBlocked = scheduler.startBatch('SCHE-0002', batch.batchNo)
    assert.equal(startBlocked.ok, false)
    assert.match(startBlocked.message, /转为阻塞/)
    assert.equal(
      scheduler.pageBatches('SCHE-0002', 1, 8).items.find((item) => item.batchNo === batch.batchNo)?.status,
      '阻塞',
    )

    // 下游批次因为上游阻塞而不会启动。
    scheduler.generatePlan({ configId: 3, from: Date.UTC(2026, 0, 1), horizonDays: 2 })
    const downstream = scheduler.pageBatches('SCHE-0003', 1, 8).items[0]
    const downstreamStart = scheduler.startBatch('SCHE-0003', downstream.batchNo)
    assert.equal(downstreamStart.ok, false)
  })

  it('取消后已排队批次可继续但标记来源，恢复调度不补造停机期间批次', () => {
    // 固定启用时刻，便于验证停机区间只计数不补造。
    scheduler.markScheduleEnabled('SCHE-0001', Date.UTC(2026, 0, 1))
    scheduler.generatePlan({ configId: 1, from: Date.UTC(2026, 0, 1), horizonDays: 3 })
    const before = scheduler.pageBatches('SCHE-0001', 1, 8)
    assert.ok(before.items.length > 0)

    const cancel = scheduler.cancelSchedule('SCHE-0001', true)
    assert.equal(cancel.carried, before.items.filter((batch) => batch.status === '排队中').length)
    const carried = scheduler.pageBatches('SCHE-0001', 1, 8)
    assert.ok(
      carried.items
        .filter((batch) => batch.status === '排队中')
        .every((batch) => batch.source === '取消后续跑'),
    )

    const resumeAt = Date.UTC(2026, 0, 3, 12, 0)
    const resumed = scheduler.resumeSchedule('SCHE-0001', { resumeAt })
    // 恢复只从恢复时刻往后排，停机期间的触发不会补造。
    const resumedItems = scheduler.pageBatches('SCHE-0001', 1, 200).items
    assert.ok(resumedItems.every((batch) => batch.triggerAt >= resumeAt))
    assert.ok(resumed.skippedMissed > 0)
  })

  it('保存时按编辑器版本裁决，被裁决的窗口不会覆盖已生效配置', () => {
    const config = scheduler.loadConfigs().configs.find((item) => item.id === 2)!
    const version = scheduler.currentVersion(config).version
    const first = scheduler.saveConfigEdits(
      2,
      { expression: '*/30 9-18 * * 1-5', maxConcurrency: '3' },
      version,
    )
    assert.equal(first.ok, true)
    const stale = scheduler.saveConfigEdits(
      2,
      { expression: '0 0 * * *', maxConcurrency: '9' },
      version,
    )
    assert.equal(stale.ok, false)
    if (stale.ok) return
    assert.equal(stale.rejectedBy.version, version + 1)
    const saved = scheduler.loadConfigs().configs.find((item) => item.id === 2)!
    assert.equal(saved.expression, '*/30 9-18 * * 1-5')
    assert.equal(saved.maxConcurrency, 3)
  })

  it('保存阶段的问题被拒绝且不会写入数据', () => {
    const config = scheduler.loadConfigs().configs.find((item) => item.id === 1)!
    const version = scheduler.currentVersion(config).version
    assert.throws(
      () => scheduler.saveConfigEdits(1, { expression: '0 0 30 2 *' }, version),
      (error: unknown) =>
        error instanceof scheduler.ConfigError &&
        error.issues.some((issue) => issue.includes('没有未来触发时间')),
    )
    const after = scheduler.loadConfigs().configs.find((item) => item.id === 1)!
    assert.equal(after.expression, '0 2 * * *')
    assert.equal(scheduler.currentVersion(after).version, version)
  })

  it('并发上限阻止超额启动，后续批次保持排队', () => {
    scheduler.generatePlan({ configId: 1, from: Date.UTC(2026, 0, 1), horizonDays: 3 })
    const queued = scheduler
      .pageBatches('SCHE-0001', 1, 8)
      .items.filter((batch) => batch.status === '排队中')
    assert.ok(queued.length >= 2)
    assert.equal(scheduler.startBatch('SCHE-0001', queued[0].batchNo).ok, true)
    const second = scheduler.startBatch('SCHE-0001', queued[1].batchNo)
    assert.equal(second.ok, false)
    assert.match(second.message, /最大并发/)
    assert.equal(
      scheduler.pageBatches('SCHE-0001', 1, 8).items.find((b) => b.batchNo === queued[1].batchNo)?.status,
      '排队中',
    )
  })

  it('上游完成后下游批次才就绪，翻页不混入其它配置的批次', () => {
    window.localStorage.setItem(
      'interactive-analytics-lab:entries',
      JSON.stringify({
        scheduler: [
          {
            id: 1,
            status: '已启用',
            pending: false,
            abnormal: false,
            配置编号: 'SCHE-0001',
            关联任务: 'PIPE-0001',
            调度表达式: '0 2 * * *',
            时区设定: 'Asia/Shanghai',
            前置任务: '无',
            最大并发数: 2,
            失败重试策略: '不重试',
            超时终止: 3600,
          },
          {
            id: 2,
            status: '已启用',
            pending: false,
            abnormal: false,
            配置编号: 'SCHE-0002',
            关联任务: 'PIPE-0002',
            调度表达式: '0 3 * * *',
            时区设定: 'Asia/Shanghai',
            前置任务: 'SCHE-0001',
            最大并发数: 1,
            失败重试策略: '不重试',
            超时终止: 3600,
          },
        ],
        pipeline: [
          { id: 1, status: '已完成', pending: false, abnormal: false, 节点编号: 'PIPE-0001' },
          { id: 2, status: '待调度', pending: true, abnormal: false, 节点编号: 'PIPE-0002' },
        ],
      }),
    )
    invalidateRowsCache()
    scheduler.resetScheduleBatches()
    scheduler.generatePlan({ configId: 1, from: Date.UTC(2026, 0, 1), horizonDays: 3 })
    scheduler.generatePlan({ configId: 2, from: Date.UTC(2026, 0, 1), horizonDays: 3 })

    const upstream = scheduler.pageBatches('SCHE-0001', 1, 8).items
    assert.ok(upstream.length > 0)
    assert.ok(upstream.every((batch) => batch.configNo === 'SCHE-0001'))
    const downstream = scheduler.pageBatches('SCHE-0002', 1, 8).items
    assert.ok(downstream.every((batch) => batch.configNo === 'SCHE-0002'))

    // 上游还没完成时下游保持排队。
    const firstDownstream = downstream[0]
    const blockedByWaiting = scheduler.startBatch('SCHE-0002', firstDownstream.batchNo)
    assert.equal(blockedByWaiting.ok, false)
    assert.match(blockedByWaiting.message, /保持排队/)

    // 上游同批次完成后，下游对应批次就绪。
    const upstreamBatch = upstream[0]
    assert.equal(scheduler.startBatch('SCHE-0001', upstreamBatch.batchNo).ok, true)
    assert.equal(scheduler.finishBatch('SCHE-0001', upstreamBatch.batchNo, '已完成').ok, true)
    const started = scheduler.startBatch('SCHE-0002', firstDownstream.batchNo)
    assert.equal(started.ok, true)

    // 分页只取当前配置的批次，不会因为别的配置有数据而串页。
    const page2 = scheduler.pageBatches('SCHE-0002', 2, 3)
    assert.ok(page2.items.every((batch) => batch.configNo === 'SCHE-0002'))
    assert.equal(page2.total, downstream.length)
  })

  it('失败区间只交接一次，重复交接不会产生重复节点', () => {
    scheduler.generatePlan({ configId: 1, from: Date.UTC(2026, 0, 1), horizonDays: 2 })
    const batch = scheduler.pageBatches('SCHE-0001', 1, 8).items[0]
    assert.equal(scheduler.startBatch('SCHE-0001', batch.batchNo).ok, true)
    scheduler.sweepTimeouts(Date.now() + 3600 * 1000 + 1000)
    assert.equal(scheduler.handOffFailureIntervals().handedOff, 1)
    assert.equal(scheduler.handOffFailureIntervals().handedOff, 0)
  })

  it('失败区间交给分析流水线，且失败批次不会连累下一批', () => {
    scheduler.generatePlan({ configId: 1, from: Date.UTC(2026, 0, 1), horizonDays: 3 })
    const batch = scheduler.pageBatches('SCHE-0001', 1, 8).items[0]
    const started = scheduler.startBatch('SCHE-0001', batch.batchNo)
    assert.equal(started.ok, true)
    if (!started.ok) return
    const swept = scheduler.sweepTimeouts((started.batch.startedAt ?? 0) + 3601 * 1000)
    assert.equal(swept.timedOut.length, 1)
    assert.equal(swept.queued.length, 2)
    const handoff = scheduler.handOffFailureIntervals()
    assert.equal(handoff.handedOff, 1)
    assert.match(handoff.nodeNos[0], /PIPE-FAIL-/)
  })
})
