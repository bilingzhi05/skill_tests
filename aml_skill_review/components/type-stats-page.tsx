// ============================================================
// 同Skill结果对比全览页组件
// 作用：
// 1. 列出当前用户 db 中所有表，按类型（表名 test-xxx 的 xxx）分组展示；
// 2. 用户勾选任意表（可随时加入/取消）加入对比；
// 3. 每张选中表显示「最终判定」（人工优先、大模型兜底）三类判定汇总；
// 4. 按 jira_id 对齐多张表，逐行显示「表名 + 判定结果」，
//    不一致的行高亮，可开关「只看不一致」。
// 页面拉伸全屏、大字号，方便阅读。
// ============================================================

"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
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
import {
  formatPercent,
  VERDICT_CATEGORIES,
  type CompareResult,
} from "@/lib/stats"

/** 类型分组清单（/api/type-stats 不带 tables 参数时返回） */
type TypeGroups = { type: string; tables: string[] }[]

/** 三类主要判定的颜色小圆点（未知另外用灰色展示） */
const CATEGORY_DOT: Record<string, string> = {
  命中: "bg-emerald-500",
  相关: "bg-amber-500",
  错误: "bg-red-500",
  未知: "bg-slate-400",
}

export function TypeStatsPage({ dataUser = "" }: { dataUser?: string }) {
  const [typeGroups, setTypeGroups] = useState<TypeGroups>([])
  const [loading, setLoading] = useState(true) // 类型分组加载中
  const [loadError, setLoadError] = useState("")
  const [selected, setSelected] = useState<string[]>([]) // 已勾选加入对比的表
  const [compare, setCompare] = useState<CompareResult | null>(null)
  const [comparing, setComparing] = useState(false) // 对比统计加载中
  const [onlyDiff, setOnlyDiff] = useState(false) // 只看不一致开关

  const userParam = dataUser ? `&user=${encodeURIComponent(dataUser)}` : ""

  /** 加载类型分组清单 */
  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/type-stats?_=${Date.now()}${userParam}`)
        const data = await res.json()
        if (!data.ok) throw new Error(data.error || "获取数据表失败")
        setTypeGroups(data.typeGroups)
      } catch (err) {
        console.error("[对比全览] 加载失败:", err)
        setLoadError(String(err instanceof Error ? err.message : err))
        toast.error("获取数据表失败", { description: String(err) })
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [userParam])

  /** 勾选/取消一张表 */
  function toggleTable(table: string) {
    setSelected((prev) =>
      prev.includes(table) ? prev.filter((t) => t !== table) : [...prev, table],
    )
  }

  /** 计算对比统计（选中表变化时自动触发） */
  const fetchCompare = useCallback(
    async (tables: string[]) => {
      if (tables.length === 0) {
        setCompare(null)
        return
      }
      setComparing(true)
      try {
        const params = new URLSearchParams({ tables: tables.join(",") })
        if (dataUser) params.set("user", dataUser)
        const res = await fetch(`/api/type-stats?${params.toString()}`)
        const data = await res.json()
        if (!data.ok) throw new Error(data.error || "对比统计失败")
        setCompare(data.result)
      } catch (err) {
        console.error("[对比全览] 对比失败:", err)
        toast.error("对比统计失败", { description: String(err) })
        setCompare(null)
      } finally {
        setComparing(false)
      }
    },
    [dataUser],
  )

  useEffect(() => {
    fetchCompare(selected)
  }, [selected, fetchCompare])

  /** 过滤后的对比行（只看不一致） */
  const displayRows = useMemo(() => {
    if (!compare) return []
    return onlyDiff
      ? compare.rows.filter((r) => compare.inconsistentJiraIds.includes(r.jira_id))
      : compare.rows
  }, [compare, onlyDiff])

  // ---------- 加载中 / 出错占位 ----------
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-lg text-muted-foreground">
        <Loader2 className="mr-3 size-6 animate-spin" /> 正在读取数据表…
      </div>
    )
  }
  if (loadError) {
    return (
      <div className="mx-auto max-w-xl py-24 text-center">
        <p className="text-xl font-medium">无法显示对比全览</p>
        <p className="mt-2 text-base text-muted-foreground">{loadError}</p>
        <Link href="/" className={buttonVariants({ variant: "outline", className: "mt-8" })}>
          <ArrowLeft className="size-5" />
          返回列表
        </Link>
      </div>
    )
  }

  return (
    <div className="min-h-screen w-full px-6 py-8 lg:px-10">
      {/* 顶部导航 */}
      <div className="mb-6 flex items-center justify-between gap-3">
        <Link href="/" className={buttonVariants({ variant: "ghost", size: "sm", className: "-ml-2" })}>
          <ArrowLeft className="size-5" />
          返回列表
        </Link>
        <span className="text-base text-muted-foreground">同Skill结果对比全览</span>
      </div>

      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">同Skill结果对比全览</h1>
        <p className="mt-3 max-w-4xl text-base leading-relaxed text-muted-foreground">
          统计口径：每条 JIRA 若有人工评审结果，直接采用人工评审状态；若无人工评审结果，则采用大模型判定结果。
          勾选多张表后按 Jira ID 对齐，逐行对比各表判定是否一致。
        </p>
      </header>

      {/* ========== 表选择区：按类型分组，勾选加入/删除对比 ========== */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle className="text-xl">选择要对比的数据表</CardTitle>
          <CardDescription className="text-base">
            按类型分组列出全部数据表；至少勾选 1 张即可自动开始对比，取消勾选即从对比中删除。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {typeGroups.length === 0 && (
            <p className="py-4 text-center text-base text-muted-foreground">
              暂无数据表，请先在列表页导入 xlsx 文件
            </p>
          )}
          {typeGroups.map((group) => (
            <div key={group.type} className="space-y-3">
              <p className="flex items-center gap-2 text-lg font-semibold">
                <span className="rounded-md bg-muted px-2 py-0.5 font-mono text-base">{group.type}</span>
                <span className="text-sm font-normal text-muted-foreground">
                  {group.tables.length} 张表
                </span>
              </p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {group.tables.map((t) => (
                  <label
                    key={t}
                    className="flex cursor-pointer items-center gap-3 rounded-lg border border-border px-4 py-3 text-base transition-colors hover:bg-muted/50 has-[:checked]:border-primary has-[:checked]:bg-primary/5"
                  >
                    <input
                      type="checkbox"
                      className="size-5 accent-primary"
                      checked={selected.includes(t)}
                      onChange={() => toggleTable(t)}
                    />
                    <span className="break-all font-mono">{t}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* ========== 已选表对比区 ========== */}
      {selected.length === 0 ? (
        <p className="py-10 text-center text-lg text-muted-foreground">
          请先在上方便勾选至少一张数据表
        </p>
      ) : comparing ? (
        <div className="flex items-center justify-center gap-3 py-10 text-lg text-muted-foreground">
          <Loader2 className="size-6 animate-spin" /> 对比统计中…
        </div>
      ) : compare ? (
        <div className="space-y-8">
          {/* 每张表的判定汇总（只统计最终判定） */}
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {compare.tableStats.map((ts) => (
              <Card key={ts.table}>
                <CardHeader>
                  <CardTitle className="break-all font-mono text-lg">{ts.table}</CardTitle>
                  <CardDescription className="text-base">
                    共 {ts.total} 条 · 一致率参考见下方对比
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid grid-cols-4 gap-3">
                  {VERDICT_CATEGORIES.map((c) => (
                    <div key={c} className="rounded-lg bg-muted/50 p-3 text-center">
                      <p className="flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
                        <span className={`size-2.5 rounded-full ${CATEGORY_DOT[c]}`} />
                        {c}
                      </p>
                      <p className="mt-1 font-mono text-2xl font-semibold tabular-nums">
                        {ts.counts[c]}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatPercent(ts.total > 0 ? ts.counts[c] / ts.total : 0)}
                      </p>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))}
          </div>

          {/* 汇总说明 */}
          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-4 pt-6">
              <p className="text-lg">
                共对齐 <span className="font-mono text-2xl font-semibold">{compare.rows.length}</span> 个 Jira ID，
                其中判定不一致{" "}
                <span className="font-mono text-2xl font-semibold text-red-600">
                  {compare.inconsistentJiraIds.length}
                </span>{" "}
                条（一致 {compare.consistentCount} 条）
              </p>
              <label className="flex cursor-pointer items-center gap-3 text-lg">
                <input
                  type="checkbox"
                  className="size-5 accent-primary"
                  checked={onlyDiff}
                  onChange={(e) => setOnlyDiff(e.target.checked)}
                />
                只看判定不一致
              </label>
            </CardContent>
          </Card>

          {/* 按 jira_id 对齐的对比明细表 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">判定对比明细</CardTitle>
              <CardDescription className="text-base">
                列头为表名，单元格为该表对这条 Jira ID 的最终判定；「-」表示该表无此工单
              </CardDescription>
            </CardHeader>
            <CardContent>
              {displayRows.length === 0 ? (
                <p className="py-8 text-center text-lg text-muted-foreground">
                  {onlyDiff ? "所选表的判定全部一致，没有不一致记录" : "暂无数据"}
                </p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/50 hover:bg-muted/50">
                        <TableHead className="w-[180px] text-base font-semibold">Jira ID</TableHead>
                        {compare.tables.map((t) => (
                          <TableHead key={t} className="min-w-[160px] text-base font-semibold">
                            <span className="break-all font-mono">{t}</span>
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {displayRows.map((row) => {
                        const isDiff = compare.inconsistentJiraIds.includes(row.jira_id)
                        return (
                          <TableRow
                            key={row.jira_id}
                            className={`text-base ${isDiff ? "bg-red-50 dark:bg-red-950/30" : ""}`}
                          >
                            <TableCell className="font-mono text-base font-medium">
                              {row.jira_id}
                            </TableCell>
                            {row.cells.map((cell) => (
                              <TableCell key={cell.table} className="text-base">
                                {cell.verdict === "-" ? (
                                  <span className="text-muted-foreground">-</span>
                                ) : (
                                  <VerdictBadge value={cell.verdict === "未判定" ? "" : cell.verdict} />
                                )}
                              </TableCell>
                            ))}
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  )
}
