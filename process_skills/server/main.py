# -*- coding: utf-8 -*-
"""
Skill 任务后端 —— FastAPI 应用。

启动::

    cd process_skills
    python -m uvicorn server.main:app --host 127.0.0.1 --port 12371

鉴权：仅接受 Next.js 代理转发来的请求：
    X-INTERNAL-TOKEN : 共享密钥（env SKILL_API_TOKEN 或 server_data/.api_token）
    X-USER           : 登录名
    X-IS-ADMIN       : "1" / "0"
"""
from __future__ import annotations

import io
import time
import zipfile
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import config, executor, skills_mgr, storage

# 进程环境变量优先，缺失的键从 skill_tests/.env 兜底加载（如 JIRA_BOT_* / SMTP_*）
config.load_env_file()

app = FastAPI(title="Skill Task Backend", version="1.0.0")


# ════════════════════════════════════════════════════════════════════════
# 鉴权依赖
# ════════════════════════════════════════════════════════════════════════
class Caller(BaseModel):
    username: str
    is_admin: bool


def auth(
    x_internal_token: str | None = Header(default=None),
    x_user: str | None = Header(default=None),
    x_is_admin: str | None = Header(default=None, alias="X-Is-Admin"),
) -> Caller:
    if not x_internal_token or x_internal_token != config.get_internal_token():
        raise HTTPException(status_code=401, detail="内部令牌无效")
    if not x_user:
        raise HTTPException(status_code=401, detail="缺少用户身份")
    return Caller(username=x_user, is_admin=(x_is_admin == "1"))


def admin_only(caller: Caller = Depends(auth)) -> Caller:
    if not caller.is_admin:
        raise HTTPException(status_code=403, detail="仅管理员")
    return caller


@app.on_event("startup")
def _startup() -> None:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    config.RUNS_DIR.mkdir(parents=True, exist_ok=True)
    # 启动即生成/读取内部 Token，保证 Next.js 侧随时能读到 token 文件
    config.get_internal_token()
    executor.start_scheduler()
    print(f"[server] SKILL_DIR_ROOT = {config.SKILL_DIR_ROOT}", flush=True)
    print(f"[server] 内部 Token 文件 = {config.TOKEN_FILE}", flush=True)


# ════════════════════════════════════════════════════════════════════════
# 健康检查
# ════════════════════════════════════════════════════════════════════════
@app.get("/api/backend/health")
def health() -> dict[str, Any]:
    return {"ok": True, "service": "skill-task-backend", "time": storage.now_str()}


# ════════════════════════════════════════════════════════════════════════
# Skill 管理
# ════════════════════════════════════════════════════════════════════════
@app.get("/api/backend/skills")
def api_list_skills(
    mine: bool = Query(False), caller: Caller = Depends(auth)
) -> dict[str, Any]:
    # mine=1 且非管理员时，只返回该用户负责的 Skill（新建任务下拉用）
    return {
        "ok": True,
        "data": skills_mgr.list_skills(caller.username, caller.is_admin, mine=mine),
    }


@app.get("/api/backend/skills/types")
def api_skill_types(caller: Caller = Depends(auth)) -> dict[str, Any]:
    return {"ok": True, "data": skills_mgr.list_skill_types()}


@app.get("/api/backend/skills/detail")
def api_skill_detail(path: str, caller: Caller = Depends(auth)) -> dict[str, Any]:
    detail = skills_mgr.get_skill_detail(path, caller.username, caller.is_admin)
    if not detail:
        raise HTTPException(status_code=404, detail="未找到 skill 或无权访问")
    return {"ok": True, "data": detail}


@app.delete("/api/backend/skills/delete")
def api_skill_delete(path: str, caller: Caller = Depends(admin_only)) -> dict[str, Any]:
    # 仅管理员可删除 Skill（普通用户只保留上传能力）
    if not skills_mgr.get_skill_detail(path, caller.username, caller.is_admin):
        raise HTTPException(status_code=404, detail="未找到 skill 或无权访问")
    skills_mgr.delete_skill(path)
    return {"ok": True}


class OwnerBody(BaseModel):
    path: str
    owner: str


@app.put("/api/backend/skills/owner")
def api_set_owner(body: OwnerBody, caller: Caller = Depends(admin_only)) -> dict[str, Any]:
    if not skills_mgr.set_skill_owner(body.path, body.owner.strip()):
        raise HTTPException(status_code=404, detail="skill 不存在")
    return {"ok": True}


