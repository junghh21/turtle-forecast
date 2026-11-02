import argparse
import base64
import hashlib
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATE = ROOT / ".loop"
CONFIG = STATE / "config.json"
DEFAULT_URL = "https://host.example.invalid/api/loop/ingest"

def sh(*cmd, limit=20000, timeout=60):
    try:
        p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=timeout)
        return (p.stdout + p.stderr)[-limit:].rstrip()
    except Exception as e:
        return f"<{cmd[0]} failed: {e}>"


def config():
    c = {"url": DEFAULT_URL, "loop_id": "", "interval": 20}
    if CONFIG.exists():
        c.update(json.loads(CONFIG.read_text()))
    c["url"] = os.environ.get("LOOP_URL", c["url"])
    c["loop_id"] = os.environ.get("LOOP_ID", c["loop_id"])
    return c


def snapshot(reason="watch", note=""):
    test = STATE / "test.txt"
    base = config().get("base", "")
    upstream = sh("git", "rev-parse", "--abbrev-ref", "@{upstream}")
    ahead = sh("git", "rev-list", "--count", f"{upstream}..HEAD") if "fatal" not in upstream else ""
    return {
        "reason": reason,
        "note": note[:500],
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "cwd": str(ROOT),
        "branch": sh("git", "rev-parse", "--abbrev-ref", "HEAD"),
        "head": sh("git", "log", "-1", "--format=%h %s"),
        "ahead_of_upstream": ahead,
        "status": sh("git", "status", "--porcelain", limit=6000),
        "log": sh("git", "log", "-12", "--format=%h %ad %s", "--date=format:%H:%M:%S"),
        "base": base[:12],
        "commits_since_base": sh("git", "log", "--format=%h %s", f"{base}..HEAD", limit=4000) if base else "",
        "diff_since_base": sh("git", "diff", "--stat", "--patch", "-M", base, "HEAD", limit=30000) if base else "",
        "last_commit": sh("git", "show", "--stat", "--patch", "-M", "HEAD", limit=12000),
        "uncommitted_diff": sh("git", "diff", "HEAD", limit=12000),
        "files": sh("git", "ls-files", limit=6000),
        "test": test.read_text()[-6000:] if test.exists() else "",
    }


SITE = ROOT / "site"
SITE_MAX_BYTES = 4_000_000
SITE_MAX_FILES = 300


def site_files():
    if not SITE.is_dir():
        return None
    out, total = [], 0
    for p in sorted(SITE.rglob("*")):
        if not p.is_file():
            continue
        data = p.read_bytes()
        total += len(data)
        if len(out) >= SITE_MAX_FILES or total > SITE_MAX_BYTES:
            raise SystemExit(f"site/ is too big to publish (max {SITE_MAX_FILES} files, {SITE_MAX_BYTES} bytes)")
        out.append({"path": p.relative_to(SITE).as_posix(), "b64": base64.b64encode(data).decode()})
    return out


def fingerprint(s):
    keep = {k: s[k] for k in ("head", "status", "uncommitted_diff", "test")}
    return hashlib.sha1(json.dumps(keep, sort_keys=True).encode()).hexdigest()


def send(s):
    c = config()
    if not c["loop_id"]:
        print("no loop_id: run `python main.py init <loop_id>` first", file=sys.stderr)
        return False
    STATE.mkdir(exist_ok=True)
    body = STATE / "outbox.json"
    body.write_text(json.dumps(s))
    p = subprocess.run(
        ["curl", "-sS", "-m", "30", "-X", "POST", "-H", "content-type: application/json",
         "--data-binary", f"@{body}", f"{c['url'].rstrip('/')}/{c['loop_id']}"],
        capture_output=True, text=True)
    ok = p.returncode == 0 and '"ok":true' in p.stdout.replace(" ", "")
    with open(STATE / "send.log", "a") as f:
        f.write(f"{s['ts']} {s['reason']} rc={p.returncode} {(p.stdout + p.stderr).strip()[:200]}\n")
    return ok


def summary(s):
    lines = s["status"].splitlines()
    tail = [l for l in s["test"].splitlines() if l.strip()][-2:]
    return f"[loop] {s['reason']} head={s['head']} changed={len(lines)} test={' | '.join(tail) or 'none'}"


