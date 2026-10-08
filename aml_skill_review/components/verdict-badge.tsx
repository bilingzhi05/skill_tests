// ============================================================
// 判定徽标组件
// 作用：把「大模型判定 / 人工判定」的文字显示成带颜色的标签：
// 命中=绿色、相关=黄色、错误=红色、未知=灰色、未判定=灰色虚线框。
// 列表页、详情页、统计页都会用到它。
// ============================================================

import { Badge } from "@/components/ui/badge"
import { classifyVerdict } from "@/lib/stats"

/** 四类判定对应的颜色样式 */
const categoryClasses: Record<string, string> = {
  命中: "border-emerald-200 bg-emerald-50 text-emerald-700",
  相关: "border-amber-200 bg-amber-50 text-amber-700",
  错误: "border-red-200 bg-red-50 text-red-700",
  未知: "border-slate-200 bg-slate-100 text-slate-500",
}

/**
 * 判定徽标。
 * 作用：传入判定文字（可能为空），自动归一分类并渲染对应颜色的标签；
 * 空值显示灰色虚线的「未判定」。
 */
export function VerdictBadge({ value }: { value: string | null | undefined }) {
  const v = String(value ?? "").trim()
  // 空值 = 还没做人工判定
  if (!v) {
    return (
      <Badge variant="outline" className="border-dashed text-muted-foreground">
        未判定
      </Badge>
    )
  }
  const category = classifyVerdict(v)
  return (
    <Badge variant="outline" className={categoryClasses[category]}>
      {v}
    </Badge>
  )
}