@app.get("/api/backend/skills/files")
def api_skill_files(path: str, caller: Caller = Depends(auth)) -> dict[str, Any]:
    if not skills_mgr.get_skill_detail(path, caller.username, caller.is_admin):
        raise HTTPException(status_code=404, detail="未找到 skill 或无权访问")
    return {"ok": True, "data": skills_mgr.list_skill_files(path)}


@app.get("/api/backend/skills/content")
def api_skill_content(path: str, file: str, caller: Caller = Depends(auth)) -> dict[str, Any]:
    if not skills_mgr.get_skill_detail(path, caller.username, caller.is_admin):
        raise HTTPException(status_code=404, detail="未找到 skill 或无权访问")
    content = skills_mgr.read_skill_file(path, file)
    if content is None:
        raise HTTPException(status_code=404, detail="文件不存在或路径非法")
    return {"ok": True, "data": content}


@app.post("/api/backend/skills")
async def api_upload_skill(
    owner: str = Form(default=""),
    confirm_duplicate: str = Form(default=""),
    files: list[UploadFile] = File(...),
    caller: Caller = Depends(auth),
) -> dict[str, Any]:
    # 普通用户只能把 owner 设为自己；管理员可指定
    final_owner = owner.strip() if caller.is_admin else caller.username
    if not final_owner:
        final_owner = caller.username

    if not files:
        raise HTTPException(status_code=400, detail="请选择要上传的文件或文件夹")

    entries: list[tuple[str, bytes]] = []
    # 单个 zip → 解压；否则视为文件夹/多文件上传（保留相对路径）
    if len(files) == 1 and (files[0].filename or "").lower().endswith(".zip"):
        data = await files[0].read()
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                for member in zf.infolist():
                    if member.is_dir():
                        continue
                    name = member.filename.replace("\\", "/").strip("/")
                    if not name:
                        continue
                    entries.append((name, zf.read(member)))
        except zipfile.BadZipFile:
            raise HTTPException(status_code=400, detail="zip 文件损坏或格式不正确")
    else:
        for f in files:
            name = (f.filename or "").replace("\\", "/").strip("/")
            if not name:
                continue
            entries.append((name, await f.read()))

    try:
        result = skills_mgr.submit_upload(
            entries, final_owner, confirm=(confirm_duplicate.strip() == "1")
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if result.get("need_confirm"):
        # 存在同名 Skill：要求前端二次确认后带 confirm_duplicate=1 重传
        raise HTTPException(status_code=409, detail=f"已存在同名 Skill「{result['skill_name']}」，确认后将审核通过覆盖原 Skill")
    return {
        "ok": True,
        "data": {
            "skillPath": result["skill_name"],
            "exists": result["exists"],
            "status": "pending",
            "reviewId": result["id"],
        },
    }


# ---- Skill 上传审核（管理员通过/拒绝，普通用户查看自己的待审核项） ----
@app.get("/api/backend/skills/reviews")
def api_list_reviews(caller: Caller = Depends(auth)) -> dict[str, Any]:
    return {
        "ok": True,
        "data": skills_mgr.list_pending_uploads(caller.username, caller.is_admin),
    }


@app.post("/api/backend/skills/reviews/{review_id}/approve")
def api_approve_review(review_id: str, caller: Caller = Depends(admin_only)) -> dict[str, Any]:
    try:
        skill_name = skills_mgr.approve_upload(review_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="审核记录不存在")
    return {"ok": True, "data": {"skillPath": skill_name}}


@app.post("/api/backend/skills/reviews/{review_id}/reject")
def api_reject_review(review_id: str, caller: Caller = Depends(admin_only)) -> dict[str, Any]:
    try:
        skills_mgr.reject_upload(review_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="审核记录不存在")
    return {"ok": True}


@app.post("/api/backend/skills/reviews/{review_id}/withdraw")
def api_withdraw_review(review_id: str, caller: Caller = Depends(auth)) -> dict[str, Any]:
    """审核通过前撤销上传：仅该上传的 owner 或管理员可操作。"""
    if not skills_mgr.withdraw_upload(review_id, caller.username, caller.is_admin):
        raise HTTPException(status_code=404, detail="审核记录不存在或无权撤销")
    return {"ok": True}


@app.get("/api/backend/skills/reviews/{review_id}/files")
def api_review_files(review_id: str, caller: Caller = Depends(auth)) -> dict[str, Any]:
    """待审核 skill 的文件树（仅 owner 或管理员可见）。"""
    if not skills_mgr.can_view_review(review_id, caller.username, caller.is_admin):
        raise HTTPException(status_code=404, detail="审核记录不存在或无权访问")
    return {"ok": True, "data": skills_mgr.list_review_files(review_id, caller.username, caller.is_admin)}


@app.get("/api/backend/skills/reviews/{review_id}/content")
def api_review_content(
    review_id: str, file: str, caller: Caller = Depends(auth)
) -> dict[str, Any]:
    """读取待审核 skill 的某个文件内容（仅 owner 或管理员可见）。"""
    content = skills_mgr.read_review_file(review_id, file, caller.username, caller.is_admin)
    if content is None:
        raise HTTPException(status_code=404, detail="审核记录不存在、无权访问或文件不存在")
    return {"ok": True, "data": content}


@app.get("/api/backend/skills/notices")
def api_list_notices(caller: Caller = Depends(auth)) -> dict[str, Any]:
    """当前用户的审核结果通知（未读）。"""
    return {"ok": True, "data": skills_mgr.list_notices(caller.username)}


@app.post("/api/backend/skills/notices/{notice_id}/dismiss")
def api_dismiss_notice(notice_id: str, caller: Caller = Depends(auth)) -> dict[str, Any]:
    """用户取消（读过）通知：永久移除，之后不再发送。"""
    if not skills_mgr.dismiss_notice(notice_id, caller.username):
        raise HTTPException(status_code=404, detail="通知不存在")
    return {"ok": True}


# ════════════════════════════════════════════════════════════════════════
# 任务管理
# ════════════════════════════════════════════════════════════════════════
class CreateTaskBody(BaseModel):
    name: str = ""
    skill: str = ""
    skillPath: str = ""
    jql: str
    maxIssues: int = 0
    email: str = ""
    mode: str = Field(default="immediate", pattern="^(immediate|once)$")
    runAt: str | None = None   # "YYYY-MM-DD HH:MM"


@app.get("/api/backend/tasks")
def api_list_tasks(
    caller: Caller = Depends(auth),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    owner: str = Query(""),
    skill: str = Query(""),
    date_from: str = Query(""),
    date_to: str = Query(""),
) -> dict[str, Any]:
    """任务列表：分页 + 按 上传者(仅管理员有意义)/skill/日期范围 过滤。"""
    result = executor.list_runs(
        caller.username,
        caller.is_admin,
        page=page,
        page_size=page_size,
        owner_filter=owner,
        skill_filter=skill,
        date_from=date_from,
        date_to=date_to,
    )
    return {
        "ok": True,
        "tasks": result["items"],
        "total": result["total"],
        "page": result["page"],
        "page_size": result["page_size"],
        "owner_options": result["owner_options"],
        "skill_options": result["skill_options"],
    }


@app.get("/api/backend/tasks/stats")
def api_task_stats(caller: Caller = Depends(auth)) -> dict[str, Any]:
    return {"ok": True, **executor.get_stats(caller.username)}


@app.post("/api/backend/tasks")
def api_create_task(body: CreateTaskBody, caller: Caller = Depends(auth)) -> dict[str, Any]:
    if not body.jql.strip():
        raise HTTPException(status_code=400, detail="JQL 不能为空")
    name = body.name.strip() or "未命名任务"

    # 普通用户只能使用自己负责的 Skill（管理员不受限）
    if not skills_mgr.assert_skill_accessible(body.skill, caller.username, caller.is_admin) or not (
        skills_mgr.assert_skill_accessible(body.skillPath, caller.username, caller.is_admin)
    ):
        raise HTTPException(status_code=403, detail="无权使用该 Skill：只能使用自己负责的 Skill")

    # 立即执行：管理员直接入队执行；普通用户创建待审核任务（pending）
    if body.mode == "immediate":
        run = executor.create_immediate_run(
            body.model_dump(), caller.username, pending=not caller.is_admin
        )
        return {"ok": True, "task": run}

    # 定时执行：写入 yaml 定义（普通用户创建的定义需管理员审核后才触发）
    if not body.runAt:
        raise HTTPException(status_code=400, detail="once 模式必须提供 runAt")
    try:
        time.strptime(body.runAt, "%Y-%m-%d %H:%M")
    except ValueError:
        raise HTTPException(status_code=400, detail="runAt 格式必须为 YYYY-MM-DD HH:MM")

    task_def = {
        "id": storage.gen_task_id(body.skill),
        "name": name,
        "owner": caller.username,
        "enabled": True,
        "trigger": "once",
        "run_at": body.runAt,
        "skill": body.skill,
        "jql": body.jql,
        "email": body.email,
        "max_issues": int(body.maxIssues or 0),
        "review": "approved" if caller.is_admin else "pending",
        "created_t": storage.now_str(),
    }
    storage.upsert_task_def(task_def)
    return {"ok": True, "definition": task_def}


@app.get("/api/backend/tasks/{run_id}")
def api_get_task(run_id: str, caller: Caller = Depends(auth)) -> dict[str, Any]:
    run = executor.get_run(run_id, caller.username, caller.is_admin)
    if not run:
        raise HTTPException(status_code=404, detail="未找到任务")
    return {"ok": True, "task": run}


@app.delete("/api/backend/tasks/{run_id}")
def api_stop_task(run_id: str, caller: Caller = Depends(auth)) -> dict[str, Any]:
    run = executor.get_run(run_id, caller.username, caller.is_admin)
    if not run:
        raise HTTPException(status_code=404, detail="任务不存在")
    if run.get("status") == "pending":
        # 待审核任务：创建者本人或管理员可回撤（删除记录），不再等待审核
        if not executor.withdraw_pending_run(run_id, caller.username, caller.is_admin):
            raise HTTPException(status_code=403, detail="只有创建者或管理员可以回撤待审核任务")
        return {"ok": True}
    if not executor.stop_run(run_id, caller.username, caller.is_admin):
        raise HTTPException(status_code=404, detail="任务不存在或当前状态不可停止")
    return {"ok": True}


@app.get("/api/backend/tasks/{run_id}/log")
def api_task_log(run_id: str, caller: Caller = Depends(auth)) -> dict[str, Any]:
    if not executor.get_run(run_id, caller.username, caller.is_admin):
        raise HTTPException(status_code=404, detail="未找到任务")
    return {"ok": True, "log": executor.get_log(run_id, caller.username, caller.is_admin, 200)}


def _download(run_id: str, caller: Caller, kind: str) -> FileResponse:
    run = executor.get_run(run_id, caller.username, caller.is_admin)
    if not run:
        raise HTTPException(status_code=404, detail="未找到任务")
    file_path = Path(run["logPath"] if kind == "log" else run["outputPath"])
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="文件不存在")
    media = "text/plain" if kind == "log" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    suffix = "log" if kind == "log" else "xlsx"
    return FileResponse(
        path=str(file_path),
        media_type=media,
        filename=f"{run_id}.{suffix}",
    )


