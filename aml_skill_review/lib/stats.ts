// ============================================================
// 统计逻辑文件
// 作用：根据全表数据计算统计页需要的全部指标：
// 总数、四类判定（命中/相关/错误/未知）的大模型与人工分布、
// 一致率、不一致清单等。统计在服务端 API 里完成。
// ============================================================

/** 四类判定分类（统一展示顺序） */
export const VERDICT_CATEGORIES = ["命中", "相关", "错误", "未知"] as const
export type VerdictCategory = (typeof VERDICT_CATEGORIES)[number]

/**
 * 判定分类函数。
 * 作用：把大模型判定 / 人工判定的原始文字归一到四类之一。
 * 规则：空值或缺少分析信息 → 未知；含「命中」→ 命中（如「命中根因」）；
 * 含「相关」→ 相关；含「错误」→ 错误；其余一律 → 未知。
 */
export function classifyVerdict(value: string | null | undefined): VerdictCategory {
  const v = String(value ?? "").trim()
  if (!v) return "未知"
  if (v.includes("命中")) return "命中"
  if (v.includes("相关")) return "相关"
  if (v.includes("错误")) return "错误"
  return "未知"
}

/** 单个数据行（统计只用到其中几列） */
export type StatsRow = {
  jira_id: string | null
  summary: string | null
  judge_verdict: string | null
  human_judge: string | null
}

/** 统计结果类型 */
export type StatsResult = {
  /** 总条数 */
  total: number
  /** 已完成人工评审的条数 */
  reviewed: number
  /** 未评审条数 */
  pending: number
  /** 评审完成率（0~1） */
  reviewedRatio: number
  /**
   * 最终状态四类分布。
   * 统计规则：每条工单先看是否有人工评审结果——
   * 有 → 采用人工评审的状态；没有 → 采用大模型判定结果。
   * 因此 总数 = 命中 + 相关 + 错误 + 未知。
   */
  verdictCounts: Record<VerdictCategory, number>
  /** 概览卡片占比：每类数量 / 总数 */
  categoryRatios: Record<VerdictCategory, number>
  /** 大模型与人工判定（分类后）一致的条数 */
  agreed: number
  /** 一致率 = 一致条数 / 已评审条数 */
  agreementRatio: number
  /** 判定不一致的工单清单 */
  disagreements: StatsRow[]
}

/**
 * 取一条工单的「最终判定状态」。
 * 作用：有人工评审结果就用人工的，否则用大模型判定。
 */
export function finalVerdict(row: StatsRow): string {
  const human = String(row.human_judge ?? "").trim()
  return human !== "" ? human : String(row.judge_verdict ?? "")
}

/**
 * 计算统计数据（核心函数）。
 * 作用：传入全表数据，返回统计页需要的所有指标。
 */
export function computeStats(rows: StatsRow[]): StatsResult {
  const total = rows.length
  // 已评审 = 人工判定不为空
  const reviewedRows = rows.filter((r) => String(r.human_judge ?? "").trim() !== "")
  const reviewed = reviewedRows.length

  // 最终状态四类分布：人工优先，大模型兜底（保证 总数 = 四类之和）
  const verdictCounts: Record<VerdictCategory, number> = { 命中: 0, 相关: 0, 错误: 0, 未知: 0 }
  for (const r of rows) {
    verdictCounts[classifyVerdict(finalVerdict(r))]++
  }

  // 概览卡片占比：该类数量 / 总数
  const categoryRatios = {} as Record<VerdictCategory, number>
  for (const c of VERDICT_CATEGORIES) {
    categoryRatios[c] = total > 0 ? verdictCounts[c] / total : 0
  }

  // 一致性：已评审条目中，人工判定分类 == 大模型判定分类
  const agreedRows = reviewedRows.filter(
    (r) => classifyVerdict(r.human_judge) === classifyVerdict(r.judge_verdict),
  )
  const disagreements = reviewedRows.filter(
    (r) => classifyVerdict(r.human_judge) !== classifyVerdict(r.judge_verdict),
  )

  return {
    total,
    reviewed,
    pending: total - reviewed,
    reviewedRatio: total > 0 ? reviewed / total : 0,
    verdictCounts,
    categoryRatios,
    agreed: agreedRows.length,
    agreementRatio: reviewed > 0 ? agreedRows.length / reviewed : 0,
    disagreements,
  }
}

