// ============================================================
// 统计页组件
// 作用：展示评审统计结果，共三行内容：
// 第一行：概览卡片（总数、命中、相关、错误、未知，附判定定义说明）；
// 统计口径：每条 JIRA 只算一次——有人工评审结果就取人工状态，
// 没有人工评审才取大模型判定，保证 总数 = 命中 + 相关 + 错误 + 未知；
// 第二行：占比与一致率卡片（各分类占总数比例）；
// 第三行：大模型与人工判定不一致的差异清单。
// ============================================================

"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { ArrowLeft, Loader2 } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { VerdictBadge } from "@/components/verdict-badge"
import { formatPercent, VERDICT_CATEGORIES, type StatsResult } from "@/lib/stats"

/** 四类判定的定义说明（显示在概览卡片下方） */
const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  命中:
    "jira 信息和 skill 分析结论，两者在“根本原因”层面一致（同一类根因/同一关键触发机制），并且问题表现不矛盾。",
  相关:
    "jira 信息和 skill 分析结论，两者在问题域/现象上有关联，但根因不一致或根因不充分一致（比如只对上现象或只对上一部分证据）。",
  错误:
    "jira 信息和 skill 分析结论，两者核心结论冲突，证据/描述明显不匹配（例如把蓝牙问题判成 WiFi、把硬件错误判成应用逻辑错误等）。",
  未知:
    "jira 信息和 skill 分析结论，两者中其中一个缺少关于问题分析的信息，导致无法判断根因是否一致（例如没有分析内容）。",
}

/** 每个分类对应的颜色小圆点 */
const CATEGORY_DOT: Record<string, string> = {
  命中: "bg-emerald-500",
  相关: "bg-amber-500",
  错误: "bg-red-500",
  未知: "bg-slate-400",
}

