// ============================================================
// 统一字段映射文件（全站唯一来源）
// 作用：定义数据库英文字段名、中文显示名、以及 xlsx 表头的模糊匹配别名。
// 所有表格表头、详情标签、导出表头都必须从这里取值，禁止到处写死列名。
// ============================================================

/** 数据库字段定义：field = 英文列名，label = 中文显示名 */
export const FIELD_COLUMNS: { field: string; label: string }[] = [
  { field: "skill_path", label: "Skill 路径" },
  { field: "skill_name", label: "Skill 名称" },
  { field: "jql", label: "JQL" },
  { field: "schedule_time", label: "启动时间" },
  { field: "jira_id", label: "Jira ID" },
  { field: "summary", label: "Summary" },
  { field: "description", label: "Description" },
  { field: "root_cause", label: "Root Cause" },
  { field: "how_to_fix", label: "How to Fix" },
  { field: "comments", label: "Comments" },
  { field: "skill_raw", label: "Skill Raw" },
  { field: "skill_final", label: "Skill Final" },
  { field: "judge_real_result", label: "根因总结" },
  { field: "judge_verdict", label: "大模型判定" },
  { field: "judge_reason", label: "判定原因" },
  { field: "judge_aligned", label: "判定相同点" },
  { field: "judge_conflict", label: "判定不相同点" },
  { field: "human_judge", label: "人工判定" },
  { field: "human_judge_reason", label: "人工判定原因" },
  { field: "create_t", label: "创建时间" },
  { field: "update_t", label: "最后更新时间" },
]

/** 英文列名 → 中文显示名 的字典（由上面的数组自动生成，方便查找） */
export const FIELD_LABELS: Record<string, string> = Object.fromEntries(
  FIELD_COLUMNS.map((c) => [c.field, c.label]),
)

/** 所有英文列名列表 */
export const FIELD_NAMES: string[] = FIELD_COLUMNS.map((c) => c.field)

/**
 * xlsx 表头模糊匹配别名表。
 * 作用：xlsx 里的表头可能是中文、英文、带空格或大小写不同，
 * 匹配时先做「去空格、去下划线、转小写」归一化，再与别名逐一比对。
 * 键 = 数据库英文列名，值 = 可能出现的表头写法（同样会被归一化）。
 */
export const HEADER_ALIASES: Record<string, string[]> = {
  skill_path: ["skillpath", "skill路径", "路径"],
  skill_name: ["skillname", "skill名称", "名称"],
  jql: ["jql", "要跑的jql"],
  schedule_time: ["scheduletime", "启动时间", "几点启动", "几点启动年月日时分秒"],
  jira_id: ["jiraid", "jira", "工单号"],
  summary: ["summary", "标题"],
  description: ["description", "描述"],
  root_cause: ["rootcause", "根因", "rootcauseanalysis"],
  how_to_fix: ["howtofix", "修复方案", "解决方案", "fix"],
  comments: ["comments", "comment", "评论"],
  skill_raw: ["raw", "skillraw"],
  skill_final: ["final", "skillfinal"],
  judge_real_result: ["judgerealresult", "根因总结", "jira信息根因总结"],
  judge_verdict: ["judgeverdict", "大模型判定"],
  judge_reason: ["judgereason", "判定原因", "大模型判定原因"],
  judge_aligned: ["judgealigned", "判定相同点"],
  judge_conflict: ["judgeconflict", "判定不相同点", "判定不同点"],
}

/**
 * 表头归一化函数。
 * 作用：把表头文字统一成「小写、无空格、无下划线、无连字符」的形式，
 * 这样 "Jira ID"、"jira_id"、"JIRAID" 都会变成 "jiraid"，方便比对。
 */
export function normalizeHeader(name: string): string {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[\s_\-（）()]/g, "")
}

/**
 * 根据 xlsx 表头找到对应的数据库英文列名。
 * 作用：传入一个 xlsx 表头文字，返回它应该写入哪个英文字段；
 * 找不到就返回 null（调用方会打印警告并跳过该列）。
 */
export function matchHeaderToField(header: string): string | null {
  const norm = normalizeHeader(header)
  if (!norm) return null
  // 先直接匹配英文列名本身
  if (FIELD_NAMES.includes(norm)) return norm
  // 再逐个字段比对别名表
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const alias of aliases) {
      if (normalizeHeader(alias) === norm) return field
    }
  }
  return null
}
