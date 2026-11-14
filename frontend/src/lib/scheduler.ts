import { listRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

import { isSupportedTimeZone, nextTriggerUtc, parseCron, triggersBetween, zonedParts } from './cron'

/** 调度配置的业务类型：就是调度管理模块的一行记录，加上统一的合法字段名。 */
export type ScheduleConfig = {
  id: number
  configNo: string
  task: string
  expression: string
  timeZone: string
  predecessorIds: number[]
  maxConcurrency: number | null
  retryPolicy: string
  timeoutSeconds: number | null
  status: string
}

export type BatchStatus =
  | '排队中'
  | '运行中'
  | '已完成'
  | '已超时'
  | '已失败'
  | '阻塞'
  | '已取消'

export type BatchSource = '正常调度' | '取消后续跑' | '恢复调度'

export type PlanBatch = {
  batchNo: string
  configId: number
  configNo: string
  task: string
  /** 本批次配置快照。批次生成时的配置，后续改配置不会重写这里。 */
  snapshot: {
    expression: string
    timeZone: string
    predecessors: number[]
    maxConcurrency: number
    timeoutSeconds: number
    retryPolicy: string
    version: number
    adoptedAt: string
  }
  /** 触发时刻（UTC ms）。跨日与时区都按 snapshot.timeZone 解释后落成绝对时间。 */
  triggerAt: number
  status: BatchStatus
  /** 取消调度后继续跑的批次单独标记来源。 */
  source: BatchSource
  /** 失败时记录失败区间，交给分析流水线。 */
  failureInterval?: {
    startedAt: number
    failedAt: number
    reason: string
  }
  /** 执行凭据：批次启动后冻结，改配置不能重写。 */
  executionCredential?: string
  startedAt?: number
  finishedAt?: number
}

export type PageInfo = {
  items: PlanBatch[]
  total: number
  page: number
  size: number
  totalPages: number
  /** 当前页实际携带的执行批次：翻页只换批次，不混入其它配置或过滤结果。 */
  currentBatchNo: string | null
}

const SCHEDULE_MODULE_KEY = 'scheduler'
const BATCHES_STORAGE_KEY = 'interactive-analytics-lab:scheduler-batches'
const VERSIONS_STORAGE_KEY = 'interactive-analytics-lab:scheduler-versions'
const STATE_STORAGE_KEY = 'interactive-analytics-lab:scheduler-state'
const CHECK_INTERVAL_SECONDS = 60
const PAGE_SIZE_DEFAULT = 8
const PLAN_HORIZON_DAYS = 7
const PLAN_BATCH_LIMIT = 200

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined' || !window.localStorage) {
    return clone(fallback)
  }
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    return clone(fallback)
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return clone(fallback)
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(key, JSON.stringify(value))
  }
}

function pad(value: number, size = 2): string {
  return String(value).padStart(size, '0')
}