export function StatsPage({ table, dataUser = "" }: { table: string; dataUser?: string }) {
  const [stats, setStats] = useState<StatsResult | null>(null) // 统计数据
  const [loading, setLoading] = useState(true) // 正在加载
  const [loadError, setLoadError] = useState("") // 加载失败原因

  /**
   * 加载统计数据。
   * 作用：请求 /api/stats，服务端会计算好全部指标后返回；
   * 管理员查看其他用户时带上 user 参数。
   */
  useEffect(() => {
    async function load() {
      if (!table) {
        setLoadError("缺少数据表参数，请先在列表页选择 xlsx 文件")
        setLoading(false)
        return
      }
      try {
        const params = new URLSearchParams({ table })
        if (dataUser) params.set("user", dataUser)
        const res = await fetch(`/api/stats?${params.toString()}`)
        const data = await res.json()
        if (!data.ok) throw new Error(data.error || "获取统计失败")
        setStats(data.stats)
        console.log("[统计页] 加载统计成功:", data.stats)
      } catch (err) {
        console.error("[统计页] 加载失败:", err)
        setLoadError(String(err instanceof Error ? err.message : err))
        toast.error("获取统计失败", { description: String(err) })
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [table, dataUser])

  // ---------- 加载中 / 出错占位 ----------
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 size-5 animate-spin" /> 统计计算中…
      </div>
    )
  }
  if (loadError || !stats) {
    return (
      <div className="mx-auto max-w-md py-24 text-center">
        <p className="text-lg font-medium">无法显示统计</p>
        <p className="mt-1 text-sm text-muted-foreground">{loadError}</p>
        <Link href="/" className={buttonVariants({ variant: "outline", className: "mt-6" })}>
          <ArrowLeft className="size-4" />
          返回列表
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 md:px-8">
      {/* 顶部导航 */}
      <div className="mb-6 flex items-center justify-between gap-3">
        <Link href="/" className={buttonVariants({ variant: "ghost", size: "sm", className: "-ml-2" })}>
          <ArrowLeft className="size-4" />
          返回列表
        </Link>
        <span className="text-sm text-muted-foreground">当前数据表：{table}</span>
      </div>

      <header className="mb-8">
        <p className="text-sm font-medium text-muted-foreground">质量分析</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight md:text-3xl">评审统计</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
          统计口径：每条 JIRA 若有人工评审结果，直接采用人工评审状态；若无人工评审结果，则采用大模型判定结果。总数 = 命中 + 相关 + 错误 + 未知。
        </p>
      </header>

      <div className="space-y-6">
        {/* ========== 第一行：概览卡片 ========== */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {/* 总数卡片 */}
          <Card>
            <CardContent className="pt-6">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                总数
              </p>
              <p className="mt-2 font-mono text-3xl font-semibold tabular-nums">{stats.total}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                已评审 {stats.reviewed} · 未评审 {stats.pending} · 完成率{" "}
                {formatPercent(stats.reviewedRatio)}
              </p>
            </CardContent>
          </Card>

          {/* 四类判定卡片 */}
          {VERDICT_CATEGORIES.map((c) => (
            <Card key={c}>
              <CardContent className="pt-6">
                <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <span className={`size-2.5 rounded-full ${CATEGORY_DOT[c]}`} />
                  {c}
                </p>
                <p className="mt-2 font-mono text-3xl font-semibold tabular-nums">
                  {stats.verdictCounts[c]}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  有人工评审取人工，否则取大模型
                </p>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground/80">
                  {CATEGORY_DESCRIPTIONS[c]}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* ========== 第二行：占比与一致率卡片 ========== */}
        <div>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">占比与一致率</CardTitle>
              <CardDescription>各分类数量占总数的比例（人工优先、大模型兜底口径）</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {VERDICT_CATEGORIES.map((c) => {
                const ratio = stats.categoryRatios[c]
                return (
                  <div key={c} className="space-y-1.5">
                    <div className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-2">
                        <span className={`size-2.5 rounded-full ${CATEGORY_DOT[c]}`} />
                        {c}
                      </span>
                      <span className="font-mono text-xs tabular-nums text-muted-foreground">
                        {stats.verdictCounts[c]} 条 · {formatPercent(ratio)}
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={`h-full rounded-full ${CATEGORY_DOT[c]}`}
                        style={{ width: `${Math.min(ratio * 100, 100)}%` }}
                      />
                    </div>
                  </div>
                )
              })}
              <div className="mt-4 grid grid-cols-2 gap-4 border-t border-border pt-4">
                <div>
                  <p className="text-xs text-muted-foreground">评审一致率（已评审中）</p>
                  <p className="mt-1 font-mono text-2xl font-semibold tabular-nums">
                    {formatPercent(stats.agreementRatio)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">评审完成率</p>
                  <p className="mt-1 font-mono text-2xl font-semibold tabular-nums">
                    {formatPercent(stats.reviewedRatio)}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* ========== 第三行：差异清单 ========== */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">判定差异明细</CardTitle>
            <CardDescription>
              {stats.disagreements.length > 0
                ? `共 ${stats.disagreements.length} 条工单的人工评审结论与大模型判定不一致`
                : "当前已评审工单的人工结论与大模型判定全部一致"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {stats.disagreements.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">暂无差异记录</p>
            ) : (
              <div className="overflow-hidden rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50 hover:bg-muted/50">
                      <TableHead className="w-[140px]">Jira ID</TableHead>
                      <TableHead className="min-w-[240px]">Summary</TableHead>
                      <TableHead className="w-[130px]">大模型判定</TableHead>
                      <TableHead className="w-[130px]">人工判定</TableHead>
                      <TableHead className="w-[90px] text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {stats.disagreements.map((item, index) => (
                      <TableRow key={`${item.jira_id}-${index}`} className="align-top">
                        <TableCell className="font-mono text-sm font-medium">
                          {item.jira_id || "-"}
                        </TableCell>
                        <TableCell className="text-sm">
                          <span className="line-clamp-2">{item.summary || "-"}</span>
                        </TableCell>
                        <TableCell>
                          <VerdictBadge value={item.judge_verdict} />
                        </TableCell>
                        <TableCell>
                          <VerdictBadge value={item.human_judge} />
                        </TableCell>
                        <TableCell className="text-right">
                          <Link
                            href={`/review/${encodeURIComponent(String(item.jira_id || ""))}?table=${encodeURIComponent(table)}${
                              dataUser ? `&user=${encodeURIComponent(dataUser)}` : ""
                            }`}
                            className={buttonVariants({ size: "sm", variant: "outline" })}
                          >
                            详情
                          </Link>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
