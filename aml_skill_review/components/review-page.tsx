// ============================================================
// 详情评审页组件（第三部分）
// 作用：展示单条工单的完整分析内容，并提供人工判定表单，
// 保存后把 human_judge / human_judge_reason 写回数据库。
// 页面结构从上到下：标题(Jira ID 超链接) → Summary →
// 一行（左 Description ｜ 右 Root Cause + How to Fix）→
// 大模型判定 → 根因总结|Skill Final 双卡片 → 判定原因 →
// 底部固定的人工评审操作行。
// ============================================================

"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { ArrowLeft, BarChart3, ChevronLeft, ChevronRight, ExternalLink, FileText, GripHorizontal, Loader2, Save, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { VerdictBadge } from "@/components/verdict-badge"

/** Jira 工单详情页网址前缀（Jira ID 拼接在后面） */
const JIRA_BASE_URL = "https://jira.amlogic.com/browse"

/** 人工判定的固定选项（与大模型判定枚举保持一致） */
const HUMAN_JUDGE_OPTIONS = ["命中根因", "相关", "错误", "未知"]

/**
 * 「未判定」选项的内部值。
 * 作用：下拉框里选中「未判定」时用它做标记，保存时转换成空字符串写库，
 * 相当于把这条工单的人工评审清空、恢复成未判定状态。
 */
const HUMAN_UNJUDGED_VALUE = "__CLEAR__"

/** 数据库行类型 */
type Row = Record<string, string | null>

/**
 * 只读字段展示块。
 * 作用：统一渲染「字段名 + 内容」的小节，内容为空时显示「（无内容）」。
 * 标题字体与 Description 等卡片标题保持一致（text-sm 加粗）。
 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-semibold">{label}</p>
      <div className="text-sm leading-relaxed">{children}</div>
    </div>
  )
}

/**
 * 可滚动的长文本卡片（普通文本模式）。
 * 作用：Description、根因总结这类可能很长的内容，
 * 高度由外部容器决定，超出部分在卡片内部滚动。
 */
