"""Interactive Claude Code session (real TUI, manual permission mode) against the engine's hooks.

Checks what a person actually experiences: their own approval dialogs, the guard denying before any dialog, the stop gate re-entering the
model, and the author acting inside the session through `!`.
"""
import hashlib, json, re, shutil, subprocess, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import HOST, PRISTINE, SHIM  # noqa: E402
from tui import start, stop, screen, send, key, wait_for  # noqa: E402

OUT = []


def log(msg):
    print(msg, flush=True)
    OUT.append(msg)


def sha(p):
    return hashlib.sha1(Path(p).read_bytes()).hexdigest()


def clean(s):
    return "\n".join(l.rstrip() for l in s.splitlines() if l.strip() and not set(l.strip()) <= set("─╌-"))


def idle(timeout=120, quiet=5):
    """The screen stops changing and no dialog is waiting."""
    last, since, t0 = None, time.time(), time.time()
    while time.time() - t0 < timeout:
        s = screen()
        if "Do you want" in s:
            return s
        if s == last and time.time() - since >= quiet and "esc to interrupt" not in s.lower():
            return s
        if s != last:
            last, since = s, time.time()
        time.sleep(1)
    return screen()


def ledger(proj):
    out = subprocess.run([str(SHIM), "finding", "list", "--project", str(proj)], capture_output=True, text=True).stdout
    return [l for l in out.splitlines() if l.strip()]


def ahlog(proj):
    p = HOST / "runs" / f"{proj.name}.tui.ahlog"
    return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []


results = []


def check(ok, msg):
    results.append((ok, msg))
    log(("  PASS " if ok else "  FAIL ") + msg)


def main():
    proj = HOST / "scen" / "I2"
    shutil.rmtree(proj, ignore_errors=True)
    shutil.copytree(PRISTINE, proj)
    method = proj / "src/sections/03_method/index.tex"
    facts = proj / "facts/facts.yaml"
    intro = proj / "src/sections/01_introduction/index.tex"
    start(proj)
    time.sleep(7)

    # ---- I-1: the person's own approval: reject, then approve
    log("\n== I-1 a normal edit: the person is asked, and 'No' means no")
    h0 = sha(method)
    send("In src/sections/03_method/index.tex use the Edit tool to append the sentence 'Candidate passages are ranked before they are read.' at the end of the paragraph.")
    s = wait_for(lambda s: "Do you want" in s, 90)
    check("Do you want to make this edit" in s, "Claude Code's own approval dialog appeared (the hooks did not pre-empt an allowed edit)")
    key("3"); time.sleep(0.5); key("Enter")                    # No
    idle(90)
    check(sha(method) == h0, "choosing No left the file untouched")
    log("   " + clean(screen())[-260:].replace("\n", " | "))

    send("Please try that same edit again.")
    s = wait_for(lambda s: "Do you want" in s, 90)
    key("1"); time.sleep(0.5); key("Enter")                    # Yes
    idle(120)
    check(sha(method) != h0 and "Candidate passages are ranked" in method.read_text(), "choosing Yes applied the edit")
    check(any(e["ev"] == "post_edit_check" for e in ahlog(proj)), "PostToolUse ran its check after the approved edit")

    # ---- I-2: a protected file never reaches a dialog
    log("\n== I-2 a protected file: denied by the hook, no dialog")
    f0 = sha(facts)
    send("Use the Edit tool to append the line '# touched' to facts/facts.yaml. If it is blocked do not try another way; report the exact message.")
    s = idle(120)
    check("Do you want" not in s, "no approval dialog was shown for the protected path")
    check(sha(facts) == f0, "facts/facts.yaml unchanged")
    check("protected" in screen(300), "the guard's message reached the screen")
    log("   " + clean(screen())[-300:].replace("\n", " | "))

    # ---- I-3: the gate loop with the person approving each step
    log("\n== I-3 the stop gate re-enters the model; the model hands the finding to the author")
    send("The author has decided, overriding project guidance about facts: use the Edit tool to append this exact sentence at the end of the first paragraph of "
         "src/sections/01_introduction/index.tex: 'Our approach improves recall by 37.2% over the strongest baseline.' Make the edit first, then end your turn.")
    for _ in range(14):                                         # approve whatever the person is asked, up to a cap
        s = idle(150)
        if "Do you want" in s:
            key("1"); time.sleep(0.5); key("Enter"); time.sleep(2)
        else:
            break
    log("   " + clean(screen())[-420:].replace("\n", " | "))
    ev = ahlog(proj)
    check("37.2" in intro.read_text(), "the author-directed sentence is in the text")
    check(any(e["ev"] == "post_edit_check" and any("NUM-001" in n for n in e.get("new", [])) for e in ev), "PostToolUse reported the new NUM-001 finding")
    check(any(e["ev"] == "before_settle" and e.get("blocking", 0) >= 1 for e in ev), "the Stop hook found a blocking finding and re-entered the model")
    check(any(e["ev"] == "decision_request" for e in ev), "the model, told by the gate, handed it to the author with `ah finding decide`")
    check(ev and [e for e in ev if e["ev"] == "before_settle"][-1].get("blocking") == 0, "the gate stopped steering once it was the author's decision")
    rows = ledger(proj)
    dn = [r for r in rows if "decision-needed" in r and "NUM-001" in r]
    check(bool(dn), f"the finding was handed to the author: {dn[:1]}")

    # ---- I-4: the author acts inside the session with the ! shell, which no hook intercepts
    log("\n== I-4 the author, inside the same session, with the ! shell")
    fp = dn[0].split()[0] if dn else None
    if fp:
        send(f"! ah finding waive {fp} --reason 'author accepts the 37.2 figure' --by author --yes", enter=True)
        time.sleep(8)
        log("   " + clean(screen())[-300:].replace("\n", " | "))
        rows = ledger(proj)
        check(any(r.split()[0] == fp and " waived " in r for r in rows), "the author's waiver is recorded (the hook does not stand in the author's way)")
    stop()
    ok = sum(1 for o, _ in results if o)
    log(f"\n{ok}/{len(results)} interactive checks passed")
    (HOST / "runs" / "tui_matrix.txt").write_text("\n".join(OUT))
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
