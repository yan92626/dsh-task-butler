#!/usr/bin/env python3
"""End-to-end API checks for the dsh-personal-secretary plugin — SAFE MODE.

This suite runs against a LIVE Harness profile and therefore must never touch
the user's own data:

- it never deletes/edits tasks it did not create in this run;
- every task it creates is tracked and removed in a `finally` block;
- task order and settings are snapshotted and restored;
- optional sections that could affect the user's data are opt-in flags
  (`--dispatch`, `--reorder`, `--reports`) and print a warning.

Usage:
  python3 tests/api-check.py [--base URL] [--cwd DIR] [--dispatch] [--reorder] [--reports]
                              [--evolution] [--keep]

--evolution adds v9 read-only checks for the retrospective / lessons / skills API. It
never triggers a retrospective, so it does not spend model time or change your state.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

FAILURES = []
CHECKS = 0
CREATED_IDS = []
ORIGINAL = {"settings": None, "order": []}
REPORT_CREATED = None


# ---------------------------------------------------------------- HTTP helpers
def request(base, method, path, body=None, origin=None, host=None, timeout=40):
    url = base + path
    data = None
    headers = {"accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["content-type"] = "application/json"
    if origin:
        headers["origin"] = origin
    if host:
        headers["host"] = host
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = {"raw": raw}
        return error.code, payload


def check(name, condition, detail=""):
    global CHECKS
    CHECKS += 1
    if condition:
        print(f"  ok   {name}")
    else:
        FAILURES.append(f"{name} {detail}".strip())
        print(f"  FAIL {name} {detail}")


def state(base):
    status, payload = request(base, "GET", "/secretary/api/state")
    check("GET /state 200", status == 200, payload)
    return payload


def track(payload_or_ids):
    ids = []
    if isinstance(payload_or_ids, dict):
        if isinstance(payload_or_ids.get("task"), dict) and payload_or_ids["task"].get("id"):
            ids.append(payload_or_ids["task"]["id"])
        for item in payload_or_ids.get("created") or []:
            ids.append(item)
    elif isinstance(payload_or_ids, list):
        ids = [item for item in payload_or_ids if isinstance(item, str)]
    for task_id in ids:
        if task_id and task_id not in CREATED_IDS:
            CREATED_IDS.append(task_id)
    return ids


def create_task(base, args, title, prompt, status="pending", priority=None, chain_from=None):
    body = {"title": title, "prompt": prompt, "cwd": args.cwd, "status": status}
    if priority:
        body["priority"] = priority
    if chain_from:
        body["chainFrom"] = chain_from
    status_code, payload = request(base, "POST", "/secretary/api/tasks", body)
    track(payload)
    return status_code, payload


def act(base, task_id, action):
    return request(base, "POST", "/secretary/api/tasks/action", {"id": task_id, "action": action})


def mine(snapshot):
    own = set(CREATED_IDS)
    return [task for task in snapshot.get("tasks", []) if task.get("id") in own]


def wait_until(base, predicate, timeout, label, interval=1.5):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = state(base)
        if predicate(last):
            return last
        time.sleep(interval)
    check(label, False, f"timeout after {timeout}s: " + json.dumps(
        [(t.get("title"), t.get("status"), t.get("error")) for t in mine(last or {})], ensure_ascii=False))
    return last


def restore_original(base):
    """Put the profile back the way we found it (settings, order, own tasks)."""
    current = request(base, "GET", "/secretary/api/state")[1]
    # Delete only the tasks this run created.
    for task in current.get("tasks", []):
        if task.get("id") in CREATED_IDS:
            try:
                act(base, task["id"], "delete")
            except Exception:
                pass
    # Restore task order for everything that survived.
    try:
        after = request(base, "GET", "/secretary/api/state")[1]
        ids = [task["id"] for task in after.get("tasks", [])]
        original = [task_id for task_id in ORIGINAL["order"] if task_id in ids]
        restored = original + [task_id for task_id in ids if task_id not in original]
        if restored != ids:
            request(base, "POST", "/secretary/api/tasks/reorder", {"ids": restored})
    except Exception:
        pass
    # Restore settings.
    try:
        settings = ORIGINAL["settings"] or {}
        patch = {
            "concurrency": settings.get("concurrency"),
            "provider": settings.get("provider"),
            "model": settings.get("model"),
            "reasoningEffort": settings.get("reasoningEffort"),
            "autoStart": settings.get("autoStart"),
            "notifyOnDone": settings.get("notifyOnDone"),
            "group": settings.get("group"),
        }
        daily = settings.get("dailyReport") or {}
        if daily:
            patch["dailyReport"] = {
                "enabled": daily.get("enabled"),
                "time": daily.get("time"),
                "dir": daily.get("dir"),
            }
        webhook = settings.get("webhook") or {}
        if webhook:
            patch["webhook"] = {
                "enabled": webhook.get("enabled") is True,
                "url": webhook.get("url") or "",
                "format": webhook.get("format") or "generic",
                "events": webhook.get("events") or {},
            }
        patch = {key: value for key, value in patch.items() if value is not None}
        if patch:
            request(base, "POST", "/secretary/api/settings", patch)
    except Exception:
        pass
    # Remove a report file this run generated, if it did not exist before.
    if REPORT_CREATED:
        path, existed = REPORT_CREATED
        if path and not existed:
            try:
                os.unlink(path)
            except OSError:
                pass


def main():
    parser = argparse.ArgumentParser(description="Safe end-to-end API checks for 私人秘书")
    parser.add_argument("--base", default=os.environ.get("DSH_WEB_URL", "http://127.0.0.1:49224"))
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--keep", action="store_true", help="keep the tasks this run created (debugging only)")
    parser.add_argument("--dispatch", action="store_true",
                        help="also exercise automatic claiming (temporarily enables autoStart; may dispatch your pending tasks)")
    parser.add_argument("--reorder", action="store_true",
                        help="also exercise reorder across the whole board (restored afterwards)")
    parser.add_argument("--reports", action="store_true",
                        help="also generate a daily report when today's file does not exist yet")
    parser.add_argument("--evolution", action="store_true",
                        help="also run v9 read-only retrospective/lessons/skills API checks")
    args = parser.parse_args()
    base = args.base.rstrip("/")

    print("== 私人秘书 API 自检（安全模式）==")
    print("本次不会删除或修改你已有的任务；只创建并清理本次自检任务，结束时恢复设置与顺序。")
    if args.dispatch:
        print("警告：--dispatch 会临时开启自动领取，可能领取你原有的待领取任务。")
    if args.reorder:
        print("警告：--reorder 会临时改变全看板顺序，结束时恢复。")

    global ORIGINAL
    snapshot = state(base)
    ORIGINAL = {"settings": snapshot.get("settings") or {}, "order": [t["id"] for t in snapshot.get("tasks", [])]}
    print(f"起始：{len(snapshot.get('tasks', []))} 个任务，counts={json.dumps(snapshot.get('counts'), ensure_ascii=False)}")
    tag = f"自检{time.strftime('%H%M%S')}"

    # Freeze auto-claim for the duration of the run: this suite creates its own
    # `pending` tasks for the manual-run checks, and a scheduler that is already
    # running would otherwise claim them (or the user's own pending work) while
    # the checks run. The original value is restored in `finally`; `--dispatch`
    # re-enables auto-claim explicitly for its own section.
    request(base, "POST", "/secretary/api/settings", {"autoStart": False})
    parked = [t.get("title") for t in snapshot.get("tasks", []) if t.get("status") == "pending"]
    if parked:
        print(f"注意：看板上有 {len(parked)} 个待领取任务；自检期间自动领取已临时关闭，结束恢复。")

    try:
        print("1. ping / request gates")
        status, payload = request(base, "GET", "/secretary/api/ping")
        check("ping ok", status == 200 and payload.get("ok") is True, payload)
        status, payload = request(base, "POST", "/secretary/api/settings", {"concurrency": 1},
                                  origin="https://evil.example")
        check("cross-origin POST is rejected", status == 403, (status, payload))
        status, payload = request(base, "GET", "/secretary/api/ping", host="dsh.example.org")
        check("non-loopback authority is rejected", status in (401, 403), (status, payload))

        print("2. validation (no mutations)")
        status, _ = request(base, "POST", "/secretary/api/tasks", {"prompt": "p", "cwd": args.cwd})
        check("missing title -> 400", status == 400)
        status, _ = request(base, "POST", "/secretary/api/tasks", {"title": "t", "prompt": "p"})
        check("missing cwd -> 400", status == 400)
        status, _ = request(base, "POST", "/secretary/api/tasks", {
            "title": "x", "prompt": "x", "cwd": args.cwd, "chainFrom": "不存在的任务"})
        check("unknown chainFrom -> 400", status == 400)
        status, payload = request(base, "POST", "/secretary/api/tasks/update",
                                  {"id": "不存在的任务", "title": "x"})
        check("unknown task update -> 404", status == 404, payload)

        print("3. models (read-only)")
        status, payload = request(base, "GET", "/secretary/api/models")
        check("model catalog readable", status == 200 and isinstance(payload.get("catalog"), dict), status)

        print("4. create + edit + manual run + result collect")
        status, payload = create_task(base, args, f"{tag}-执行", "只回复：自检完成", status="pending")
        run_id = payload["task"]["id"]
        check("publish task", status == 200 and payload["task"]["status"] == "pending", payload)
        status, payload = request(base, "POST", "/secretary/api/tasks/update", {
            "id": run_id, "title": f"{tag}-执行（已编辑）", "priority": "high"})
        check("edit title + priority", status == 200 and payload["task"]["title"].endswith("（已编辑）")
              and payload["task"]["priority"] == "high", payload.get("task"))
        status, payload = act(base, run_id, "run")
        check("manual run accepted", status == 200 and payload["task"]["status"] in ("running", "blocked"),
              payload.get("task"))
        settled = wait_until(base, lambda snap: any(
            t["id"] == run_id and t["status"] in ("done", "failed") for t in mine(snap)), 150,
            "manual run settles")
        done_task = next((t for t in mine(settled) if t["id"] == run_id), {})
        check("task settles back to done", done_task.get("status") == "done", done_task)
        check("result collected", bool((done_task.get("result") or {}).get("finalAnswer")), done_task.get("result"))

        print("5. chat re-opens a finished task")
        if done_task.get("sessionId"):
            status, payload = request(base, "POST", "/secretary/api/chat", {
                "sessionId": done_task["sessionId"], "text": "只回复：第二轮"})
            check("chat accepted", status == 200 and payload.get("ok") is True, payload)
            check("finished task is re-opened", payload.get("revived") in ("running", "pending"), payload)
            revived = wait_until(base, lambda snap: any(
                t["id"] == run_id and t["status"] == "running" for t in mine(snap)), 15,
                "chat moves the task to running")
            check("re-opened task is running", any(t["id"] == run_id and t["status"] == "running" for t in mine(revived)))
            resettled = wait_until(base, lambda snap: any(
                t["id"] == run_id and t["status"] in ("done", "failed") for t in mine(snap)), 150,
                "re-opened task settles again")
            again = next((t for t in mine(resettled) if t["id"] == run_id), {})
            check("re-opened task archives again", again.get("status") == "done", again)
        else:
            check("chat re-opens a finished task", False, "no sessionId on the finished task")

        print("6. pause / resume / interrupt / cancel / retry")
        status, payload = create_task(base, args, f"{tag}-控制", "请执行 sleep 20 后回复：完成", status="pending")
        ctl = payload["task"]["id"]
        act(base, ctl, "run")
        wait_until(base, lambda snap: any(
            t["id"] == ctl and t["status"] in ("running", "blocked") for t in mine(snap)), 90, "control task starts")
        status, payload = act(base, ctl, "pause")
        check("pause accepted", status == 200, payload)
        status, payload = act(base, ctl, "resume")
        check("resume accepted", status == 200, payload)
        status, payload = act(base, ctl, "interrupt")
        check("interrupt cancels", status == 200 and next(
            (t for t in payload.get("tasks", []) if t["id"] == ctl), {}).get("status") == "cancelled", payload)
        status, payload = act(base, ctl, "retry")
        check("retry returns to queue", status == 200 and next(
            (t for t in payload.get("tasks", []) if t["id"] == ctl), {}).get("status") == "pending", payload)
        status, payload = act(base, ctl, "cancel")
        check("cancel accepted", status == 200, payload)

        print("7. idea / priority / batch")
        status, payload = request(base, "POST", "/secretary/api/tasks", {
            "title": f"{tag}-想法", "prompt": "想法", "cwd": args.cwd})
        track(payload)
        idea = payload.get("task") or {}
        check("new task defaults to idea", status == 200 and idea.get("status") == "idea", idea)
        check("priority defaults to normal", idea.get("priority") == "normal", idea.get("priority"))
        status, payload = act(base, idea["id"], "promote")
        check("promote to queue", status == 200 and next(
            (t for t in payload.get("tasks", []) if t["id"] == idea["id"]), {}).get("status") == "pending", payload)
        status, payload = act(base, idea["id"], "demote")
        check("demote back to idea", status == 200 and next(
            (t for t in payload.get("tasks", []) if t["id"] == idea["id"]), {}).get("status") == "idea", payload)
        status, _ = request(base, "POST", "/secretary/api/tasks/update", {"id": idea["id"], "priority": "bogus"})
        check("invalid priority -> 400", status == 400)
        status, payload = request(base, "POST", "/secretary/api/tasks/batch", {
            "cwd": args.cwd, "status": "idea", "priority": "low",
            "items": [{"title": f"{tag}-批量甲", "prompt": "A"}, {"title": f"{tag}-批量乙", "prompt": "B"}]})
        track(payload)
        batch_tasks = [t for t in (payload.get("tasks") or []) if t["id"] in (payload.get("created") or [])]
        check("batch creates idea+low tasks", len(batch_tasks) == 2
              and all(t["status"] == "idea" and t["priority"] == "low" for t in batch_tasks), batch_tasks)

        print("8. read-only surfaces")
        if done_task.get("sessionId"):
            status, payload = request(base, "GET",
                                      f"/secretary/api/transcript?sessionId={done_task['sessionId']}")
            check("transcript readable", status == 200 and isinstance(payload.get("messages"), list), status)
        status, payload = request(base, "GET", "/secretary/api/reports")
        check("reports list readable", status == 200 and isinstance(payload.get("reports"), list), status)
        status, payload = request(base, "GET", "/secretary/api/backups")
        check("backups list readable", status == 200 and isinstance(payload.get("backups"), list), status)

        print("9. settings validation (restored afterwards)")
        original_settings = ORIGINAL["settings"]
        status, payload = request(base, "POST", "/secretary/api/settings", {"dailyReport": {"time": "99:99"}})
        check("invalid report time -> 400", status == 400, status)
        # Keep auto-claim frozen here too: re-enabling it mid-run would dispatch
        # whatever pending rows exist before the cleanup pass.
        status, payload = request(base, "POST", "/secretary/api/settings",
                                  {"concurrency": 99, "autoStart": False})
        check("concurrency clamps at 10", payload.get("settings", {}).get("concurrency") == 10, payload)
        status, payload = request(base, "POST", "/secretary/api/settings",
                                  {"concurrency": 0, "autoStart": False})
        check("concurrency clamps at 1", payload.get("settings", {}).get("concurrency") == 1, payload)

        if args.reorder:
            print("9b. webhook notifications (capture server)")
        import http.server
        import threading
        received = []
        lock = threading.Lock()

        class CaptureHandler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("content-length") or 0)
                raw = self.rfile.read(length).decode("utf-8", "replace")
                with lock:
                    received.append({"path": self.path, "headers": dict(self.headers), "body": raw})
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.end_headers()
                if self.path.endswith("/bad"):
                    self.wfile.write(b'{"code":19024,"msg":"Key Words Not Found"}')
                else:
                    self.wfile.write(b'{"StatusCode":0,"code":0,"msg":"success"}')

            def log_message(self, *args):
                pass

        capture = http.server.ThreadingHTTPServer(("127.0.0.1", 0), CaptureHandler)
        capture_port = capture.server_address[1]
        capture_thread = threading.Thread(target=capture.serve_forever, daemon=True)
        capture_thread.start()
        hook_url = f"http://127.0.0.1:{capture_port}/hook"
        try:
            status, action_payload = request(base, "POST", "/secretary/api/tasks/action",
                                             {"id": run_id, "action": "retry"})
            check("retry for webhook run accepted", status == 200, action_payload)
            status, _ = request(base, "POST", "/secretary/api/settings", {"webhook": {
                "enabled": True, "url": hook_url, "format": "generic",
                "events": {"claimed": True, "succeeded": True, "blocked": False,
                           "failed": True, "dailyReport": False}}})
            check("webhook settings accepted", status == 200, status)
            status, payload = request(base, "POST", "/secretary/api/webhook/test", {})
            check("webhook test delivered", status == 200 and payload.get("ok") is True, payload)
            hook_task = create_task(base, args, f"{tag}-通知", "只回复：通知测试", status="pending")[1]["task"]["id"]
            act(base, hook_task, "run")
            wait_until(base, lambda snap: any(
                t["id"] == hook_task and t["status"] in ("done", "failed") for t in mine(snap)), 150,
                "webhook task settles")
            deadline = time.time() + 20
            while time.time() < deadline and len(received) < 3:
                time.sleep(0.5)
            with lock:
                bodies = [item["body"] for item in received]
            joined = "\n".join(bodies)
            check("webhook received markdown notifications", len(received) >= 3, len(received))
            check("test notification is markdown", "Webhook 测试" in joined, joined[:120])
            check("claimed notification delivered", "任务已领取" in joined, joined[:200])
            check("success notification delivered", "任务执行成功" in joined, joined[:200])
            check("notifications carry a markdown field", '"markdown"' in joined, joined[:160])
            status, state_payload = request(base, "GET", "/secretary/api/state")
            hook_state = (state_payload.get("settings") or {}).get("webhook") or {}
            check("webhook delivery status recorded", hook_state.get("lastStatus") == "ok", hook_state)
            # Feishu adapter: interactive card payload, platform errors surfaced.
            with lock:
                received.clear()
            request(base, "POST", "/secretary/api/settings", {"webhook": {
                "enabled": True, "url": hook_url, "format": "feishu",
                "events": {"claimed": False, "succeeded": False, "blocked": False,
                           "failed": False, "dailyReport": False}}})
            status, payload = request(base, "POST", "/secretary/api/webhook/test", {})
            check("feishu test delivered", status == 200 and payload.get("ok") is True, payload)
            time.sleep(0.5)
            with lock:
                feishu_body = received[-1]["body"] if received else "{}"
            check("feishu payload uses an interactive card", '"msg_type":"interactive"' in feishu_body.replace(" ", ""), feishu_body[:160])
            check("feishu card carries markdown", '"tag":"markdown"' in feishu_body.replace(" ", ""), feishu_body[:160])
            compact = feishu_body.replace(" ", "")
            check("feishu markdown is flattened (no heading markers)",
                  '"## ' not in feishu_body and '"# ' not in feishu_body, feishu_body[:200])
            check("feishu markdown has no literal horizontal rule", '\\n---' not in feishu_body, feishu_body[:200])
            check("feishu markdown keeps bold emphasis", '**' in feishu_body, feishu_body[:200])
            status, payload = request(base, "POST", "/secretary/api/settings", {"webhook": {"url": hook_url + "/bad"}})
            check("feishu error endpoint configured", status == 200, status)
            status, payload = request(base, "POST", "/secretary/api/webhook/test", {})
            check("feishu platform error is surfaced", status == 502 and "19024" in json.dumps(payload, ensure_ascii=False), (status, payload))
            status, state_payload = request(base, "GET", "/secretary/api/state")
            hook_state = (state_payload.get("settings") or {}).get("webhook") or {}
            check("failed delivery is recorded", hook_state.get("lastStatus") == "failed" and "19024" in (hook_state.get("lastError") or ""), hook_state)
            status, log_payload = request(base, "GET", "/secretary/api/webhook/log")
            check("delivery log is readable", status == 200 and isinstance(log_payload.get("log"), list), status)
            status, _ = request(base, "POST", "/secretary/api/settings", {"webhook": {"url": "ftp://bad"}})
            check("invalid webhook url rejected", status == 400, status)
        finally:
            capture.shutdown()
            capture.server_close()

        if args.reorder:
            print("10. reorder (restored afterwards)")
            all_ids = [t["id"] for t in state(base).get("tasks", [])]
            status, payload = request(base, "POST", "/secretary/api/tasks/reorder", {"ids": list(reversed(all_ids))})
            check("reorder accepted", status == 200, status)
            status, _ = request(base, "POST", "/secretary/api/tasks/reorder", {"ids": all_ids[:-1]})
            check("partial reorder rejected", status == 400)

        if args.dispatch:
            print("11. automatic claiming (opt-in; may dispatch your pending tasks)")
            request(base, "POST", "/secretary/api/settings",
                    {"autoStart": True, "concurrency": 3})
            d1 = create_task(base, args, f"{tag}-自动甲", "只回复：甲", status="pending")[1]["task"]["id"]
            d2 = create_task(base, args, f"{tag}-自动乙", "只回复：乙", status="pending")[1]["task"]["id"]
            claimed = wait_until(base, lambda snap: all(
                next((t for t in mine(snap) if t["id"] == task_id), {}).get("status") != "pending"
                for task_id in (d1, d2)), 60, "auto claim started")
            check("auto claim starts tasks", all(
                next((t for t in mine(claimed) if t["id"] == task_id), {}).get("status") in ("running", "blocked", "done")
                for task_id in (d1, d2)))
            wait_until(base, lambda snap: all(
                next((t for t in mine(snap) if t["id"] == task_id), {}).get("status") in ("done", "failed")
                for task_id in (d1, d2)), 180, "auto claimed tasks settle")
            request(base, "POST", "/secretary/api/settings", {"autoStart": original_settings.get("autoStart")})

        if args.reports:
            print("12. daily report generation (opt-in)")
            reports = request(base, "GET", "/secretary/api/reports")[1].get("reports", [])
            today = time.strftime("%Y-%m-%d")
            existing = any(entry.get("date") == today for entry in reports)
            if existing:
                print("     今天已有日报，跳过生成（不会覆盖你的文件）")
            else:
                global REPORT_CREATED
                status, payload = request(base, "POST", "/secretary/api/reports/generate", {})
                check("report generation accepted", status == 200, payload)
                deadline = time.time() + 300
                content = None
                while time.time() < deadline:
                    time.sleep(5)
                    listing = request(base, "GET", "/secretary/api/reports")[1].get("reports", [])
                    if any(entry.get("date") == today for entry in listing):
                        status, content = request(base, "GET",
                                                  f"/secretary/api/reports/content?date={today}")
                        if status == 200:
                            break
                report_text = (content or {}).get("content", "")
                check("report readable + fixed format", status == 200 and content
                      and report_text.startswith("#")
                      and all(heading in report_text for heading in (
                          "今日概览", "今日完成", "当前进展与问题", "明日计划")),
                      report_text[:140])
                check("report is a concise summary", 0 < len(report_text) < 2500, len(report_text))
                check("report omits technical details",
                      "Tokens" not in report_text and "优先级" not in report_text and "token" not in report_text.lower(),
                      report_text[:160])
                report_dir = (state(base).get("settings", {}).get("dailyReport") or {}).get("dir") or ""
                REPORT_CREATED = (os.path.join(report_dir, f"{today}.md"), False)

        if args.evolution:
            print("9. self-evolution API (v9, read-only)")
            status, payload = request(base, "GET", "/secretary/api/evolution")
            if status == 404:
                print("     当前运行的是旧版插件（无 /evolution），跳过 v9 检查；重新启用 bundle 后再跑。")
            else:
                check("GET /evolution 200", status == 200 and payload.get("ok") is True, status)
                settings = payload.get("settings") or {}
                check("evolution settings present",
                      isinstance(settings, dict)
                      and settings.get("interval") in ("daily", "weekly")
                      and isinstance(settings.get("time"), str)
                      and settings.get("skillMode") in ("off", "ask", "auto"),
                      settings)
                check("evolution lists lessons/skills/retrospectives",
                      isinstance(payload.get("lessons"), list)
                      and isinstance(payload.get("skills"), list)
                      and isinstance(payload.get("retrospectives"), list))
                check("evolution reports skill availability and running state",
                      isinstance(payload.get("skillsAvailable"), bool)
                      and isinstance(payload.get("running"), bool))
                for skill in payload.get("skills") or []:
                    check("evolution skill meta has no content field",
                          "content" not in skill, skill.get("name"))
                    break
                status, payload = request(base, "GET", "/secretary/api/evolution/content?date=2000-01-01")
                check("missing retrospective -> 404", status == 404, payload)
                status, payload = request(base, "GET", "/secretary/api/evolution/content?date=not-a-date")
                check("invalid retrospective date -> 400", status == 400, payload)
                status, payload = request(base, "GET", "/secretary/api/evolution/skills/content?name=no-such-skill")
                check("missing skill -> 404", status == 404, payload)
                status, payload = request(base, "POST", "/secretary/api/evolution/generate", {"date": "bad-date"})
                check("invalid retrospective generate date -> 400", status == 400, payload)
                status, payload = request(base, "POST", "/secretary/api/evolution/lessons", {})
                check("lesson without text -> 400", status == 400, payload)
                status, payload = request(base, "POST", "/secretary/api/evolution/lessons/update", {"id": "no-such-lesson"})
                check("unknown lesson update -> 404", status == 404, payload)
                status, payload = request(base, "POST", "/secretary/api/evolution/skills/action",
                                          {"name": "no-such-skill", "action": "adopt"})
                check("unknown skill action target -> 404", status == 404, payload)
                status, payload = request(base, "POST", "/secretary/api/evolution/skills/action",
                                          {"name": "no-such-skill", "action": "nonsense"})
                check("unknown skill action -> 400", status == 400, payload)
                snapshot = state(base)
                meta = snapshot.get("evolution")
                check("/state carries evolution meta",
                      isinstance(meta, dict) and isinstance(meta.get("lessonCount"), int)
                      and isinstance(meta.get("proposedSkillCount"), int)
                      and meta.get("lastStatus") in ("idle", "running", "ok", "failed"),
                      meta)
    finally:
        if args.keep:
            print("（--keep：保留本次创建的自检任务，请手动清理）")
        else:
            restore_original(base)
            print("已清理本次自检任务，并恢复设置与顺序。")

    print()
    if FAILURES:
        print(f"{len(FAILURES)}/{CHECKS} checks failed:")
        for failure in FAILURES:
            print(" -", failure)
        return 1
    print(f"all {CHECKS} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