function ScrollBox({ title, text, contentClassName = "" }: { title: string; text: string; contentClassName?: string }) {
  return (
    <Card className="flex min-h-0 flex-col h-full">
      <CardHeader className="pb-2 shrink-0">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 p-4">
        <div className={`h-full overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground ${contentClassName}`}>
          {text || "（无内容）"}
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * 可滚动的 Markdown 渲染卡片。
 * 作用：Skill Final 这类 Markdown 格式内容的渲染显示。
 * 使用 ReactMarkdown 的 components 属性手动指定每种元素的样式，
 * 不依赖 @tailwindcss/typography 插件，避免额外安装依赖。
 */
function MarkdownBox({ title, text, contentClassName = "", titleExtra }: { title: string; text: string; contentClassName?: string; titleExtra?: React.ReactNode }) {
  return (
    <Card className="flex min-h-0 flex-col h-full">
      <CardHeader className="pb-2 shrink-0">
        <CardTitle className="flex items-center gap-2 text-sm">
          {title}
          {titleExtra}
        </CardTitle>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 p-4">
        <div className={`h-full overflow-y-auto text-sm leading-relaxed text-muted-foreground space-y-3 ${contentClassName}`}>
          {text ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                h1: (props) => <h1 className="text-xl font-bold text-foreground mt-4 mb-2 border-b pb-1" {...props} />,
                h2: (props) => <h2 className="text-lg font-bold text-foreground mt-4 mb-2 border-b pb-1" {...props} />,
                h3: (props) => <h3 className="text-base font-semibold text-foreground mt-3 mb-2" {...props} />,
                h4: (props) => <h4 className="text-sm font-semibold text-foreground mt-3 mb-1" {...props} />,
                h5: (props) => <h5 className="text-sm font-semibold text-foreground mt-2 mb-1" {...props} />,
                h6: (props) => <h6 className="text-sm font-semibold text-foreground mt-2 mb-1" {...props} />,
                p: (props) => <p className="my-2 whitespace-pre-wrap break-words" {...props} />,
                a: (props) => <a className="text-blue-600 underline hover:text-blue-800" target="_blank" rel="noreferrer" {...props} />,
                strong: (props) => <strong className="font-bold text-foreground" {...props} />,
                em: (props) => <em className="italic text-foreground" {...props} />,
                ul: (props) => <ul className="list-disc pl-6 my-2 space-y-1" {...props} />,
                ol: (props) => <ol className="list-decimal pl-6 my-2 space-y-1" {...props} />,
                li: (props) => <li className="marker:text-muted-foreground" {...props} />,
                blockquote: (props) => (
                  <blockquote className="border-l-4 border-border pl-4 italic my-3 text-muted-foreground/90" {...props} />
                ),
                hr: () => <hr className="my-4 border-border" />,
                code: ({ className, children, ...props }: React.HTMLAttributes<HTMLElement> & { className?: string; children?: React.ReactNode }) => {
                  const match = /language-(\w+)/.exec(className || "")
                  const isInline = !match
                  return isInline ? (
                    <code
                      className="bg-muted px-1.5 py-0.5 rounded text-pink-600 font-mono text-[0.9em] break-all"
                      {...props}
                    >
                      {children}
                    </code>
                  ) : (
                    <pre className="bg-muted rounded-lg p-3 my-3 overflow-x-auto font-mono text-xs leading-relaxed text-foreground">
                      <code className={`${className} block`} {...props}>
                        {children}
                      </code>
                    </pre>
                  )
                },
                pre: (props) => <pre className="bg-muted rounded-lg p-3 my-3 overflow-x-auto font-mono text-xs leading-relaxed" {...props} />,
                table: (props) => (
                  <div className="my-3 overflow-x-auto border border-border rounded">
                    <table className="min-w-full border-collapse text-xs" {...props} />
                  </div>
                ),
                thead: (props) => <thead className="bg-muted" {...props} />,
                tbody: (props) => <tbody className="divide-y divide-border" {...props} />,
                tr: (props) => <tr className="hover:bg-muted/50" {...props} />,
                th: (props) => (
                  <th className="px-3 py-2 text-left font-semibold text-foreground border-b border-border" {...props} />
                ),
                td: (props) => (
                  <td className="px-3 py-2 border-b border-border align-top" {...props} />
                ),
                img: (props) => <img className="max-w-full h-auto rounded my-2 border border-border" loading="lazy" {...props} />,
                input: ({ type, checked, disabled }: React.InputHTMLAttributes<HTMLInputElement>) =>
                  type === "checkbox" ? (
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled ?? true}
                      className="mr-2 align-middle size-3.5 accent-primary"
                    />
                  ) : null,
                del: (props) => <del className="line-through text-muted-foreground/70" {...props} />,
              }}
            >
              {text}
            </ReactMarkdown>
          ) : (
            <p className="text-muted-foreground">（无内容）</p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export function ReviewPage({
  jiraId,
  table,
  verdictFilter = "",
  humanFilter = "",
  dataUser = "",
}: {
  jiraId: string
  table: string
  verdictFilter?: string
  humanFilter?: string
  dataUser?: string
}) {
  const router = useRouter()

  // ---------- 页面状态 ----------
  const [row, setRow] = useState<Row | null>(null) // 当前工单数据
  const [loading, setLoading] = useState(true) // 正在加载
  const [loadError, setLoadError] = useState("") // 加载失败原因
  const [saving, setSaving] = useState(false) // 正在保存

  // ---------- 根因总结 / Skill 分析结果 上下可拖动分割条状态 ----------
  const [topPanelHeight, setTopPanelHeight] = useState<number>(280) // 上方面板（根因总结）默认高度 px
  const containerRef = useRef<HTMLDivElement | null>(null)
  const isDraggingRef = useRef(false)

  // ---------- Skill 原始结果弹窗状态 ----------
  const [showRaw, setShowRaw] = useState(false) // 是否打开弹窗

  /**
   * 打开弹窗时锁定页面滚动，关闭时恢复。
   * 作用：避免弹窗背后内容跟着滚动，影响阅读体验。
   */
  useEffect(() => {
    document.body.style.overflow = showRaw ? "hidden" : ""
    return () => {
      document.body.style.overflow = ""
    }
  }, [showRaw])

  /**
   * 弹窗内按 Esc 关闭。
   */
  useEffect(() => {
    if (!showRaw) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setShowRaw(false)
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [showRaw])

  /** 鼠标按下分割条：开始拖动 */
  function handleSplitterMouseDown(e: React.MouseEvent) {
    e.preventDefault()
    isDraggingRef.current = true
    document.body.style.cursor = "row-resize"
    document.body.style.userSelect = "none"
    document.addEventListener("mousemove", handleSplitterMouseMove)
    document.addEventListener("mouseup", handleSplitterMouseUp)
  }

  /** 鼠标移动：根据垂直方向位移调整上方面板高度 */
  function handleSplitterMouseMove(e: MouseEvent) {
    if (!isDraggingRef.current || !containerRef.current) return
    const containerRect = containerRef.current.getBoundingClientRect()
    // 鼠标相对容器顶部的距离 = 上方面板高度（含分割条）
    let newHeight = e.clientY - containerRect.top - 4 // 减去 4px 分割条自身高度的一半
    // 限制高度范围：最小 120px，最大容器高度 - 120px（给下方面板留空间）
    const minH = 120
    const maxH = containerRect.height - minH - 8 // 8px 为分割条+边距
    if (newHeight < minH) newHeight = minH
    if (newHeight > maxH) newHeight = maxH
    setTopPanelHeight(newHeight)
  }

  /** 鼠标松开：结束拖动 */
  function handleSplitterMouseUp() {
    isDraggingRef.current = false
    document.body.style.cursor = ""
    document.body.style.userSelect = ""
    document.removeEventListener("mousemove", handleSplitterMouseMove)
    document.removeEventListener("mouseup", handleSplitterMouseUp)
  }

  // ---------- 过滤后的评审顺序（左右箭头切换用） ----------
  const [filteredIds, setFilteredIds] = useState<string[]>([])

  /**
   * 拉取「过滤后」的 Jira ID 顺序列表。
   * 作用：左右箭头只在进入评审页时的列表页过滤结果范围内切换，
   * 进入后列表保持不动（保存评审不会重新拉取）。
   */
  const loadFilteredIds = useCallback(async () => {
    if (!table) return
    try {
      const params = new URLSearchParams({ table, page: "1", pageSize: "5000" })
      if (verdictFilter) params.set("judgeVerdict", verdictFilter)
      if (humanFilter) params.set("humanJudge", humanFilter)
      if (dataUser) params.set("user", dataUser)
      const res = await fetch(`/api/rows?${params.toString()}`)
      const data = await res.json()
      if (!data.ok) return
      const ids = (data.rows || [])
        .map((r: Row) => String(r.jira_id ?? "").trim())
        .filter(Boolean)
      setFilteredIds(ids)
    } catch (err) {
      console.error("[详情页] 获取过滤后列表失败:", err)
    }
  }, [table, verdictFilter, humanFilter, dataUser])

  useEffect(() => {
    loadFilteredIds()
  }, [loadFilteredIds])

  // 当前工单在过滤后列表中的位置（-1 表示不在过滤范围内）
  const currentIndex = filteredIds.indexOf(jiraId)
  const totalCount = filteredIds.length

  /** 构造评审页链接（带上表名、数据所属用户和过滤条件，保证切换后范围一致） */
  function buildReviewUrl(id: string): string {
    const params = new URLSearchParams({ table })
    if (dataUser) params.set("user", dataUser)
    if (verdictFilter) params.set("v", verdictFilter)
    if (humanFilter) params.set("h", humanFilter)
    return `/review/${encodeURIComponent(id)}?${params.toString()}`
  }

  /** 左箭头（上一个）/ 右箭头（下一个），范围限定在过滤后列表内 */
  function gotoStep(dir: -1 | 1) {
    if (currentIndex < 0) return
    const next = currentIndex + dir
    if (next < 0 || next >= totalCount) return
    router.push(buildReviewUrl(filteredIds[next]))
    window.scrollTo({ top: 0 })
  }

  // ---------- 人工评审表单状态 ----------
  const [humanJudge, setHumanJudge] = useState<string>("") // 人工判定（默认未判定）
  const [humanReason, setHumanReason] = useState("") // 人工判定原因

  /**
   * 加载单条工单数据。
   * 作用：页面打开时按「表名 + Jira ID」请求 /api/row，
   * 并把已有的人工判定结果回显到表单里。
   */
  useEffect(() => {
    async function load() {
      if (!table) {
        setLoadError("缺少数据表参数，请从列表页的「详情」按钮进入本页")
        setLoading(false)
        return
      }
      try {
        const params = new URLSearchParams({ table, jiraId })
        if (dataUser) params.set("user", dataUser)
        const res = await fetch(`/api/row?${params.toString()}`)
        const data = await res.json()
        if (!data.ok) throw new Error(data.error || "查询详情失败")
        setRow(data.row)
        // 回显已有评审结果
        setHumanJudge(String(data.row.human_judge ?? "").trim())
        setHumanReason(String(data.row.human_judge_reason ?? ""))
        console.log(`[详情页] 加载工单 ${jiraId} 成功`)
      } catch (err) {
        console.error("[详情页] 加载失败:", err)
        setLoadError(String(err instanceof Error ? err.message : err))
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [jiraId, table])

  /**
   * 保存人工评审。
   * 作用：调用 /api/review 写库，成功后留在当前页并刷新本页状态。
   * 选择「未判定」时 humanJudge 为空字符串，会把数据库里的人工判定清空。
   */
  async function handleSave() {
    setSaving(true)
    try {
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          table,
          jiraId,
          humanJudge,
          humanJudgeReason: humanReason.trim(),
          // 管理员评审其他用户的工单时，数据写回该用户自己的库
          user: dataUser || undefined,
        }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "保存失败")
      console.log(`[详情页] 保存评审成功: ${jiraId} → ${humanJudge}`)
      toast.success("已保存", { description: `${jiraId} 的人工判定已写入数据库` })
      // 同步刷新页面上的「当前已评审」回显
      setRow((prev) =>
        prev
          ? { ...prev, human_judge: humanJudge || "", human_judge_reason: humanReason.trim() }
          : prev,
      )
    } catch (err) {
      console.error("[详情页] 保存失败:", err)
      toast.error("保存失败", { description: String(err) })
    } finally {
      setSaving(false)
    }
  }

  // ---------- 加载中 / 出错 / 找不到工单 的占位界面 ----------
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 size-5 animate-spin" /> 加载中…
      </div>
    )
  }
  if (loadError || !row) {
    return (
      <div className="mx-auto max-w-md py-24 text-center">
        <p className="text-lg font-medium">未找到该工单</p>
        <p className="mt-1 text-sm text-muted-foreground">{loadError || `Jira ID：${jiraId}`}</p>
        <Link href="/" className={buttonVariants({ variant: "outline", className: "mt-6" })}>
          <ArrowLeft className="size-4" />
          返回列表
        </Link>
      </div>
    )
  }

  return (
    <div className="w-full px-2 py-4 md:px-4">
      {/* 顶部导航：返回列表 / 统计页 */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <Link href="/" className={buttonVariants({ variant: "ghost", size: "sm", className: "-ml-2" })}>
          <ArrowLeft className="size-4" />
          返回列表
        </Link>
        <Link
          href={`/stats?table=${encodeURIComponent(table)}`}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          <BarChart3 className="size-4" />
          评审统计
        </Link>
      </div>

      {/* 1. 标题：Jira ID（超链接到 Jira 系统，字体与卡片标题统一） */}
      <h1 className="flex items-center gap-2 text-sm font-semibold">
        <a
          href={`${JIRA_BASE_URL}/${encodeURIComponent(jiraId)}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 hover:underline"
        >
          {jiraId}
          <ExternalLink className="size-4 text-muted-foreground" />
        </a>
      </h1>

      {/* 2. 第一行：Summary */}
      <p className="mt-3 text-base font-bold">{row.summary || "（无 Summary）"}</p>

      <div className="mt-6 space-y-6">
        {/* 3. 一行：左 Description ｜ 右 Root Cause + How to Fix */}
        <div className="grid items-stretch gap-4 md:grid-cols-2">
          {/* 左：Description（固定高度，过长内部滚动） */}
          <ScrollBox title="Description" text={String(row.description ?? "")} />
          {/* 右：Root Cause 与 How to Fix 上下堆叠，与左侧等高 */}
          <div className="flex min-h-0 flex-col gap-4">
            <Card className="flex min-h-0 flex-1 flex-col">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Root Cause</CardTitle>
              </CardHeader>
              <CardContent className="min-h-0 flex-1">
                <div className="max-h-24 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                  {row.root_cause || "（无内容）"}
                </div>
              </CardContent>
            </Card>
            <Card className="flex min-h-0 flex-1 flex-col">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">How to Fix</CardTitle>
              </CardHeader>
              <CardContent className="min-h-0 flex-1">
                <div className="max-h-24 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                  {row.how_to_fix || "（无内容）"}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* 4. 大模型判定（重点显示） */}
        <Card>
          <CardContent className="flex items-center justify-between pt-6">
            <p className="text-sm font-semibold">大模型判定</p>
            <span className="scale-125">
              <VerdictBadge value={row.judge_verdict} />
            </span>
          </CardContent>
        </Card>

        {/* 5. 上下堆叠：根因总结（上） | skill分析结果（skill final ）（下），中间可拖动分割条调整高度 */}
        <div
          ref={containerRef}
          className="flex flex-col gap-1 min-h-[560px] border border-border rounded-lg p-2 bg-card/30"
        >
          {/* 上方：根因总结，高度由 topPanelHeight state 控制 */}
          <div style={{ height: `${topPanelHeight}px` }} className="min-h-0 shrink-0">
            <ScrollBox
              title="根因总结（Judge Real Result）"
              text={String(row.judge_real_result ?? "")}
            />
          </div>

          {/* 中间：可拖动分割条 —— 鼠标按住上下拖动即可改变上下两部分高度 */}
          <div
            onMouseDown={handleSplitterMouseDown}
            className="h-2 shrink-0 -my-0.5 cursor-row-resize flex items-center justify-center group hover:bg-primary/20 active:bg-primary/30 transition-colors rounded"
            title="按住鼠标上下拖动，可调整两个面板的高度比例"
          >
            <div className="w-16 h-1 rounded-full bg-border group-hover:bg-primary/60 flex items-center justify-center transition-colors">
              <GripHorizontal className="size-3 text-muted-foreground group-hover:text-primary -my-1" />
            </div>
          </div>

          {/* 下方：skill分析结果（skill final ） Markdown 渲染，占剩余空间；
              标题旁的按钮可弹窗查看 skill 原始结果（纯文本，不渲染 Markdown） */}
          <div className="flex-1 min-h-0">
            <MarkdownBox
              title="skill分析结果（Skill Final ）"
              text={String(row.skill_final ?? "")}
              titleExtra={
                <button
                  type="button"
                  onClick={() => setShowRaw(true)}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs font-normal text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <FileText className="size-3.5" />
                  skill原始结果（含格式）
                </button>
              }
            />
          </div>
        </div>

        {/* Skill 原始结果弹窗：接近全屏，纯文本显示（保留原始格式，不做 Markdown 渲染） */}
        {showRaw && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 md:p-8"
            onMouseDown={(e) => {
              // 点击遮罩（弹窗内容以外）关闭
              if (e.target === e.currentTarget) setShowRaw(false)
            }}
          >
            <Card className="flex h-full max-h-[92vh] w-full max-w-[92vw] flex-col">
              <CardHeader className="flex shrink-0 flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-base">skill原始结果（含格式）</CardTitle>
                <Button variant="ghost" size="icon" title="关闭" onClick={() => setShowRaw(false)}>
                  <X className="size-4" />
                </Button>
              </CardHeader>
              <CardContent className="min-h-0 flex-1 p-4">
                <div className="h-full overflow-y-auto whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-muted-foreground">
                  {String(row.skill_raw ?? "") || "（无内容）"}
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* 6. 判定原因（整行） */}
        <Card>
          <CardContent className="pt-6">
            <Field label="判定原因（Judge Reason）">
              <p className="whitespace-pre-wrap">{row.judge_reason || "（无内容）"}</p>
            </Field>
          </CardContent>
        </Card>

        {/* 7. 评审操作行：固定在屏幕底部，随页面滚动跟随；
            滚动到页面最底部时会自然落回文档流位置，不会遮挡内容 */}
        <div className="sticky bottom-0 z-20 -mx-2 border-t border-border bg-background px-2 pb-2 pt-3 md:-mx-4 md:px-4">
          <Card className="border-primary/30">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-sm">人工评审</CardTitle>
                {/* 左右箭头：在过滤后的评审范围内切换上/下一个 */}
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    title="上一个评审"
                    onClick={() => gotoStep(-1)}
                    disabled={currentIndex <= 0}
                  >
                    <ChevronLeft className="size-4" />
                  </Button>
                  <span className="min-w-[70px] text-center text-xs text-muted-foreground">
                    {currentIndex >= 0 ? `${currentIndex + 1} / ${totalCount}` : "-"}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    title="下一个评审"
                    onClick={() => gotoStep(1)}
                    disabled={currentIndex < 0 || currentIndex >= totalCount - 1}
                  >
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end">
              {/* 左：人工判定下拉（默认未判定，选中「未判定」并保存可清空评审） */}
              <div className="w-full space-y-2 lg:w-48">
                <Label>人工判定</Label>
                <Select
                  value={humanJudge || HUMAN_UNJUDGED_VALUE}
                  onValueChange={(v) =>
                    setHumanJudge(String(v ?? "") === HUMAN_UNJUDGED_VALUE ? "" : String(v ?? ""))
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="未判定">
                      {(v) => (!v || v === HUMAN_UNJUDGED_VALUE ? "未判定" : String(v))}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={HUMAN_UNJUDGED_VALUE}>未判定</SelectItem>
                    {HUMAN_JUDGE_OPTIONS.map((v) => (
                      <SelectItem key={v} value={v}>
                        {v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* 中：人工判定原因输入框 */}
              <div className="min-w-0 flex-1 space-y-2">
                <Label>人工判定原因</Label>
                <Textarea
                  value={humanReason}
                  onChange={(e) => setHumanReason(e.target.value)}
                  placeholder="请填写判定理由…"
                  rows={3}
                />
              </div>

              {/* 右：保存按钮 */}
              <Button onClick={handleSave} disabled={saving} className="lg:mb-0.5">
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                保存
              </Button>
            </div>

            {/* 已有评审信息回显 */}
            {row.human_judge && (
              <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                当前已评审：<VerdictBadge value={row.human_judge} />
                {row.update_t && <span>· 最后更新 {row.update_t}</span>}
              </p>
            )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
