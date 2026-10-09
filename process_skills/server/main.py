# -*- coding: utf-8 -*-
"""
Skill 任务后端 —— FastAPI 应用。

启动::

    cd process_skills
    python -m uvicorn server.main:app --host 127.0.0.1 --port 1238

鉴权：仅接受 Next.js 代理转发来的请求：
    X-INTERNAL-TOKEN : 共享密钥（env SKILL_API_TOKEN 或 server_data/.api_token）
    X-USER           : 登录名
    X-IS-ADMIN       : "1" / "0"
"""
from __future__ import annotations

import re
import time
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
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
def api_list_skills(caller: Caller = Depends(auth)) -> dict[str, Any]:
    return {"ok": True, "data": skills_mgr.list_skills(caller.username, caller.is_admin)}


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
def api_skill_delete(path: str, caller: Caller = Depends(auth)) -> dict[str, Any]:
    detail = skills_mgr.get_skill_detail(path, caller.username, caller.is_admin)
    if not detail:
        raise HTTPException(status_code=404, detail="未找到 skill 或无权访问")
    if not caller.is_admin and detail["owner"] != caller.username:
        raise HTTPException(status_code=403, detail="只有 owner 或管理员可以删除")
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
    skillType: str = Form(...),
    skillName: str = Form(...),
    owner: str = Form(default=""),
    file: UploadFile = File(...),
    caller: Caller = Depends(auth),
) -> dict[str, Any]:
    skill_type = skillType.strip()
    skill_name = skillName.strip()
    if not skill_type or not skill_name:
        raise HTTPException(status_code=400, detail="skillType / skillName 不能为空")
    if not re.fullmatch(r"[A-Za-z0-9._\-]+", skill_type) or not re.fullmatch(
        r"[A-Za-z0-9._\-]+", skill_name
    ):
        raise HTTPException(status_code=400, detail="类型/名称只允许字母数字 . _ -")
    if not file.filename or not file.filename.lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="请上传 .zip 文件")
    # 普通用户只能把 owner 设为自己；管理员可指定
    final_owner = owner.strip() if caller.is_admin else caller.username
    if not final_owner:
        final_owner = caller.username

    zip_bytes = await file.read()
    target = skills_mgr.upload_skill(skill_type, skill_name, zip_bytes, final_owner)
    return {"ok": True, "data": {"skillPath": target}}


# ════════════════════════════════════════════════════════════════════════
# 任务管理
# ════════════════════════════════════════════════════════════════════════
class CreateTaskBody(BaseModel):
    name: str = ""
    skill: str = ""
    jql: str
    maxIssues: int = 0
    email: str = ""
    mode: str = Field(default="immediate", pattern="^(immediate|once|cron)$")
    runAt: str | None = None   # "YYYY-MM-DD HH:MM"
    cron: str | None = None    # 5 段 cron


def _validate_cron(expr: str) -> None:
    fields = expr.split()
    if len(fields) != 5:
        raise HTTPException(status_code=400, detail="cron 必须是 5 段表达式")
    # 借用 legacy 的解析做合法性校验
    try:
        from run_skills_scheduler import cron_match
        from datetime import datetime
        cron_match(expr, datetime.now())
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/backend/tasks")
def api_list_tasks(caller: Caller = Depends(auth)) -> dict[str, Any]:
    return {"ok": True, "tasks": executor.list_runs(caller.username, caller.is_admin)}


@app.get("/api/backend/tasks/stats")
def api_task_stats(caller: Caller = Depends(auth)) -> dict[str, Any]:
    return {"ok": True, **executor.get_stats(caller.username)}


@app.post("/api/backend/tasks")
def api_create_task(body: CreateTaskBody, caller: Caller = Depends(auth)) -> dict[str, Any]:
    if not body.jql.strip():
        raise HTTPException(status_code=400, detail="JQL 不能为空")
    name = body.name.strip() or "未命名任务"

    # 立即执行：直接入运行队列
    if body.mode == "immediate":
        run = executor.create_immediate_run(body.model_dump(), caller.username)
        return {"ok": True, "task": run}

    # 定时/cron：写入 yaml 定义
    trigger = body.mode
    if trigger == "cron":
        if not body.cron or not body.cron.strip():
            raise HTTPException(status_code=400, detail="cron 模式必须提供 cron 表达式")
        _validate_cron(body.cron.strip())
    else:
        if not body.runAt:
            raise HTTPException(status_code=400, detail="once 模式必须提供 runAt")
        try:
            time.strptime(body.runAt, "%Y-%m-%d %H:%M")
        except ValueError:
            raise HTTPException(status_code=400, detail="runAt 格式必须为 YYYY-MM-DD HH:MM")

    task_def = {
        "id": storage.gen_id("tsk"),
        "name": name,
        "owner": caller.username,
        "enabled": True,
        "trigger": trigger,
        "cron": body.cron.strip() if trigger == "cron" else None,
        "run_at": body.runAt if trigger == "once" else None,
        "skill": body.skill,
        "jql": body.jql,
        "email": body.email,
        "max_issues": int(body.maxIssues or 0),
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
    skillType: str = ""
    jql: str
    maxIssues: int = 0
    email: str = ""
    mode: str = Field(default="immediate", pattern="^(immediate|once|cron)$")
    runAt: str | None = None
    cron: str | None = None


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
    if body.mode == "cron":
        if not body.cron or not body.cron.strip():
            raise HTTPException(status_code=400, detail="cron 模式必须提供 cron 表达式")
        _validate_cron(body.cron.strip())
    elif body.mode == "once":
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
        "skillType": body.skillType,
        "jql": body.jql,
        "maxIssues": int(body.maxIssues or 0),
        "email": body.email,
        "mode": body.mode,
        "runAt": body.runAt if body.mode == "once" else None,
        "cron": body.cron.strip() if body.mode == "cron" else None,
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
