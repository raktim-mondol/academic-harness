"""Drive the real Claude Code TUI in tmux (inside the bubblewrap sandbox) and read the screen back."""
import os, re, shutil, subprocess, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import HOST, PRISTINE, SHIM  # noqa: E402
from run_session import sandbox, DROP  # noqa: E402

SESSION = "ahtui"

def tmux(*a, check=True):
    return subprocess.run(["tmux", *a], capture_output=True, text=True, check=check).stdout

def start(project: Path, model="claude-haiku-5-5", mode="default", extra=""):
    subprocess.run(["tmux", "kill-session", "-t", SESSION], capture_output=True)
    env = " ".join(f"-u {v}" for v in DROP)
    box = " ".join(f"'{x}'" if " " in x else x for x in sandbox(project))
    runs = HOST / "runs"
    cmd = (f"cd {project} && env {env} PATH={SHIM.parent}:$PATH AH_LOG={runs/(project.name+'.tui.ahlog')} {box} "
           f"env -u CLAUDECODE claude --model {model} --setting-sources project --strict-mcp-config --disable-slash-commands --permission-mode {mode} {extra}")
    tmux("new-session", "-d", "-s", SESSION, "-x", "200", "-y", "55", cmd)

def screen(history=0):
    a = ["capture-pane", "-p", "-t", SESSION]
    if history: a += ["-S", f"-{history}"]
    return tmux(*a, check=False)

def send(text, enter=True):
    tmux("send-keys", "-t", SESSION, "-l", text)
    if enter:
        time.sleep(0.4); tmux("send-keys", "-t", SESSION, "Enter")

def key(k): tmux("send-keys", "-t", SESSION, k)

def wait_for(pred, timeout=90, every=1.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        s = screen()
        if pred(s): return s
        time.sleep(every)
    return screen()

def stop():
    subprocess.run(["tmux", "kill-session", "-t", SESSION], capture_output=True)

if __name__ == "__main__":
    proj = HOST / "scen" / "I0"
    shutil.rmtree(proj, ignore_errors=True); shutil.copytree(PRISTINE, proj)
    start(proj)
    time.sleep(6)
    print(screen())
    stop()