@app.get("/api/backend/tasks/{run_id}/download-log")
def api_download_log(run_id: str, caller: Caller = Depends(auth)) -> FileResponse:
    return _download(run_id, caller, "log")


@app.get("/api/backend/tasks/{run_id}/download-output")
def api_download_output(run_id: str, caller: Caller = Depends(auth)) -> FileResponse:
    return _download(run_id, caller, "xlsx")


# ════════════════════════════════════════════════════════════════════════
# 任务配置模板（preset）
# ════════════════════════════════════════════════════════════════════════
class CreatePresetBody(BaseModel):
    name: str = ""
    skill: str = ""
    skillPath: str = ""
    jql: str
    maxIssues: int = 0
    email: str = ""
    mode: str = Field(default="immediate", pattern="^(immediate|once)$")
    runAt: str | None = None


@app.get("/api/backend/presets")
def api_list_presets(caller: Caller = Depends(auth)) -> dict[str, Any]:
    presets = storage.load_presets()
    mine = [p for p in presets if p.get("owner") == caller.username]
    return {"ok": True, "data": mine}


@app.post("/api/backend/presets")
def api_create_preset(body: CreatePresetBody, caller: Caller = Depends(auth)) -> dict[str, Any]:
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="配置名称不能为空")
    if not body.jql.strip():
        raise HTTPException(status_code=400, detail="JQL 不能为空")
    # 普通用户只能保存自己负责的 Skill（管理员不受限）
    if not skills_mgr.assert_skill_accessible(body.skill, caller.username, caller.is_admin) or not (
        skills_mgr.assert_skill_accessible(body.skillPath, caller.username, caller.is_admin)
    ):
        raise HTTPException(status_code=403, detail="无权使用该 Skill：只能使用自己负责的 Skill")
    if body.mode == "once":
        if not body.runAt:
            raise HTTPException(status_code=400, detail="once 模式必须提供 runAt")
        try:
            time.strptime(body.runAt, "%Y-%m-%d %H:%M")
        except ValueError:
            raise HTTPException(status_code=400, detail="runAt 格式必须为 YYYY-MM-DD HH:MM")

    preset = {
        "id": storage.gen_id("ps"),
        "name": name,
        "owner": caller.username,
        "skill": body.skill,
        "skillPath": body.skillPath,
        "jql": body.jql,
        "maxIssues": int(body.maxIssues or 0),
        "email": body.email,
        "mode": body.mode,
        "runAt": body.runAt if body.mode == "once" else None,
        "createdAt": storage.now_str(),
    }
    storage.add_preset(preset)
    return {"ok": True, "data": preset}


