// ============================================================
// 顶部统一通知中心（挂在 AppNavbar 右侧）
// 作用：把全站所有「通知铃铛」集中到顶部导航栏的一个铃铛里：
//  1. 待审核（管理员）：Skill 上传审核 / 立即执行任务 / 指定时间任务，
//     可直接在面板内「通过 / 拒绝」，或跳转对应页面处理；
//     （普通用户显示自己提交的待审核项，可撤销上传）
//  2. 审核结果（所有用户）：Skill 上传审核的通过 / 拒绝结果，可「取消通知」。
// 铃铛徽标数字 = 待审核数 + 未读审核结果数；打开面板自动刷新，
// 每 60 秒定时刷新，保持计数与列表最新。
// ============================================================

"use client"

import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import Link from "next/link"
import { toast } from "sonner"
import { ArrowRight, Bell, Check, Clock, FileText, FileUp, Inbox, Loader2, RefreshCw, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

/** 审核结果通知（对应 GET /skills/notices） */
type NoticeItem = {
  id: string
  kind: string // approved | rejected
  skillName: string
  message: string
  createdAt: string
}

/** 待审核 Skill 上传（对应 GET /skills/reviews） */
type ReviewItem = {
  id: string
  skillName: string
  exists: boolean // 是否与已有 Skill 同名（通过后将覆盖）
  owner: string
  uploadedAt: string
}

/** 待审核立即执行任务（对应 GET /approvals 的 runs） */
type ApprovalRun = {
  id: string
  name: string
  owner: string
  skill: string
  skillOwner: string
  jql: string
  email: string
  maxIssues: number
  createdAt: string
}

/** 待审核指定时间任务（对应 GET /approvals 的 defs） */
type ApprovalDef = {
  id: string
  name: string
  owner: string
  skill: string
  jql: string
  email: string
  maxIssues: number
  runAt: string
  createdAt: string
}

/** 配置预览弹窗展示的字段项 */
type PreviewField = { label: string; value: string }

/** 分区渲染：标题 + 计数 + 内容 */
function Section({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: ReactNode
}) {
  return (
    <div className="border-b border-border last:border-b-0">
      <div className="flex items-center gap-1.5 bg-muted/40 px-3 py-1.5">
        <p className="text-xs font-medium text-muted-foreground">{title}</p>
        <span className="rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px]">{count}</span>
      </div>
      <div className="p-2">{children}</div>
    </div>
  )
}

export function NotificationCenter({
  username,
  isAdmin,
}: {
  username: string
  isAdmin: boolean
}) {
  const [open, setOpen] = useState(false)
  const [notices, setNotices] = useState<NoticeItem[]>([])
  const [reviews, setReviews] = useState<ReviewItem[]>([])
  const [runs, setRuns] = useState<ApprovalRun[]>([])
  const [defs, setDefs] = useState<ApprovalDef[]>([])
  const [loading, setLoading] = useState(false)
  const [actingKey, setActingKey] = useState("")
  // ---------- 配置预览 / 管理员审核弹窗 ----------
  const [previewItem, setPreviewItem] = useState<{ title: string; status: string; fields: PreviewField[] } | null>(null)
  const [reviewTarget, setReviewTarget] = useState<{
    kind: "run" | "def"
    accept: boolean
    item: ApprovalRun | ApprovalDef
  } | null>(null)
  const [reviewRemark, setReviewRemark] = useState("")
  const [reviewSubmitting, setReviewSubmitting] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  /**
   * 加载全部通知数据（并行请求，失败不影响其他数据源）。
   *  管理员：/approvals 取全部待审核（立即执行 runs + 指定时间 defs）；
   *  普通用户：从自己的任务列表中筛出 status=pending 的 runs，
   *  从自己的定时任务中筛出 review=pending 的 defs，展示「我的待审核」。
   */
  const loadAll = useCallback(async () => {
    try {
      const [nRes, rRes, aRes, tRes, sRes] = await Promise.all([
        fetch("/api/backend/skills/notices"),
        fetch("/api/backend/skills/reviews"),
        isAdmin ? fetch("/api/backend/approvals") : Promise.resolve(null),
        isAdmin
          ? Promise.resolve(null)
          : fetch("/api/backend/tasks?page=1&page_size=50"),
        isAdmin ? Promise.resolve(null) : fetch("/api/backend/scheduled-tasks"),
      ])
      const [nData, rData, aData, tData, sData] = await Promise.all([
        nRes.json(),
        rRes.json(),
        aRes ? aRes.json() : Promise.resolve(null),
        tRes ? tRes.json() : Promise.resolve(null),
        sRes ? sRes.json() : Promise.resolve(null),
      ])
      if (nData?.ok) setNotices(nData.data || [])
      if (rData?.ok) setReviews(rData.data || [])
      if (aData?.ok) {
        setRuns(aData.runs || [])
        setDefs(aData.defs || [])
      } else {
        setRuns((tData?.tasks || []).filter((t: { status?: string }) => t.status === "pending"))
        setDefs((sData?.data || []).filter((d: { review?: string }) => d.review === "pending"))
      }
    } catch (err) {
      console.error("[通知中心] 加载失败:", err)
    }
  }, [isAdmin])

  // 挂载 + 每次打开面板时刷新；每 60 秒轮询保持徽标计数最新
  useEffect(() => {
    loadAll()
    const id = setInterval(loadAll, 60_000)
    return () => clearInterval(id)
  }, [loadAll])

  // 点击面板外部区域时关闭；弹窗以 portal 挂到 document.body（不在面板内），
  // 弹窗打开期间暂停外点关闭，避免点击弹窗内部时误收起面板
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: MouseEvent) {
      if (previewItem || reviewTarget) return
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", onPointerDown)
    return () => document.removeEventListener("mousedown", onPointerDown)
  }, [open, previewItem, reviewTarget])

  /** 取消（读过）一条审核结果通知 */
  async function dismissNotice(id: string) {
    setActingKey(`notice:${id}`)
    try {
      const res = await fetch(`/api/backend/skills/notices/${encodeURIComponent(id)}/dismiss`, {
        method: "POST",
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "取消通知失败")
      await loadAll()
    } catch (err) {
      console.error("[通知中心] 取消通知失败:", err)
      toast.error("取消通知失败", { description: String(err) })
    } finally {
      setActingKey("")
    }
  }

  /** 审核 Skill 上传（管理员：approve / reject） */
  async function reviewSkill(id: string, skillName: string, approve: boolean) {
    if (!approve && !window.confirm(`确定拒绝 Skill「${skillName}」的上传吗？暂存内容将被丢弃。`)) {
      return
    }
    setActingKey(`skill:${id}`)
    try {
      const res = await fetch(
        `/api/backend/skills/reviews/${encodeURIComponent(id)}/${approve ? "approve" : "reject"}`,
        { method: "POST" }
      )
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "审核失败")
      toast.success(approve ? "已通过 Skill 审核" : "已拒绝 Skill 上传")
      await loadAll()
    } catch (err) {
      console.error("[通知中心] Skill 审核失败:", err)
      toast.error("Skill 审核失败", { description: String(err) })
    } finally {
      setActingKey("")
    }
  }

  /** 撤销上传（审核通过前，仅该上传的 owner 可操作） */
  async function withdrawSkill(id: string, skillName: string) {
    if (!window.confirm(`确定撤销 Skill「${skillName}」的上传吗？暂存内容将被丢弃。`)) return
    setActingKey(`skill:${id}`)
    try {
      const res = await fetch(`/api/backend/skills/reviews/${encodeURIComponent(id)}/withdraw`, {
        method: "POST",
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "撤回失败")
      toast.success("已撤销上传", { description: `「${skillName}」的暂存内容已丢弃` })
      await loadAll()
    } catch (err) {
      console.error("[通知中心] 撤销上传失败:", err)
      toast.error("撤销上传失败", { description: String(err) })
    } finally {
      setActingKey("")
    }
  }

  /** 把任务条目组装为「完整配置」字段列表，供预览 / 审核弹窗展示 */
  function taskConfigFields(item: {
    name?: string
    owner?: string
    skill?: string
    skillOwner?: string
    jql?: string
    maxIssues?: number | null
    email?: string
    runAt?: string
    createdAt?: string
    mode?: string
  }): PreviewField[] {
    const maxIssues = item.maxIssues ?? 0
    return [
      { label: "任务名称", value: item.name || "-" },
      { label: "提交人", value: item.owner || "-" },
      { label: "Skill", value: item.skill || "-" },
      { label: "Skill Owner", value: item.skillOwner || "-" },
      { label: "JQL 查询语句", value: item.jql || "-" },
      { label: "最大处理条数", value: String(maxIssues) + (maxIssues === 0 ? "（全量）" : "") },
      { label: "通知邮箱", value: item.email || "-" },
      {
        label: "启动时间选择",
        value:
          item.mode === "once"
            ? `指定时间（${item.runAt || "-"}）`
            : item.mode === "cron"
            ? "周期执行"
            : item.mode === "immediate"
            ? "立即执行"
            : item.runAt
            ? `指定时间（${item.runAt}）`
            : "立即执行",
      },
      { label: "创建时间", value: item.createdAt || "-" },
    ]
  }

  /** 打开管理员审核弹窗（配置预览 + 备注输入 + 通过/拒绝） */
  function openReviewModal(kind: "run" | "def", item: ApprovalRun | ApprovalDef, accept: boolean) {
    setReviewRemark("")
    setReviewTarget({ kind, accept, item })
  }

  /** 管理员提交审核（通过 / 拒绝），可附备注，备注随结果通知发给申请人 */
  async function submitReview() {
    if (!reviewTarget) return
    const { kind, accept: isAccept, item } = reviewTarget
    setActingKey(`${kind}:${item.id}`)
    setReviewSubmitting(true)
    try {
      const res = await fetch(
        `/api/backend/approvals/${kind}/${encodeURIComponent(item.id)}/${isAccept ? "accept" : "reject"}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ remark: reviewRemark.trim() }),
        }
      )
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "审核失败")
      toast.success(isAccept ? "已通过审核" : "已拒绝执行", {
        description: reviewRemark.trim() ? "已通知申请人并附带备注" : undefined,
      })
      setReviewTarget(null)
      setReviewRemark("")
      await loadAll()
    } catch (err) {
      console.error("[通知中心] 任务审核失败:", err)
      toast.error("审核失败", { description: String(err) })
    } finally {
      setReviewSubmitting(false)
      setActingKey("")
    }
  }

  /** 回撤待审核任务（审核通过前，仅创建者本人可操作）。立即执行任务走 DELETE /tasks/<id>，指定时间任务走 DELETE /scheduled-tasks/<id> */
  async function withdrawTask(kind: "run" | "def", id: string, name: string) {
    const label = kind === "run" ? "立即执行任务" : "指定时间任务"
    if (!window.confirm(`确定回撤${label}「${name}」的提交吗？回撤后将不再等待审核。`)) return
    setActingKey(`withdraw:${kind}:${id}`)
    try {
      const res = await fetch(
        kind === "run"
          ? `/api/backend/tasks/${encodeURIComponent(id)}`
          : `/api/backend/scheduled-tasks/${encodeURIComponent(id)}`,
        { method: "DELETE" }
      )
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "回撤失败")
      toast.success("已回撤任务", { description: `「${name}」已撤销，不再等待审核` })
      await loadAll()
    } catch (err) {
      console.error("[通知中心] 回撤任务失败:", err)
      toast.error("回撤任务失败", { description: String(err) })
    } finally {
      setActingKey("")
    }
  }

  /** 徽标总数：待审核 + 未读审核结果 */
  const badgeCount = notices.length + reviews.length + runs.length + defs.length

  /** 通用「通过/拒绝」操作按钮组 */
  function ReviewButtons({
    prefix,
    id,
    skippable,
    onApprove,
    onReject,
  }: {
    prefix: string
    id: string
    skippable?: boolean
    onApprove: () => void
    onReject: () => void
  }) {
    return (
      <div className="flex shrink-0 items-center gap-1">
        <Button
          size="xs"
          variant="outline"
          className="border-green-600 text-green-600 hover:bg-green-600 hover:text-white"
          disabled={actingKey !== "" && actingKey !== `${prefix}:${id}`}
          onClick={onApprove}
        >
          {actingKey === `${prefix}:${id}` ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Check className="size-3" />
          )}
          通过
        </Button>
        {!skippable && (
          <Button
            size="xs"
            variant="outline"
            className="border-destructive text-destructive hover:bg-destructive hover:text-white"
            disabled={actingKey !== "" && actingKey !== `${prefix}:${id}`}
            onClick={onReject}
          >
            {actingKey === `${prefix}:${id}` ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <X className="size-3" />
            )}
            拒绝
          </Button>
        )}
      </div>
    )
  }

  /** 空状态提示 */
  function Empty({ text }: { text: string }) {
    return (
      <p className="px-2 py-4 text-center text-xs text-muted-foreground">
        <Inbox className="mx-auto mb-1 size-4 opacity-50" />
        {text}
      </p>
    )
  }

  return (
    <div ref={rootRef} className="relative">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="通知中心"
        aria-expanded={open}
        className="relative"
        onClick={() => {
          setOpen((v) => !v)
          loadAll()
        }}
      >
        <Bell className="size-4" />
        {badgeCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-destructive text-[10px] font-semibold text-white">
            {badgeCount > 9 ? "9+" : badgeCount}
          </span>
        )}
      </Button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[min(28rem,calc(100vw-1.5rem))] animate-in fade-in-0 zoom-in-95 rounded-xl border border-border bg-card shadow-xl">
          {/* 面板头部 */}
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <Bell className="size-4 text-muted-foreground" />
              通知中心
            </p>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="刷新"
                disabled={loading}
                onClick={() => {
                  setLoading(true)
                  loadAll().finally(() => setLoading(false))
                }}
              >
                <RefreshCw className={cn("size-4", loading && "animate-spin")} />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="关闭"
                onClick={() => setOpen(false)}
              >
                <X className="size-4" />
              </Button>
            </div>
          </div>

          {/* 面板内容滚动区 */}
          <div className="max-h-[min(70vh,32rem)] overflow-auto p-0">
            {/* ---------- 待审核（管理员） / 我的待审核（普通用户） ---------- */}
            <Section title={isAdmin ? "待审核" : "我的待审核"} count={reviews.length + runs.length + defs.length}>
              {!isAdmin && reviews.length === 0 && runs.length === 0 && defs.length === 0 && (
                <Empty text="暂无等待审核的提交" />
              )}
              {isAdmin && reviews.length === 0 && runs.length === 0 && defs.length === 0 && (
                <Empty text="暂无待审核内容" />
              )}

              {/* Skill 上传审核 */}
              {reviews.map((rv) => (
                <div
                  key={`skill:${rv.id}`}
                  className="mb-1.5 flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-2.5 py-2 last:mb-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 text-xs font-medium leading-tight text-foreground">
                      <FileUp className="size-3.5 shrink-0 text-sky-500" />
                      <span className="truncate">{rv.skillName}</span>
                    </p>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                      Skill 上传审核
                      {rv.exists && <Badge className="ml-1.5 bg-yellow-500/15 text-yellow-700 dark:text-yellow-400">同名将覆盖</Badge>}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      上传者：{rv.owner} · {rv.uploadedAt}
                    </p>
                    {rv.owner !== username && (
                      <Link
                        href="/skills"
                        className="mt-1 inline-flex items-center gap-0.5 text-[11px] font-medium text-primary hover:underline"
                      >
                        发起审核：Skill 管理 <ArrowRight className="size-3" />
                      </Link>
                    )}
                  </div>
                  {isAdmin ? (
                    <ReviewButtons
                      prefix="skill"
                      id={rv.id}
                      onApprove={() => reviewSkill(rv.id, rv.skillName, true)}
                      onReject={() => reviewSkill(rv.id, rv.skillName, false)}
                    />
                  ) : rv.owner === username ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={actingKey !== "" && actingKey !== `skill:${rv.id}`}
                      onClick={() => withdrawSkill(rv.id, rv.skillName)}
                    >
                      {actingKey === `skill:${rv.id}` ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <X className="size-3" />
                      )}
                      撤销
                    </Button>
                  ) : null}
                </div>
              ))}

              {/* 立即执行任务（普通用户：自己的待审核任务） */}
              {!isAdmin &&
                runs.map((r) => (
                  <div
                    key={`run:${r.id}`}
                    className="mb-1.5 flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-2.5 py-2 last:mb-0"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium leading-tight text-foreground">{r.name || "-"}</p>
                      <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                        立即执行任务 · Skill：{r.skill || "-"}
                        <Badge className="ml-1.5 bg-yellow-500/15 text-yellow-700 dark:text-yellow-400">待审核</Badge>
                      </p>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">JQL：{r.jql}</p>
                      <p className="text-[11px] text-muted-foreground">提交于 {r.createdAt}</p>
                      <Link
                        href="/tasks"
                        className="mt-1 inline-flex items-center gap-0.5 text-[11px] font-medium text-primary hover:underline"
                      >
                        发起审核：任务管理 <ArrowRight className="size-3" />
                      </Link>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() =>
                          setPreviewItem({
                            title: r.name || "未命名任务",
                            status: "待审核",
                            fields: taskConfigFields({ ...r }),
                          })
                        }
                      >
                        <FileText className="size-3" />
                        预览配置
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={actingKey !== "" && actingKey !== `withdraw:run:${r.id}`}
                        onClick={() => withdrawTask("run", r.id, r.name || "未命名任务")}
                      >
                        {actingKey === `withdraw:run:${r.id}` ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <X className="size-3" />
                        )}
                        回撤
                      </Button>
                    </div>
                  </div>
                ))}

              {/* 指定时间任务（普通用户：自己的待审核定义） */}
              {!isAdmin &&
                defs.map((d) => (
                  <div
                    key={`def:${d.id}`}
                    className="mb-1.5 flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-2.5 py-2 last:mb-0"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium leading-tight text-foreground">{d.name || "-"}</p>
                      <p className="mt-0.5 flex items-center gap-1 text-[11px] leading-relaxed text-muted-foreground">
                        <Clock className="size-3" />
                        指定时间任务 · Skill：{d.skill || "-"} · {d.runAt}
                        <Badge className="ml-1 bg-yellow-500/15 text-yellow-700 dark:text-yellow-400">待审核</Badge>
                      </p>
                      <p className="text-[11px] text-muted-foreground">提交于 {d.createdAt}</p>
                      <Link
                        href="/tasks"
                        className="mt-1 inline-flex items-center gap-0.5 text-[11px] font-medium text-primary hover:underline"
                      >
                        发起审核：任务管理 <ArrowRight className="size-3" />
                      </Link>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() =>
                          setPreviewItem({
                            title: d.name || "未命名任务",
                            status: "待审核",
                            fields: taskConfigFields({ ...d, mode: "once" }),
                          })
                        }
                      >
                        <FileText className="size-3" />
                        预览配置
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={actingKey !== "" && actingKey !== `withdraw:def:${d.id}`}
                        onClick={() => withdrawTask("def", d.id, d.name || "未命名任务")}
                      >
                        {actingKey === `withdraw:def:${d.id}` ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <X className="size-3" />
                        )}
                        回撤
                      </Button>
                    </div>
                  </div>
                ))}

              {/* 立即执行任务（管理员） */}
              {isAdmin &&
                runs.map((r) => (
                  <div
                    key={`run:${r.id}`}
                    className="mb-1.5 flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-2.5 py-2 last:mb-0"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium leading-tight text-foreground">{r.name || "-"}</p>
                      <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                        立即执行任务 · Skill：{r.skill || "-"}
                      </p>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">JQL：{r.jql}</p>
                      <p className="text-[11px] text-muted-foreground">
                        提交人：{r.owner} · {r.createdAt}
                      </p>
                      <Link
                        href="/tasks"
                        className="mt-1 inline-flex items-center gap-0.5 text-[11px] font-medium text-primary hover:underline"
                      >
                        发起审核：任务管理 <ArrowRight className="size-3" />
                      </Link>
                    </div>
                    <ReviewButtons
                      prefix="run"
                      id={r.id}
                      onApprove={() => openReviewModal("run", r, true)}
                      onReject={() => openReviewModal("run", r, false)}
                    />
                  </div>
                ))}

              {/* 指定时间任务（管理员） */}
              {isAdmin &&
                defs.map((d) => (
                  <div
                    key={`def:${d.id}`}
                    className="mb-1.5 flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-2.5 py-2 last:mb-0"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium leading-tight text-foreground">{d.name || "-"}</p>
                      <p className="mt-0.5 flex items-center gap-1 text-[11px] leading-relaxed text-muted-foreground">
                        <Clock className="size-3" />
                        指定时间任务 · Skill：{d.skill || "-"} · {d.runAt}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        提交人：{d.owner} · {d.createdAt}
                      </p>
                      <Link
                        href="/tasks"
                        className="mt-1 inline-flex items-center gap-0.5 text-[11px] font-medium text-primary hover:underline"
                      >
                        发起审核：任务管理 <ArrowRight className="size-3" />
                      </Link>
                    </div>
                    <ReviewButtons
                      prefix="def"
                      id={d.id}
                      onApprove={() => openReviewModal("def", d, true)}
                      onReject={() => openReviewModal("def", d, false)}
                    />
                  </div>
                ))}

            </Section>

            {/* ---------- 审核结果（所有用户） ---------- */}
            <Section title="审核结果" count={notices.length}>
              {notices.length === 0 ? (
                <Empty text="暂无审核结果" />
              ) : (
                notices.map((n) => (
                  <div
                    key={`notice:${n.id}`}
                    className="mb-1.5 flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-2.5 py-2 last:mb-0"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-xs leading-relaxed text-foreground">{n.message}</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">{n.createdAt}</p>
                    </div>
                    <Button
                      size="xs"
                      variant="outline"
                      className="shrink-0"
                      disabled={actingKey !== "" && actingKey !== `notice:${n.id}`}
                      onClick={() => dismissNotice(n.id)}
                    >
                      {actingKey === `notice:${n.id}` && <Loader2 className="size-3 animate-spin" />}
                      取消通知
                    </Button>
                  </div>
                ))
              )}
            </Section>

            {/* ---------- 底部说明 ---------- */}
            <div className="flex items-center justify-between border-t border-border bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground">
              <span>每 60 秒自动刷新</span>
              {isAdmin ? (
                <span>待审核需管理员处理</span>
              ) : (
                <span>提交后需管理员审核通过方可执行</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 渲染到 document.body：Header 的 transform 会创建 containing block，fixed 弹窗必须脱离它才能相对视口居中 */}
      {typeof document !== "undefined" &&
        createPortal(
          <Fragment>
      {/* ===== 任务配置预览弹窗（申请人 / 管理员均可查看完整配置） ===== */}
      {previewItem && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
          onClick={() => setPreviewItem(null)}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-card shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <FileText className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">任务配置：{previewItem.title}</span>
                {previewItem.status && (
                  <span className="text-xs text-muted-foreground">（{previewItem.status}）</span>
                )}
              </div>
              <Button size="sm" variant="ghost" onClick={() => setPreviewItem(null)}>
                关闭
              </Button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              <div className="grid grid-cols-1 gap-x-6 gap-y-3 md:grid-cols-2">
                {previewItem.fields.map((f) => (
                  <div key={f.label} className="space-y-0.5">
                    <p className="text-xs text-muted-foreground">{f.label}</p>
                    <p className="break-all text-sm">{f.value}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ===== 管理员审核弹窗（配置预览 + 备注 + 通过/拒绝） ===== */}
      {reviewTarget && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
          onClick={() => setReviewTarget(null)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-card shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                {reviewTarget.accept ? (
                  <Check className="size-4 text-green-600" />
                ) : (
                  <X className="size-4 text-destructive" />
                )}
                <span className="text-sm font-medium">
                  {reviewTarget.accept ? "通过审核" : "拒绝执行"}：{reviewTarget.item.name || "未命名任务"}
                </span>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setReviewTarget(null)} disabled={reviewSubmitting}>
                关闭
              </Button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              <p className="mb-2 text-xs font-medium text-muted-foreground">任务完整配置</p>
              <div className="grid grid-cols-1 gap-x-6 gap-y-3 rounded-lg border border-border bg-muted/30 p-3 md:grid-cols-2">
                {taskConfigFields({
                  ...reviewTarget.item,
                  mode: reviewTarget.kind === "def" ? "once" : "immediate",
                }).map((f) => (
                  <div key={f.label} className="space-y-0.5">
                    <p className="text-xs text-muted-foreground">{f.label}</p>
                    <p className="break-all text-sm">{f.value}</p>
                  </div>
                ))}
              </div>
              <div className="mt-4 space-y-1.5">
                <Label htmlFor="notice-review-remark">审核备注（可选，随结果通知发送给申请人）</Label>
                <Textarea
                  id="notice-review-remark"
                  value={reviewRemark}
                  onChange={(e) => setReviewRemark(e.target.value)}
                  placeholder="例如：JQL 范围过大请确认后重新提交；或：已通过，稍后调度执行"
                  className="min-h-20 text-sm"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
              <Button variant="outline" onClick={() => setReviewTarget(null)} disabled={reviewSubmitting}>
                取消
              </Button>
              <Button
                variant={reviewTarget.accept ? "default" : "destructive"}
                onClick={submitReview}
                disabled={reviewSubmitting}
              >
                {reviewSubmitting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : reviewTarget.accept ? (
                  <Check className="size-4" />
                ) : (
                  <X className="size-4" />
                )}
                确认{reviewTarget.accept ? "通过" : "拒绝"}
              </Button>
            </div>
          </div>
        </div>
          )}
          </Fragment>,
          document.body
        )}
    </div>
  )
}