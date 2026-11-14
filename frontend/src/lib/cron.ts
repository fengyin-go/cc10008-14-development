// 调度表达式（标准 5 字段 cron：分 时 日 月 周）解析与触发时间计算。
// 触发时间一律按配置里的时区解释，再换算回 UTC 落库；跨日与夏令时都由这里统一处理。

export type CronSpec = {
  raw: string
  minutes: number[]
  hours: number[]
  daysOfMonth: number[]
  months: number[]
  daysOfWeek: number[]
  domRestricted: boolean
  dowRestricted: boolean
}

export type CronParseResult =
  | { ok: true; spec: CronSpec }
  | { ok: false; error: string }

export type ZonedParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone)
  if (cached) {
    return cached
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  formatterCache.set(timeZone, formatter)
  return formatter
}

export function isSupportedTimeZone(timeZone: string): boolean {
  if (!timeZone || !timeZone.trim()) {
    return false
  }
  try {
    formatterFor(timeZone.trim()).format(new Date())
    return true
  } catch {
    return false
  }
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(date)
  const values: Record<string, number> = {}
  for (const part of parts) {
    if (part.type !== 'literal') {
      values[part.type] = Number(part.value)
    }
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
  }
}

function pad(value: number, size = 2): string {
  return String(value).padStart(size, '0')
}

/** 把某个时区里的墙上时间换算成 UTC 时刻(ms)。 */
export function zonedWallTimeToUtcMs(
  wall: ZonedParts,
  timeZone: string,
): number {
  const utcGuess = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  )
  let candidate = utcGuess
  // 两轮迭代足以覆盖夏令时切换造成的偏移变化。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const actual = formatterFor(timeZone).formatToParts(new Date(candidate))
    const actualValues: Record<string, number> = {}
    for (const part of actual) {
      if (part.type !== 'literal') {
        actualValues[part.type] = Number(part.value)
      }
    }
    const actualUtc = Date.UTC(
      actualValues.year,
      actualValues.month - 1,
      actualValues.day,
      actualValues.hour ?? 0,
      actualValues.minute ?? 0,
      actualValues.second ?? 0,
    )
    const delta = utcGuess - actualUtc
    if (delta === 0) {
      break
    }
    candidate += delta
  }
  return candidate
}

export function formatZoned(date: Date, timeZone: string): string {
  const parts = zonedParts(date, timeZone)
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}
const WEEKDAY_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
}

type FieldRange = { min: number; max: number; type: 'number' | 'month' | 'weekday' }

function parseField(
  segment: string,
  range: FieldRange,
): { ok: true; values: number[]; wildcard: boolean } | { ok: false; error: string } {
  const trimmed = segment.trim()
  if (!trimmed) {
    return { ok: false, error: '字段不能为空' }
  }
  if (trimmed === '*') {
    return { ok: true, values: [], wildcard: true }
  }

  const values = new Set<number>()
  for (const token of trimmed.split(',')) {
    const piece = token.trim()
    if (!piece) {
      return { ok: false, error: `无法解析片段「${token}」` }
    }
    const stepSplit = piece.split('/')
    if (stepSplit.length > 2) {
      return { ok: false, error: `步长写法不合法「${piece}」` }
    }
    let step = 1
    if (stepSplit.length === 2) {
      const stepText = stepSplit[1].trim()
      if (!/^\d+$/.test(stepText) || Number(stepText) <= 0) {
        return { ok: false, error: `步长必须是正整数「${piece}」` }
      }
      step = Number(stepText)
    }
    const base = stepSplit[0].trim()
    let start: number
    let end: number
    if (base === '*' || base === '') {
      start = range.min
      end = range.max
    } else if (base.includes('-')) {
      const [left, right] = base.split('-')
      const parsedLeft = parseValue(left.trim(), range)
      const parsedRight = parseValue(right.trim(), range)
      if (parsedLeft === null) {
        return { ok: false, error: `取值超出范围「${base}」` }
      }
      if (parsedRight === null) {
        return { ok: false, error: `取值超出范围「${base}」` }
      }
      start = parsedLeft
      end = parsedRight
      if (start > end) {
        return { ok: false, error: `区间起止颠倒「${base}」` }
      }
    } else {
      const parsed = parseValue(base, range)
      if (parsed === null) {
        return { ok: false, error: `取值超出范围「${base}」` }
      }
      start = parsed
      end = stepSplit.length === 2 ? range.max : parsed
    }
    for (let value = start; value <= end; value += step) {
      values.add(value)
    }
  }

  return {
    ok: true,
    values: [...values].sort((a, b) => a - b),
    wildcard: false,
  }
}

function parseValue(text: string, range: FieldRange): number | null {
  if (range.type === 'month') {
    const monthNumber = MONTH_NAMES[text.toLowerCase()]
    if (monthNumber !== undefined) {
      return monthNumber
    }
  }
  if (range.type === 'weekday') {
    const weekdayNumber = WEEKDAY_NAMES[text.toLowerCase()]
    if (weekdayNumber !== undefined) {
      return weekdayNumber
    }
    if (/^\d$/.test(text)) {
      const numeric = Number(text)
      // cron 同时接受 0 和 7 代表周日。
      if (numeric === 7) {
        return 0
      }
      if (numeric >= 0 && numeric <= 6) {
        return numeric
      }
      return null
    }
  }
  if (!/^-?\d+$/.test(text)) {
    return null
  }
  const numeric = Number(text)
  if (numeric < range.min || numeric > range.max) {
    return null
  }
  return numeric
}