@app.delete("/api/backend/presets/{preset_id}")
def api_delete_preset(preset_id: str, caller: Caller = Depends(auth)) -> dict[str, Any]:
    if not storage.remove_preset(preset_id, caller.username, caller.is_admin):
        raise HTTPException(status_code=404, detail="配置不存在或无权删除")
    return {"ok": True}


# ════════════════════════════════════════════════════════════════════════
# 计划任务（指定时间执行一次的 once 任务）
# 普通用户可查看/删除自己创建的、尚未执行的 plan，管理员可查看/删除全部
# ════════════════════════════════════════════════════════════════════════
def _to_scheduled(d: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": d.get("id"),
        "name": d.get("name"),
        "owner": d.get("owner"),
        "skill": d.get("skill"),
        "jql": d.get("jql"),
        "email": d.get("email"),
        "maxIssues": d.get("max_issues", 0),
        "runAt": d.get("run_at"),
        "createdAt": d.get("created_t"),
        "review": d.get("review", "approved"),
    }


@app.get("/api/backend/scheduled-tasks")
def api_list_scheduled(caller: Caller = Depends(auth)) -> dict[str, Any]:
    """计划任务列表：普通用户只看自己创建的；管理员可见全部用户的计划任务。

    管理员对计划任务的审核入口是 /api/backend/approvals（含全部待审核 def）。
    """
    defs = storage.load_task_defs()
    result = []
    for d in defs:
        if d.get("trigger") != "once":
            continue
        if not d.get("enabled", True):
            continue
        if d.get("review") == "rejected":
            continue
        if not caller.is_admin and d.get("owner") != caller.username:
            continue
        result.append(_to_scheduled(d))
    return {"ok": True, "data": result}