def cmd_init(a):
    STATE.mkdir(exist_ok=True)
    c = config()
    c["loop_id"] = a.loop_id
    c["base"] = sh("git", "rev-parse", "HEAD")
    if a.url:
        c["url"] = a.url
    CONFIG.write_text(json.dumps(c))
    print("loop configured:", c["url"], c["loop_id"][:8] + "...")
    return 0


def cmd_push(a):
    s = snapshot("done" if a.done is not None else "push", a.done or a.note or "")
    if a.done is not None:
        (ROOT / "loop-turn.md").write_text(f"{s['ts']} {s['head']}\n{s['note']}\n")
    site = site_files()
    if site is not None:
        s["site"] = site
    ok = send(s)
    s.pop("site", None)
    print(summary(s), f"site={len(site)} files" if site is not None else "", "sent" if ok else "NOT SENT (see .loop/send.log)")
    return 0 if ok else 1


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def cmd_watch(a):
    pidf = STATE / "watch.pid"
    if a.status or a.stop:
        pid = int(pidf.read_text()) if pidf.exists() else 0
        alive = bool(pid) and pid_alive(pid)
        if a.stop and alive:
            os.kill(pid, signal.SIGTERM)
        print("watch", "running" if alive and not a.stop else "stopped" if a.stop else "not running", pid or "")
        return 0 if alive else 1
    STATE.mkdir(exist_ok=True)
    pidf.write_text(str(os.getpid()))
    last, beat = "", 0.0
    while True:
        try:
            s = snapshot("watch")
            fp = fingerprint(s)
            if fp != last or time.time() - beat > 300:
                if send(s):
                    last, beat = fp, time.time()
        except Exception as e:
            with open(STATE / "send.log", "a") as f:
                f.write(f"watch error {e}\n")
        time.sleep(max(5, int(config()["interval"])))


def js_files():
    out = sh("git", "ls-files", "*.js", "*.mjs", limit=20000)
    return [f for f in out.splitlines() if f and not f.startswith(("node_modules/", "dist_pages/", "extension/"))]


def lint_cmd():
    files = js_files()
    if not files:
        return None
    return ["sh", "-c", "rc=0; for f in " + " ".join(files) + '; do node --check "$f" || rc=1; done; exit $rc']


def cmd_test(a):
    STATE.mkdir(exist_ok=True)
    if (ROOT / "tests").is_dir():
        cmd = ["node", "--test", "tests/"]
    else:
        cmd = [sys.executable, "-c", "print('no tests yet')"]
    t0 = time.time()
    p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    out = (p.stdout + p.stderr)[-7000:]
    lint, lint_rc = lint_cmd(), None
    lint_out = "no linter installed"
    if lint:
        q = subprocess.run(lint, cwd=ROOT, capture_output=True, text=True)
        lint_rc, lint_out = q.returncode, (q.stdout + q.stderr).strip()[-2500:] or "clean"
    head = sh("git", "rev-parse", "--short=12", "HEAD")
    clean = not sh("git", "status", "--porcelain", "--untracked-files=no", "--", ".", ":!loop-turn.md")
    (STATE / "test.txt").write_text(
        f"$ {' '.join(cmd[1:])}\n{out}\n--- lint ({'node --check' if lint else 'none'}) rc={lint_rc}\n{lint_out}\n"
        f"exit={p.returncode} lint_rc={lint_rc} head={head} clean={clean} secs={time.time() - t0:.1f}\n")
    print(out)
    print("lint:", lint_out[-1500:])
    print("exit", p.returncode)
    if config()["loop_id"]:
        send(snapshot("test"))
    return p.returncode


def main(argv=None):
    p = argparse.ArgumentParser(prog="main.py")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("test"); s.set_defaults(fn=cmd_test)
    s = sub.add_parser("init"); s.add_argument("loop_id"); s.add_argument("--url"); s.set_defaults(fn=cmd_init)
    s = sub.add_parser("push"); s.add_argument("--note"); s.add_argument("--done", nargs="?", const=""); s.set_defaults(fn=cmd_push)
    s = sub.add_parser("watch"); s.add_argument("--status", action="store_true"); s.add_argument("--stop", action="store_true"); s.set_defaults(fn=cmd_watch)
    a = p.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
