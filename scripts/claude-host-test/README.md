# Claude Code host test

Real Claude Code sessions against the writing compiler's hooks (`ah hook userprompt|pre|post|stop`), headless and in the real terminal UI.
It checks what a unit test cannot: that Claude Code actually calls the hooks, that a denial reaches the model, that the stop gate re-enters
the model, and that the host's own approval dialogs and the hooks work together. It uses your Claude Code login and spends a few cents per
scenario with Haiku.

**Safety.** Each session runs inside bubblewrap (`bwrap`): the whole filesystem is read-only except the scratch project, a `runs/` directory
and Claude's own state. The agent has a shell; this keeps a confused model from touching anything else. `--setting-sources project` and
`--strict-mcp-config` keep your global hooks, plugins and MCP servers out of the test. Needs `claude`, `bwrap`, `tmux` (UI only), Python 3.

```sh
export AH_HOST_TEST_DIR=~/.cache/ah-claude-host            # default; keep it off tmpfs
python3 scripts/claude-host-test/mkproj.py "$AH_HOST_TEST_DIR/proj-pristine"      # fixture project + hooks + an `ah` shim for THIS checkout
python3 scripts/claude-host-test/scenarios.py                                    # all headless scenarios, Haiku
python3 scripts/claude-host-test/scenarios.py --model=claude-sonnet-5-5 A4_new_acts B1_gate_loop
python3 scripts/claude-host-test/tui_matrix.py                                   # the real TUI in tmux: approvals, protected edit, stop gate, `!` waiver
```

| Scenario | What it asserts |
|---|---|
| `A1_protected_edit`, `A2_protected_shell`, `A7_hook_settings` | a protected file (`facts/facts.yaml`, `ah.yaml`, `.claude/settings.json`) is denied by the hook and left byte-identical |
| `A3_waive`, `A4_new_acts`, `A5_pty_trick`, `A5b_explicit_pty` | the author's acts (waive, `rule accept`, `disclosure approve`, `provenance set`, a command wrapped in a pty) are denied to the agent |
| `A6_anchor_loss` | a rewrite that drops `%% @unit` anchors is denied |
| `B1_gate_loop` | an edit that adds an unbound number: post-edit note, Stop hook blocks and re-enters the model, the model hands the finding to the author |
| `B2_clean_edit` | a plain edit is allowed and the gate stays quiet |

`tui_matrix.py` (14 checks): Claude Code's own approval dialog appears for an allowed edit and "No" leaves the file untouched; a protected edit
gets no dialog at all; the stop gate blocks and the model answers with `ah finding decide`; the author then waives the finding from inside the
session with `! ah finding waive ... --yes`.

A hook that exits non-zero, crashes, or prints a traceback is reported as a failure. The event stream of each run is kept in `runs/<name>.jsonl`
and the hooks' own log in `runs/<name>.ahlog`.