# ---- 任务审核：普通用户创建的任务（立即执行 / 指定时间）由管理员通过或拒绝 ----
class ReviewBody(BaseModel):
    """审核请求体：管理员可附备注，随审核结果通知一并发送给申请人。"""
    remark: str = ""


def _review_message(kind: str, name: str, remark: str, run_at: str = "") -> str:
    """构造发给申请人的审核结果通知文案（含管理员备注）。"""
    base = f"任务「{name}」已通过审核，即将执行。"
    if kind == "rejected":
        base = f"任务「{name}」已被拒绝执行。"
    elif run_at:
        base = f"计划任务「{name}」已通过审核，将于 {run_at} 执行。"
    remark = (remark or "").strip()
    if remark:
        base += f" 管理员备注：{remark}"
    return base


@app.get("/api/backend/approvals")
def api_list_approvals(caller: Caller = Depends(admin_only)) -> dict[str, Any]:
    defs = [
        {
            "id": d.get("id"),
            "name": d.get("name"),
            "owner": d.get("owner"),
            "skill": d.get("skill"),
            "jql": d.get("jql"),
            "email": d.get("email"),
            "maxIssues": d.get("max_issues", 0),
            "runAt": d.get("run_at"),
            "createdAt": d.get("created_t"),
        }
        for d in storage.load_task_defs()
        if d.get("enabled", True) and d.get("review") == "pending"
    ]
    return {"ok": True, "runs": executor.list_pending_runs(), "defs": defs}


@app.post("/api/backend/approvals/run/{run_id}/accept")
def api_accept_run(run_id: str, body: ReviewBody | None = None, caller: Caller = Depends(admin_only)) -> dict[str, Any]:
    run = executor.get_run(run_id, caller.username, caller.is_admin)
    if not run or run.get("status") != "pending":
        raise HTTPException(status_code=404, detail="任务不存在或非待审核状态")
    if not executor.set_run_review_status(run_id, "queued"):
        raise HTTPException(status_code=404, detail="任务不存在或非待审核状态")
    name = str(run.get("name") or "") or str(run.get("skill") or "")
    remark = body.remark if body else ""
    skills_mgr.add_notice(
        str(run.get("owner") or ""),
        "approved",
        name,
        _review_message("approved", name, remark),
    )
    return {"ok": True}