export function parseCron(expression: string): CronParseResult {
  const raw = expression.trim()
  if (!raw) {
    return { ok: false, error: '调度表达式为空' }
  }
  const segments = raw.split(/\s+/)
  if (segments.length !== 5) {
    return {
      ok: false,
      error: `调度表达式需要 5 个字段（分 时 日 月 周），当前是 ${segments.length} 个`,
    }
  }
  const [minuteText, hourText, domText, monthText, dowText] = segments
  const minutes = parseField(minuteText, { min: 0, max: 59, type: 'number' })
  const hours = parseField(hourText, { min: 0, max: 23, type: 'number' })
  const daysOfMonth = parseField(domText, { min: 1, max: 31, type: 'number' })
  const months = parseField(monthText, { min: 1, max: 12, type: 'month' })
  const daysOfWeek = parseField(dowText, { min: 0, max: 6, type: 'weekday' })
  const failures = [minutes, hours, daysOfMonth, months, daysOfWeek].filter(
    (parsed) => !parsed.ok,
  )
  if (failures.length > 0) {
    const first = failures[0]
    return first.ok ? { ok: false, error: '调度表达式不合法' } : { ok: false, error: first.error }
  }
  if (!minutes.ok || !hours.ok || !daysOfMonth.ok || !months.ok || !daysOfWeek.ok) {
    return { ok: false, error: '调度表达式不合法' }
  }
  return {
    ok: true,
    spec: {
      raw,
      minutes: minutes.wildcard ? Array.from({ length: 60 }, (_, i) => i) : minutes.values,
      hours: hours.wildcard ? Array.from({ length: 24 }, (_, i) => i) : hours.values,
      months: months.wildcard
        ? Array.from({ length: 12 }, (_, i) => i + 1)
        : months.values,
      daysOfMonth: daysOfMonth.wildcard ? [] : daysOfMonth.values,
      daysOfWeek: daysOfWeek.wildcard ? [] : daysOfWeek.values,
      domRestricted: !daysOfMonth.wildcard,
      dowRestricted: !daysOfWeek.wildcard,
    },
  }
}

function dayMatches(spec: CronSpec, year: number, month: number, day: number, weekday: number): boolean {
  if (spec.months.length > 0 && !spec.months.includes(month)) {
    return false
  }
  // 与标准 cron 一致：日与周同时受限时取「或」，只受限一个时取「与」。
  if (spec.domRestricted && spec.dowRestricted) {
    const domHit = spec.daysOfMonth.includes(day)
    const dowHit = spec.daysOfWeek.includes(weekday)
    if (!domHit && !dowHit) {
      return false
    }
  } else if (spec.domRestricted) {
    if (!spec.daysOfMonth.includes(day)) {
      return false
    }
  } else if (spec.dowRestricted) {
    if (!spec.daysOfWeek.includes(weekday)) {
      return false
    }
  }
  return true
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** 从 afterMs 之后（不含 afterMs）开始找至少一次触发；找不到返回 null。 */
export function nextTriggerUtc(
  spec: CronSpec,
  timeZone: string,
  afterMs: number,
  searchDays = 400,
): Date | null {
  const startParts = zonedParts(new Date(afterMs + 1000), timeZone)
  const startUtcDay = Date.UTC(startParts.year, startParts.month - 1, startParts.day)
  // 本地日期最多往后翻 searchDays 天；夏令时让每天实际长度不固定，所以按墙上日期推进。
  for (let offset = 0; offset <= searchDays; offset += 1) {
    const wallDate = new Date(startUtcDay + offset * 86_400_000)
    const year = wallDate.getUTCFullYear()
    const month = wallDate.getUTCMonth() + 1
    const day = wallDate.getUTCDate()
    const weekday = wallDate.getUTCDay()
    if (!dayMatches(spec, year, month, day, weekday)) {
      continue
    }
    for (const hour of [...spec.hours].sort((a, b) => a - b)) {
      for (const minute of [...spec.minutes].sort((a, b) => a - b)) {
        const candidateMs = zonedWallTimeToUtcMs(
          { year, month, day, hour, minute, second: 0 },
          timeZone,
        )
        const candidateParts = zonedParts(new Date(candidateMs), timeZone)
        // 夏令时跳过不存在的墙上时间：换算回来对不上就视为这一格不存在。
        if (
          candidateParts.year !== year ||
          candidateParts.month !== month ||
          candidateParts.day !== day ||
          candidateParts.hour !== hour ||
          candidateParts.minute !== minute
        ) {
          continue
        }
        if (candidateMs >= afterMs + 1000) {
          return new Date(candidateMs)
        }
      }
    }
  }
  return null
}

/** 展开从 afterMs 到 untilMs 之间的触发批次，最多返回 limit 个。 */
export function triggersBetween(
  spec: CronSpec,
  timeZone: string,
  afterMs: number,
  untilMs: number,
  limit: number,
): Date[] {
  const result: Date[] = []
  let cursor = afterMs
  while (result.length < limit) {
    const next = nextTriggerUtc(spec, timeZone, cursor)
    if (!next || next.getTime() > untilMs) {
      break
    }
    result.push(next)
    cursor = next.getTime()
  }
  return result
}
