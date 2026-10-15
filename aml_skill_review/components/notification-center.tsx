// ============================================================
// 顶部统一通知中心（挂在 AppNavbar 右侧）
// 作用：把全站所有「通知铃铛」集中到顶部导航栏的一个铃铛里：
//  1. 待审批（管理员）：Skill 上传审核 / 立即执行任务 / 指定时间任务，
//     可直接在面板内「通过 / 拒绝」，或跳转对应页面处理；
//     （普通用户显示自己提交的待审核项，可撤销上传）
//  2. 审批结果（所有用户）：Skill 上传审核的通过 / 拒绝结果，可「取消通知」。
// 铃铛徽标数字 = 待审批数 + 未读审批结果数；打开面板自动刷新，
// 每 60 秒定时刷新，保持计数与列表最新。
// ============================================================

"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { ArrowRight, Bell, Check, Clock, FileUp, Inbox, Loader2, RefreshCw, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
  runAt: string
  createdAt: string
}

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
  const rootRef = useRef<HTMLDivElement>(null)

  /**
   * 加载全部通知数据（并行请求，失败不影响其他数据源）。
   *  管理员：/approvals 取全部待审批（立即执行 runs + 指定时间 defs）；
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

  // 点击面板外部区域时关闭
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", onPointerDown)
    return () => document.removeEventListener("mousedown", onPointerDown)
  }, [open])

  /** 取消（读过）一条审批结果通知 */
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

  /** 审核任务（管理员：approvals/runs|defs 的 accept / reject） */
  async function reviewApproval(kind: "run" | "def", id: string, accept: boolean) {
    setActingKey(`${kind}:${id}`)
    try {
      const res = await fetch(
        `/api/backend/approvals/${kind}/${encodeURIComponent(id)}/${accept ? "accept" : "reject"}`,
        { method: "POST" }
      )
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "审核失败")
      toast.success(accept ? "已通过任务审核" : "已拒绝任务执行")
      await loadAll()
    } catch (err) {
      console.error("[通知中心] 任务审核失败:", err)
      toast.error("任务审核失败", { description: String(err) })
    } finally {
      setActingKey("")
    }
  }

  /** 徽标总数：待审批 + 未读审批结果 */
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
            {/* ---------- 待审批（管理员） / 我的待审核（普通用户） ---------- */}
            <Section title={isAdmin ? "待审批" : "我的待审核"} count={reviews.length + runs.length + defs.length}>
              {!isAdmin && reviews.length === 0 && runs.length === 0 && defs.length === 0 && (
                <Empty text="暂无等待审核的提交" />
              )}
              {isAdmin && reviews.length === 0 && runs.length === 0 && defs.length === 0 && (
                <Empty text="暂无待审批内容" />
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
                    {!isAdmin && rv.owner !== username && (
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
                    </div>
                    <ReviewButtons
                      prefix="run"
                      id={r.id}
                      onApprove={() => reviewApproval("run", r.id, true)}
                      onReject={() => reviewApproval("run", r.id, false)}
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
                    </div>
                    <ReviewButtons
                      prefix="def"
                      id={d.id}
                      onApprove={() => reviewApproval("def", d.id, true)}
                      onReject={() => reviewApproval("def", d.id, false)}
                    />
                  </div>
                ))}

            </Section>

            {/* ---------- 审批结果（所有用户） ---------- */}
            <Section title="审批结果" count={notices.length}>
              {notices.length === 0 ? (
                <Empty text="暂无审批结果" />
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
                <span>待审批需管理员处理</span>
              ) : (
                <span>提交后需管理员审核通过方可执行</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}