@app.post("/api/backend/approvals/run/{run_id}/reject")
def api_reject_run(run_id: str, body: ReviewBody | None = None, caller: Caller = Depends(admin_only)) -> dict[str, Any]:
    run = executor.get_run(run_id, caller.username, caller.is_admin)
    if not run or run.get("status") != "pending":
        raise HTTPException(status_code=404, detail="任务不存在或非待审核状态")
    if not executor.set_run_review_status(run_id, "rejected"):
        raise HTTPException(status_code=404, detail="任务不存在或非待审核状态")
    name = str(run.get("name") or "") or str(run.get("skill") or "")
    remark = body.remark if body else ""
    skills_mgr.add_notice(
        str(run.get("owner") or ""),
        "rejected",
        name,
        _review_message("rejected", name, remark),
    )
    return {"ok": True}


@app.post("/api/backend/approvals/def/{task_id}/accept")
def api_accept_def(task_id: str, body: ReviewBody | None = None, caller: Caller = Depends(admin_only)) -> dict[str, Any]:
    defs = storage.load_task_defs()
    target = next((d for d in defs if d.get("id") == task_id), None)
    if target is None or target.get("review") != "pending":
        raise HTTPException(status_code=404, detail="计划任务不存在或非待审核状态")
    target["review"] = "approved"
    storage.upsert_task_def(target)
    name = str(target.get("name") or "") or str(target.get("skill") or "")
    remark = body.remark if body else ""
    skills_mgr.add_notice(
        str(target.get("owner") or ""),
        "approved",
        name,
        _review_message("approved", name, remark, str(target.get("run_at") or "")),
    )
    return {"ok": True}


@app.post("/api/backend/approvals/def/{task_id}/reject")
def api_reject_def(task_id: str, body: ReviewBody | None = None, caller: Caller = Depends(admin_only)) -> dict[str, Any]:
    defs = storage.load_task_defs()
    target = next((d for d in defs if d.get("id") == task_id), None)
    if target is None or target.get("review") != "pending":
        raise HTTPException(status_code=404, detail="计划任务不存在或非待审核状态")
    target["review"] = "rejected"
    target["enabled"] = False
    storage.upsert_task_def(target)
    name = str(target.get("name") or "") or str(target.get("skill") or "")
    remark = body.remark if body else ""
    skills_mgr.add_notice(
        str(target.get("owner") or ""),
        "rejected",
        name,
        _review_message("rejected", name, remark),
    )
    return {"ok": True}


@app.delete("/api/backend/scheduled-tasks/{task_id}")
def api_delete_scheduled(task_id: str, caller: Caller = Depends(auth)) -> dict[str, Any]:
    defs = storage.load_task_defs()
    target = next((d for d in defs if d.get("id") == task_id), None)
    if target is None:
        raise HTTPException(status_code=404, detail="计划任务不存在")
    if not caller.is_admin and target.get("owner") != caller.username:
        raise HTTPException(status_code=403, detail="只有创建者或管理员可以删除")
    storage.remove_task_def(task_id)
    return {"ok": True}


# ════════════════════════════════════════════════════════════════════════
# 管理员：任务定义管理（yaml 中的 cron/once 任务）+ 并发配置
# ════════════════════════════════════════════════════════════════════════
@app.get("/api/backend/admin/task-defs")
def api_list_defs(caller: Caller = Depends(admin_only)) -> dict[str, Any]:
    return {"ok": True, "data": storage.load_task_defs()}


@app.delete("/api/backend/admin/task-defs/{task_id}")
def api_delete_def(task_id: str, caller: Caller = Depends(admin_only)) -> dict[str, Any]:
    if not storage.remove_task_def(task_id):
        raise HTTPException(status_code=404, detail="任务定义不存在")
    return {"ok": True}


@app.get("/api/backend/admin/task-config")
def api_get_config(caller: Caller = Depends(admin_only)) -> dict[str, Any]:
    state = storage.load_state()
    return {"ok": True, "max": int(state["config"]["max_concurrent_tasks"])}


class ConfigBody(BaseModel):
    max: int = Field(ge=1, le=16)


@app.put("/api/backend/admin/task-config")
def api_set_config(body: ConfigBody, caller: Caller = Depends(admin_only)) -> dict[str, Any]:
    def _upd(state: dict[str, Any]) -> None:
        state["config"]["max_concurrent_tasks"] = body.max
    storage.mutate_state(_upd)
    return {"ok": True, "max": body.max}