export function formatTimestamp(ms: number, timeZone?: string): string {
  const date = new Date(ms)
  if (!timeZone) {
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
  }
  const parts = zonedParts(date, timeZone)
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`
}

function splitList(text: string): string[] {
  return text
    .split(/[,，;；\s]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

/** 前置任务字段既接受任务编号（PIPE-0002）也接受调度配置编号（SCHE-0002）。 */
function parsePredecessors(text: string): number[] {
  const parts = splitList(text)
  if (parts.length === 1 && /^无$/.test(parts[0])) {
    return []
  }
  const scheduleRows = listRows(SCHEDULE_MODULE_KEY)
  const pipelineRows = listRows('pipeline')
  const ids: number[] = []
  const unknown: string[] = []
  for (const part of parts) {
    const scheduleHit = scheduleRows.find(
      (row) => String(row['配置编号']) === part || String(row.id) === part,
    )
    if (scheduleHit) {
      ids.push(Number(scheduleHit.id))
      continue
    }
    const pipelineHit = pipelineRows.find(
      (row) => String(row['节点编号']) === part,
    )
    if (pipelineHit) {
      ids.push(Number(pipelineHit.id))
      continue
    }
    unknown.push(part)
  }
  if (unknown.length > 0) {
    throw new ConfigError(`前置任务里登记了不存在的任务：${unknown.join('、')}`)
  }
  return ids
}

export class ConfigError extends Error {
  issues: string[]
  constructor(issues: string | string[]) {
    const list = Array.isArray(issues) ? issues : [issues]
    super(list.join('；'))
    this.name = 'ConfigError'
    this.issues = list
  }
}

function parseInteger(raw: string, field: string, min: number, issues: string[]): number {
  const text = String(raw ?? '').trim()
  if (!text) {
    issues.push(`${field}为空`)
    return 0
  }
  if (!/^-?\d+$/.test(text)) {
    issues.push(`${field}「${text}」不是整数`)
    return 0
  }
  const value = Number(text)
  if (value < min) {
    issues.push(`${field}为 ${value}，不能小于 ${min}`)
    return value
  }
  return value
}

/** 把一行调度配置翻译成业务对象，并在保存阶段收集所有能让计划无法工作的问题。 */
export function normalizeConfig(row: EntryRow): { config: ScheduleConfig; issues: string[] } {
  const issues: string[] = []
  const configNo = String(row['配置编号'] ?? '').trim()
  const task = String(row['关联任务'] ?? '').trim()
  if (!configNo) {
    issues.push('配置编号为空')
  }
  if (!task) {
    issues.push('关联任务为空，配置关联的是周任务，必须写明')
  }

  const expression = String(row['调度表达式'] ?? '').trim()
  const timeZone = String(row['时区设定'] ?? '').trim()
  let timeZoneOk = true
  if (!timeZone) {
    issues.push('时区设定为空，跨日调度无法解释')
    timeZoneOk = false
  } else if (!isSupportedTimeZone(timeZone)) {
    issues.push(`时区设定「${timeZone}」不是可识别的时区`)
    timeZoneOk = false
  }

  const parsed = parseCron(expression)
  if (!parsed.ok) {
    issues.push(parsed.error)
  } else if (timeZoneOk) {
    const next = nextTriggerUtc(parsed.spec, timeZone, Date.now())
    if (!next) {
      issues.push('调度表达式没有未来触发时间，启用后不会产生任何批次')
    }
  }

  let predecessorIds: number[] = []
  try {
    predecessorIds = parsePredecessors(String(row['前置任务'] ?? ''))
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error))
  }

  const maxConcurrency = parseInteger(String(row['最大并发数'] ?? ''), '最大并发数', 0, issues)
  if (maxConcurrency <= 0 && String(row['最大并发数'] ?? '').trim() === '0') {
    issues.push('最大并发数为 0，批次永远无法进入执行')
  }

  const timeoutSeconds = parseInteger(String(row['超时终止'] ?? ''), '超时终止', 0, issues)
  if (String(row['超时终止'] ?? '').trim() === '0') {
    issues.push('超时终止为 0，运行中的批次永远不会被终止')
  } else if (timeoutSeconds > 0 && timeoutSeconds < CHECK_INTERVAL_SECONDS) {
    issues.push(
      `超时终止 ${timeoutSeconds} 秒短于检查周期 ${CHECK_INTERVAL_SECONDS} 秒，超时判定会失效`,
    )
  }

  const retryPolicy = String(row['失败重试策略'] ?? '').trim()
  if (!retryPolicy) {
    issues.push('失败重试策略为空')
  }

  return {
    config: {
      id: Number(row.id),
      configNo,
      task,
      expression,
      timeZone,
      predecessorIds,
      maxConcurrency,
      retryPolicy,
      timeoutSeconds,
      status: String(row.status),
    },
    issues,
  }
}

export function loadConfigs(): { configs: ScheduleConfig[]; issuesByConfig: Record<number, string[]> } {
  const rows = listRows(SCHEDULE_MODULE_KEY)
  const issuesByConfig: Record<number, string[]> = {}
  const configs = rows.map((row) => {
    const { config, issues } = normalizeConfig(row)
    if (issues.length > 0) {
      issuesByConfig[config.id] = issues
    }
    return config
  })
  return { configs, issuesByConfig }
}

export type ConfigVersion = {
  configNo: string
  version: number
  adoptedAt: string
  savedAt: number
  /** 保存后的配置摘要，用来判断两个编辑窗口是否提交了不同内容。 */
  digest: string
  status: string
}

type VersionStore = Record<string, ConfigVersion>

function configDigest(config: ScheduleConfig): string {
  return JSON.stringify({
    task: config.task,
    expression: config.expression,
    timeZone: config.timeZone,
    predecessors: config.predecessorIds,
    maxConcurrency: config.maxConcurrency,
    timeoutSeconds: config.timeoutSeconds,
    retryPolicy: config.retryPolicy,
  })
}

function readVersions(): VersionStore {
  return readJson<VersionStore>(VERSIONS_STORAGE_KEY, {})
}

/** 保存前先拿当前生效版本，两个窗口同时保存时后提交的一方能被明确裁决。 */
export function currentVersion(config: ScheduleConfig): ConfigVersion {
  const store = readVersions()
  const existing = store[config.configNo]
  if (existing) {
    return existing
  }
  const created: ConfigVersion = {
    configNo: config.configNo,
    version: 1,
    adoptedAt: new Date().toISOString(),
    savedAt: Date.now(),
    digest: configDigest(config),
    status: config.status,
  }
  store[config.configNo] = created
  writeVersions(store)
  return created
}

function writeVersions(store: VersionStore): void {
  writeJson(VERSIONS_STORAGE_KEY, store)
}

export type SaveOutcome =
  | { ok: true; version: ConfigVersion }
  | { ok: false; rejectedBy: ConfigVersion; message: string }

/**
 * 保存配置版本。expectedVersion 是编辑窗口打开时看到的版本号：
 * 两个窗口同时保存时只有携带最新版本号的那一份生效，另一份要显示被哪个版本裁决。
 */
export function saveConfigVersion(
  config: ScheduleConfig,
  issues: string[],
  expectedVersion: number,
): SaveOutcome {
  if (issues.length > 0) {
    throw new ConfigError(issues)
  }
  const store = readVersions()
  const current = store[config.configNo] ?? currentVersion(config)
  if (expectedVersion !== current.version) {
    return {
      ok: false,
      rejectedBy: current,
      message: `配置「${config.configNo}」已被版本 v${current.version}（${formatTimestamp(current.savedAt)} 保存）裁决，请刷新后重新编辑`,
    }
  }
  const unchanged = current.digest === configDigest(config)
  if (unchanged) {
    return { ok: true, version: current }
  }
  const next: ConfigVersion = {
    configNo: config.configNo,
    version: current.version + 1,
    adoptedAt: new Date().toISOString(),
    savedAt: Date.now(),
    digest: configDigest(config),
    status: config.status,
  }
  store[config.configNo] = next
  writeVersions(store)
  return { ok: true, version: next }
}

function batchesByConfig(): Record<string, PlanBatch[]> {
  return readJson<Record<string, PlanBatch[]>>(BATCHES_STORAGE_KEY, {})
}

export type ConfigEdits = {
  task?: string
  expression?: string
  timeZone?: string
  predecessors?: string
  maxConcurrency?: string | number
  retryPolicy?: string
  timeoutSeconds?: string | number
}

export type SaveEditsOutcome = SaveOutcome | { ok: false; rejectedBy: ConfigVersion; message: string }

/**
 * 保存编辑窗口里的配置。先校验，再按版本裁决，最后才写入数据，
 * 被裁决的窗口不会覆盖已经生效的配置。
 */
export function saveConfigEdits(
  configId: number,
  edits: ConfigEdits,
  expectedVersion: number,
): SaveEditsOutcome {
  const rows = listRows(SCHEDULE_MODULE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === configId)
  if (index < 0) {
    throw new ConfigError(`没有找到编号为 ${configId} 的调度配置`)
  }
  const row = rows[index]
  const nextRow = {
    ...row,
    '关联任务': edits.task ?? String(row['关联任务'] ?? ''),
    '调度表达式': edits.expression ?? String(row['调度表达式'] ?? ''),
    '时区设定': edits.timeZone ?? String(row['时区设定'] ?? ''),
    '前置任务': edits.predecessors ?? String(row['前置任务'] ?? ''),
    '最大并发数': edits.maxConcurrency ?? row['最大并发数'],
    '失败重试策略': edits.retryPolicy ?? String(row['失败重试策略'] ?? ''),
    '超时终止': edits.timeoutSeconds ?? row['超时终止'],
  }
  const { config, issues } = normalizeConfig(nextRow)
  const outcome = saveConfigVersion(config, issues, expectedVersion)
  if (outcome.ok) {
    const nextRows = [...rows]
    nextRows[index] = nextRow
    saveRows(SCHEDULE_MODULE_KEY, nextRows)
  }
  return outcome
}

/** 批次完成或失败：只改这一个批次，不影响其它批次的状态。 */
export function finishBatch(
  configNo: string,
  batchNo: string,
  status: '已完成' | '已失败',
  reason = '',
): StartOutcome {
  const store = batchesByConfig()
  const batches = store[configNo] ?? []
  const index = batches.findIndex((batch) => batch.batchNo === batchNo)
  if (index < 0) {
    return { ok: false, message: `没有找到批次 ${batchNo}` }
  }
  const batch = batches[index]
  if (batch.status !== '运行中') {
    return { ok: false, message: `批次 ${batchNo} 当前状态「${batch.status}」，不能归档` }
  }
  const finishedAt = Date.now()
  const updated: PlanBatch = {
    ...batch,
    status,
    finishedAt,
    ...(status === '已失败'
      ? {
          failureInterval: {
            startedAt: batch.startedAt ?? finishedAt,
            failedAt: finishedAt,
            reason: reason || '执行失败',
          },
        }
      : {}),
  }
  const nextAll = [...batches]
  nextAll[index] = updated
  store[configNo] = nextAll
  writeBatchesByConfig(store)
  return { ok: true, batch: updated }
}

function writeBatchesByConfig(store: Record<string, PlanBatch[]>): void {
  writeJson(BATCHES_STORAGE_KEY, store)
}

type ScheduleState = Record<string, { enabledAt: number; resumedAt?: number }>

function readScheduleState(): ScheduleState {
  return readJson<ScheduleState>(STATE_STORAGE_KEY, {})
}

function writeScheduleState(state: ScheduleState): void {
  writeJson(STATE_STORAGE_KEY, state)
}

/** 首次启用（或显式启用）时记录启用时刻；恢复时更新恢复时刻。 */
export function markScheduleEnabled(configNo: string, at = Date.now()): void {
  const state = readScheduleState()
  if (!state[configNo]) {
    state[configNo] = { enabledAt: at }
    writeScheduleState(state)
  }
}

export function resetScheduleBatches(): void {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(BATCHES_STORAGE_KEY)
    window.localStorage.removeItem(STATE_STORAGE_KEY)
  }
}

function batchNoOf(configNo: string, triggerAt: number, timeZone: string): string {
  const stamp = formatTimestamp(triggerAt, timeZone).replace(/[-: ]/g, '')
  return `${configNo}-${stamp}`
}

export type PlanRequest = {
  configId: number
  /** 生成计划的起点（不含），默认当前时刻。 */
  from?: number
  horizonDays?: number
  /** 取消调度后继续跑：把当前排队批次转成来源「取消后续跑」。 */
  carryQueued?: boolean
  /** 恢复调度只从恢复时刻往后生成，不能补造停机期间的错过批次。 */
  resumeAt?: number
  /** 停机起点：用于统计被略过的错过批次，只计数不生成。 */
  missedFrom?: number
}

export type PlanResponse = {
  batches: PlanBatch[]
  version: ConfigVersion
  issues: string[]
  carried: number
  skippedMissed: number
}

/** 生成调度计划：按配置里的时区与表达式展开执行批次，并带上配置快照。 */
export function generatePlan(request: PlanRequest): PlanResponse {
  const { configs, issuesByConfig } = loadConfigs()
  const config = configs.find((item) => item.id === request.configId)
  if (!config) {
    throw new ConfigError(`没有找到编号为 ${request.configId} 的调度配置`)
  }
  const issues = issuesByConfig[config.id] ?? []
  if (issues.length > 0) {
    throw new ConfigError(issues)
  }
  markScheduleEnabled(config.configNo)
  const version = currentVersion(config)
  if (version.digest !== configDigest(config)) {
    // 存储里的配置还是旧版内容时，先把当前内容登记为新版本，保证批次快照对得上。
    const stored = saveConfigVersion(config, [], version.version)
    if (stored.ok) {
      return generatePlanWith(config, stored.version, request)
    }
  }
  return generatePlanWith(config, version, request)
}

function generatePlanWith(
  config: ScheduleConfig,
  version: ConfigVersion,
  request: PlanRequest,
): PlanResponse {
  const store = batchesByConfig()
  const existing = store[config.configNo] ?? []
  const parsed = parseCron(config.expression)
  if (!parsed.ok) {
    throw new ConfigError(parsed.error)
  }

  const now = Date.now()
  const state = readScheduleState()
  let carried = 0
  let kept = existing
  if (request.carryQueued) {
    kept = existing.map((batch) => {
      if (batch.status === '排队中') {
        carried += 1
        return { ...batch, source: '取消后续跑' as BatchSource }
      }
      return batch
    })
  }

  const horizonDays = request.horizonDays ?? PLAN_HORIZON_DAYS
  // 首次启用的配置只从启用时刻往后排；恢复时只从恢复时刻往后排，
  // 停机期间错过的触发点不补造，只通过 skippedMissed 提示操作员。
  const resumeAt = request.resumeAt
  const missedFrom = request.missedFrom ?? state[config.configNo]?.resumedAt ?? state[config.configNo]?.enabledAt ?? resumeAt ?? now
  const defaultFrom = resumeAt ?? missedFrom
  const fromMs = request.from ?? defaultFrom
  const untilMs = fromMs + horizonDays * 86_400_000
  const triggers = triggersBetween(parsed.spec, config.timeZone, fromMs, untilMs, PLAN_BATCH_LIMIT)

  let skippedMissed = 0
  if (resumeAt !== undefined && missedFrom < resumeAt) {
    skippedMissed += triggersBetween(
      parsed.spec,
      config.timeZone,
      missedFrom,
      resumeAt - 1,
      PLAN_BATCH_LIMIT,
    ).length
  }
  const planned: PlanBatch[] = []
  for (const trigger of triggers) {
    const triggerAt = trigger.getTime()
    const batchNo = batchNoOf(config.configNo, triggerAt, config.timeZone)
    const existingBatch = kept.find((batch) => batch.batchNo === batchNo)
    if (existingBatch) {
      // 已生成的批次保留原快照与执行凭据，再次生成计划不重写正在运行的内容。
      planned.push(existingBatch)
      continue
    }
    if (resumeAt !== undefined && triggerAt < resumeAt) {
      skippedMissed += 1
      continue
    }
    planned.push({
      batchNo,
      configId: config.id,
      configNo: config.configNo,
      task: config.task,
      triggerAt,
      status: '排队中',
      source: resumeAt !== undefined ? '恢复调度' : '正常调度',
      snapshot: {
        expression: config.expression,
        timeZone: config.timeZone,
        predecessors: config.predecessorIds,
        maxConcurrency: config.maxConcurrency ?? 0,
        timeoutSeconds: config.timeoutSeconds ?? 0,
        retryPolicy: config.retryPolicy,
        version: version.version,
        adoptedAt: version.adoptedAt,
      },
    })
  }

  // 恢复调度只保留恢复时刻起的批次；停机期间没跑成的排队批次直接丢弃，
  // 不补造也不留下会混淆计划页的旧记录，错过的数量由 skippedMissed 提示。
  const resumed = resumeAt !== undefined
  const base = resumed ? kept.filter((batch) => batch.triggerAt >= resumeAt) : kept
  const merged = [...base]
  for (const batch of planned) {
    if (!merged.some((item) => item.batchNo === batch.batchNo)) {
      merged.push(batch)
    }
  }
  merged.sort((a, b) => a.batchNo.localeCompare(b.batchNo))
  store[config.configNo] = merged
  writeBatchesByConfig(store)

  return { batches: merged, version, issues: [], carried, skippedMissed }
}

/** 调度计划按编号排序，并可按页翻页；每页只带当前配置的执行批次。 */
export function pageBatches(
  configNo: string,
  page = 1,
  size = PAGE_SIZE_DEFAULT,
): PageInfo {
  const store = batchesByConfig()
  const all = [...(store[configNo] ?? [])].sort((a, b) => a.batchNo.localeCompare(b.batchNo))
  const safeSize = Math.max(1, Math.floor(size))
  const totalPages = Math.max(1, Math.ceil(all.length / safeSize))
  const safePage = Math.min(Math.max(1, Math.floor(page)), totalPages)
  const start = (safePage - 1) * safeSize
  const items = all.slice(start, start + safeSize)
  return {
    items,
    total: all.length,
    page: safePage,
    size: safeSize,
    totalPages,
    currentBatchNo: items[0]?.batchNo ?? null,
  }
}

/** 上游任务尚未完成 / 被停用 / 不存在时，下游批次保持排队或被显式阻塞。 */
export function evaluatePredecessors(
  batch: PlanBatch,
): { state: 'ready' | 'queued' | 'blocked'; reason: string } {
  if (batch.snapshot.predecessors.length === 0) {
    return { state: 'ready', reason: '无前置任务' }
  }
  const scheduleRows = listRows(SCHEDULE_MODULE_KEY)
  const pipelineRows = listRows('pipeline')
  const blocks: string[] = []
  const waiting: string[] = []
  for (const id of batch.snapshot.predecessors) {
    const scheduleRow = scheduleRows.find((row) => Number(row.id) === id)
    if (scheduleRow) {
      const status = String(scheduleRow.status)
      if (status === '已停用') {
        blocks.push(`前置调度 ${String(scheduleRow['配置编号'])} 已停用`)
        continue
      }
      if (status !== '已启用') {
        waiting.push(`前置调度 ${String(scheduleRow['配置编号'])} 尚未启用（${status}）`)
        continue
      }
      const upstreamBatches = (batchesByConfig()[String(scheduleRow['配置编号'])] ?? [])
        .filter((item) => item.status !== '已取消')
        .filter((item) => item.triggerAt <= batch.triggerAt)
        .sort((a, b) => b.triggerAt - a.triggerAt)
      const latest = upstreamBatches[0]
      if (!latest) {
        waiting.push(`前置调度 ${String(scheduleRow['配置编号'])} 还没有可用的执行批次`)
      } else if (latest.status === '阻塞' || latest.status === '已失败' || latest.status === '已超时') {
        // 上游已经判定失败/阻塞时，下游必须转为阻塞，不能静默跳过。
        blocks.push(
          `前置调度 ${String(scheduleRow['配置编号'])} 的批次 ${latest.batchNo} 状态「${latest.status}」`,
        )
      } else if (latest.status !== '已完成') {
        waiting.push(`前置调度 ${String(scheduleRow['配置编号'])} 当前状态「${latest.status}」`)
      }
      continue
    }
    const pipelineRow = pipelineRows.find((row) => Number(row.id) === id)
    if (pipelineRow) {
      const status = String(pipelineRow.status)
      if (status === '已失败') {
        blocks.push(`前置节点 ${String(pipelineRow['节点编号'])} 已失败`)
      } else if (status !== '已完成') {
        waiting.push(`前置节点 ${String(pipelineRow['节点编号'])} 尚未完成（${status}）`)
      }
      continue
    }
    blocks.push(`前置任务 ${id} 已不存在`)
  }
  if (blocks.length > 0) {
    return { state: 'blocked', reason: blocks.join('；') }
  }
  if (waiting.length > 0) {
    return { state: 'queued', reason: waiting.join('；') }
  }
  return { state: 'ready', reason: '前置任务均已完成' }
}

export type StartOutcome =
  | { ok: true; batch: PlanBatch }
  | { ok: false; message: string }

/** 启动批次：把执行凭据冻结在批次上，之后再改配置也只影响下一批次。 */
export function startBatch(configNo: string, batchNo: string): StartOutcome {
  const store = batchesByConfig()
  const batches = store[configNo] ?? []
  const index = batches.findIndex((batch) => batch.batchNo === batchNo)
  if (index < 0) {
    return { ok: false, message: `没有找到批次 ${batchNo}` }
  }
  const batch = batches[index]
  if (batch.status === '运行中') {
    return { ok: false, message: `批次 ${batchNo} 已经在运行` }
  }
  if (batch.status !== '排队中') {
    return { ok: false, message: `批次 ${batchNo} 当前状态「${batch.status}」，不能启动` }
  }
  const predecessor = evaluatePredecessors(batch)
  if (predecessor.state === 'blocked') {
    const updated: PlanBatch = { ...batch, status: '阻塞' }
    const nextAll = [...batches]
    nextAll[index] = updated
    store[configNo] = nextAll
    writeBatchesByConfig(store)
    return { ok: false, message: `批次 ${batchNo} 转为阻塞：${predecessor.reason}` }
  }
  if (predecessor.state === 'queued') {
    return { ok: false, message: `批次 ${batchNo} 保持排队：${predecessor.reason}` }
  }
  const running = batches.filter((item) => item.status === '运行中').length
  if (running >= batch.snapshot.maxConcurrency) {
    return {
      ok: false,
      message: `批次 ${batchNo} 保持排队：已达到最大并发 ${batch.snapshot.maxConcurrency}`,
    }
  }
  const startedAt = Date.now()
  const credential = `CRED-${batch.configNo}-${pad(batch.snapshot.version)}-${batchNo.slice(-12)}-${startedAt}`
  const updated: PlanBatch = {
    ...batch,
    status: '运行中',
    startedAt,
    executionCredential: credential,
  }
  const nextAll = [...batches]
  nextAll[index] = updated
  store[configNo] = nextAll
  writeBatchesByConfig(store)
  return { ok: true, batch: updated }
}

/**
 * 检查超时。超时只失败自己的批次并记录失败区间；
 * 下一批仍留在排队中，不会被连带标失败。检查周期为 60 秒。
 */
export function sweepTimeouts(now = Date.now()): { timedOut: PlanBatch[]; queued: PlanBatch[] } {
  const store = batchesByConfig()
  const timedOut: PlanBatch[] = []
  const queued: PlanBatch[] = []
  for (const [configNo, batches] of Object.entries(store)) {
    let changed = false
    const nextAll = batches.map((batch) => {
      if (batch.status !== '运行中' || !batch.startedAt) {
        return batch
      }
      const limitMs = batch.snapshot.timeoutSeconds * 1000
      if (limitMs <= 0 || now - batch.startedAt < limitMs) {
        return batch
      }
      changed = true
      const failedAt = batch.startedAt + limitMs
      const timedOutBatch: PlanBatch = {
        ...batch,
        status: '已超时',
        finishedAt: failedAt,
        failureInterval: {
          startedAt: batch.startedAt,
          failedAt,
          reason: `超过超时终止 ${batch.snapshot.timeoutSeconds} 秒`,
        },
      }
      timedOut.push(timedOutBatch)
      return timedOutBatch
    })
    for (const batch of nextAll) {
      if (batch.status === '排队中') {
        queued.push(batch)
      }
    }
    if (changed) {
      store[configNo] = nextAll
    }
  }
  if (timedOut.length > 0) {
    writeBatchesByConfig(store)
  }
  return { timedOut, queued }
}

/** 失败区间交给分析流水线：每条区间落成一个待调度节点，状态彼此独立。 */
export function handOffFailureIntervals(): { handedOff: number; nodeNos: string[] } {
  const store = batchesByConfig()
  const pipelineRows = listRows('pipeline')
  const existingNos = pipelineRows.map((row) => String(row['节点编号']))
  let nextId = pipelineRows.reduce((max, row) => Math.max(max, Number(row.id)), 0)
  const nodeNos: string[] = []
  for (const batches of Object.values(store)) {
    for (const batch of batches) {
      if (!batch.failureInterval) {
        continue
      }
      const nodeNo = `PIPE-FAIL-${batch.batchNo}`
      if (existingNos.includes(nodeNo)) {
        continue
      }
      nextId += 1
      pipelineRows.push({
        id: nextId,
        status: '待调度',
        pending: true,
        abnormal: true,
        '节点编号': nodeNo,
        '节点类型': '失败区间回放',
        '输入源': `调度批次 ${batch.batchNo}`,
        '输出目标': `任务 ${batch.task}`,
        '处理脚本': `replay:${batch.executionCredential ?? 'no-credential'}`,
        '依赖上游': batch.configNo,
        '超时秒数': String(batch.snapshot.timeoutSeconds),
        '重试次数': batch.snapshot.retryPolicy,
      })
      existingNos.push(nodeNo)
      nodeNos.push(nodeNo)
    }
  }
  if (nodeNos.length > 0) {
    saveRows('pipeline', pipelineRows)
  }
  return { handedOff: nodeNos.length, nodeNos }
}

export type CancelOutcome = {
  cancelled: number
  carried: number
  dropped: number
}

/**
 * 取消调度。已经进入队列的批次可以选择继续（carryQueued=true），
 * 但必须单独标记来源「取消后续跑」，不能混作正常调度。
 */
export function cancelSchedule(configNo: string, carryQueued: boolean): CancelOutcome {
  const store = batchesByConfig()
  const batches = store[configNo] ?? []
  let cancelled = 0
  let carried = 0
  let dropped = 0
  const next = batches.map((batch) => {
    if (batch.status !== '排队中') {
      return batch
    }
    if (carryQueued) {
      carried += 1
      return { ...batch, source: '取消后续跑' as BatchSource }
    }
    cancelled += 1
    dropped += 1
    return { ...batch, status: '已取消' as BatchStatus }
  })
  store[configNo] = next
  writeBatchesByConfig(store)
  return { cancelled, carried, dropped }
}

export type ResumeOutcome = PlanResponse & { resumeAt: number }

/**
 * 恢复调度。只从恢复时刻往后生成批次，停机期间错过的触发点不会被补造，
 * 只统计到 skippedMissed 并提示操作员。
 */
export function resumeSchedule(
  configNo: string,
  options: { configId?: number; resumeAt?: number; horizonDays?: number } = {},
): ResumeOutcome {
  const configs = loadConfigs().configs
  const config =
    configs.find((item) => item.configNo === configNo) ??
    configs.find((item) => item.id === options.configId)
  if (!config) {
    throw new ConfigError(`没有找到配置编号为 ${configNo} 的调度配置`)
  }
  const resumeAt = options.resumeAt ?? Date.now()
  const state = readScheduleState()
  // 停机起点取自恢复之前记录的启用/恢复时刻，用于统计错过的批次。
  const missedFrom = state[config.configNo]?.resumedAt ?? state[config.configNo]?.enabledAt ?? resumeAt
  state[config.configNo] = { ...(state[config.configNo] ?? { enabledAt: resumeAt }), resumedAt: resumeAt }
  writeScheduleState(state)
  const plan = generatePlan({
    configId: config.id,
    from: resumeAt,
    resumeAt,
    missedFrom,
    horizonDays: options.horizonDays,
  })
  return { ...plan, resumeAt }
}

export function checkIntervalSeconds(): number {
  return CHECK_INTERVAL_SECONDS
}