/** 百分比格式化：0.1234 → "12.3%" */
export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`
}

// ============================================================
// 同Skill结果对比全览（跨表按 jira_id 对齐）
// ============================================================

/**
 * 从表名提取类型。
 * 作用：表名形如 test-Nagracas-0801_220001，取「test-」后到下一个「-」前的
 * 第一段（Nagracas）作为类型；不匹配 test- 前缀时用整个表名当类型。
 */
export function extractTypeFromTable(tableName: string): string {
  const m = /^test-([^-]+)/i.exec(String(tableName ?? "").trim())
  return m ? m[1] : String(tableName ?? "").trim() || "未命名"
}

/** 对比单元格：某张表对某个 jira_id 的最终判定（"-" = 该表无此工单） */
export type CompareCell = { table: string; verdict: VerdictCategory | "未判定" | "-" }

/** 对比行：按 jira_id 对齐后的一条数据，cells 顺序与所选表一致 */
export type CompareRow = { jira_id: string; cells: CompareCell[] }

/** 单张表的判定分布汇总（只统计最终判定：人工优先、大模型兜底） */
export type TableVerdictStats = {
  table: string
  total: number
  counts: Record<VerdictCategory, number>
}

/** 对比统计结果 */
export type CompareResult = {
  tables: string[]
  tableStats: TableVerdictStats[]
  rows: CompareRow[]
  /** 所有选中表判定（存在值时）完全一致的 jira_id 条数 */
  consistentCount: number
  /** 判定不一致的 jira_id 清单 */
  inconsistentJiraIds: string[]
}

/**
 * 计算跨表对比统计（核心函数）。
 * 作用：传入若干表的全量行，先算每张表的判定分布，
 * 再按 jira_id 对齐生成对比行（缺失显示 "-"）。
 * 每条的最终判定口径与统计页一致：有人工判定取人工，否则取大模型判定。
 */
export function computeCompareStats(
  tablesRows: { table: string; rows: StatsRow[] }[],
): CompareResult {
  const tables = tablesRows.map((t) => t.table)

  // 1. 每张表的判定分布汇总
  const tableStats: TableVerdictStats[] = tablesRows.map(({ table, rows }) => {
    const counts: Record<VerdictCategory, number> = { 命中: 0, 相关: 0, 错误: 0, 未知: 0 }
    for (const r of rows) counts[classifyVerdict(finalVerdict(r))]++
    return { table, total: rows.length, counts }
  })

  // 2. 收集所有出现过的 jira_id（同一表内重复 jira_id 取第一条）
  const verdictByTable = new Map<string, Map<string, VerdictCategory | "未判定">>()
  for (const { table, rows } of tablesRows) {
    const map = new Map<string, VerdictCategory | "未判定">()
    for (const r of rows) {
      const id = String(r.jira_id ?? "").trim()
      if (!id || map.has(id)) continue
      const verdict = classifyVerdict(finalVerdict(r))
      map.set(id, String(finalVerdict(r)).trim() === "" ? "未判定" : verdict)
    }
    verdictByTable.set(table, map)
  }

  const allIds = Array.from(
    new Set(Array.from(verdictByTable.values()).flatMap((m) => Array.from(m.keys()))),
  ).sort()

  // 3. 按 jira_id 对齐生成对比行
  const rows: CompareRow[] = allIds.map((id) => ({
    jira_id: id,
    cells: tablesRows.map(({ table }) => {
      const verdict = verdictByTable.get(table)?.get(id)
      return { table, verdict: verdict ?? "-" }
    }),
  }))

  // 4. 一致性：存在值（非 "-"）的判定全部相同才计为一致
  const inconsistentJiraIds: string[] = []
  for (const row of rows) {
    const present = row.cells.map((c) => c.verdict).filter((v) => v !== "-")
    const unique = new Set(present)
    if (present.length > 1 && unique.size > 1) inconsistentJiraIds.push(row.jira_id)
  }
  const consistentCount = rows.length - inconsistentJiraIds.length

  return { tables, tableStats, rows, consistentCount, inconsistentJiraIds }
}
