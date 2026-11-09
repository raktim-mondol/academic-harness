"""Failure-path regressions: uncertain evidence must never look like a clean verdict."""
import json
import sys

import pytest
import yaml

from ah.audit import audit
from ah.checks.base import DEFAULT_TIERS
from ah.checks.rubric import run_rubric
from ah.cli import main
from ah.context import build_context
from ah.project import Project
from ah.rubric import load_criteria, load_admissions, admitted_ids
from ah.verifier.backends import Completion, FakeBackend, get_backend
from test_done import admitted_project
from test_rubric import fake, set_cfg


@pytest.mark.parametrize("answer", ["unclear", "unverifiable", "error"])
def test_unresolved_verdict_preserves_admitted_finding(project_dir, answer):
    admitted_project(project_dir)
    first = audit(Project(project_dir), DEFAULT_TIERS + ("TR",), rubric_backend=fake(), use_cache=False)
    ids = {f["fingerprint"] for f in first["findings"] if f["check"] == "RUB-01"}
    assert ids
    b = fake(lambda _: json.dumps({"answer": "yes" if answer == "unverifiable" else answer,
                                  "quote": "this quote is not in the manuscript", "note": "uncertain"}))
    if answer == "error":
        b.complete = lambda _: Completion(error="endpoint unavailable")
    second = audit(Project(project_dir), DEFAULT_TIERS + ("TR",), rubric_backend=b, use_cache=False)
    assert ids <= {f["fingerprint"] for f in second["findings"]}
    assert second["ledger"]["fixed"] == 0
    assert second["done"]["status"] == "fail"
    before = (project_dir / ".ah/ledger.sqlite").read_bytes()
    readonly = audit(Project(project_dir), DEFAULT_TIERS + ("TR",), use_ledger=False,
                     rubric_backend=b, use_cache=False)
    assert readonly["done"]["status"] == "fail"
    assert (project_dir / ".ah/ledger.sqlite").read_bytes() == before


def test_unclear_is_incomplete_and_admitted_info_still_fails(project_dir):
    admitted_project(project_dir, level="info")
    p = Project(project_dir)
    uncertain = audit(p, DEFAULT_TIERS + ("TR",), rubric_backend=fake(lambda _: '{"answer":"unclear"}'), use_cache=False)
    assert uncertain["done"]["status"] == "incomplete"
    bad = audit(p, DEFAULT_TIERS + ("TR",), rubric_backend=fake(), use_cache=False)
    assert bad["done"]["status"] == "fail"
    clean = audit(p, DEFAULT_TIERS + ("TR",), rubric_backend=fake(lambda _: '{"answer":"no"}'), use_cache=False)
    assert clean["done"]["status"] == "pass" and clean["ledger"]["fixed"] > 0


def test_failed_calls_count_and_retries_respect_budget(project_dir):
    b = fake()
    b.complete = lambda _: Completion(error="outage", usage={"input": 7, "output": 2})
    _, stats = run_rubric(build_context(Project(project_dir)), b, use_cache=False, limit=2)
    assert stats["calls"] == stats["errors"] == 2
    assert stats["tokens_in"] == 14
    b = fake(lambda _: '{"answer":"yes","quote":"nonexistent words"}')
    _, stats = run_rubric(build_context(Project(project_dir)), b, use_cache=False, limit=3)
    assert b.calls == stats["calls"] == 3


@pytest.mark.parametrize("scope", ["invalid", ["bad"], {"files": 42}, {"kinds": 42},
                                    {"min_words": "abc"}, {"min_words": True}, {"min_words": -1}])
def test_malformed_scope_reports_rub02(project_dir, scope):
    path = project_dir / "rubric/test.yaml"
    path.parent.mkdir(exist_ok=True)
    path.write_text(yaml.safe_dump({"criteria": [{"id": "RUB-BAD", "question": "Does this paragraph make an unsupported claim?", "scope": scope}]}))
    _, problems = load_criteria(Project(project_dir))
    assert problems
    rep = audit(Project(project_dir), DEFAULT_TIERS + ("TR",))
    assert any(f["check"] == "RUB-02" for f in rep["findings"])


def test_invalid_admission_cannot_silently_pass(project_dir):
    set_cfg(project_dir, gate={"blocking_levels": []})
    path = project_dir / "rubric/admissions.yaml"
    path.parent.mkdir(exist_ok=True)
    path.write_text('admitted: "not a mapping"\n')
    assert main(["done", "--project", str(project_dir)]) == 1


def test_command_identity_uses_complete_argv():
    from ah.verifier.backends import configured_identity
    prefix = ["python3", "/long/" + "adapter/" * 12 + "run.py"]
    def config(args):
        return {"verifier": {"backend": "command", "cmd": args, "revision": "1"}}
    a, b = config(prefix + ["openai/model-a"]), config(prefix + ["openai/model-b"])
    assert configured_identity(a) != configured_identity(b)
    assert configured_identity(a) == get_backend(a).identity
    assert configured_identity(config(["a b", "c"])) != configured_identity(config(["a", "b c"]))


def test_migration_covers_custom_includes_and_appendix(tmp_path):
    from ah.migrate import scan
    (tmp_path / "main.tex").write_text(r"\documentclass{article}\begin{document}\input{sections/intro}\input{appendix/details}\input{custom/notes}\end{document}")
    for rel in ["sections/intro.tex", "appendix/details.tex", "custom/notes.tex"]:
        f = tmp_path / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text("This is substantive prose with enough words to constitute a paragraph for the audit engine.")
    s = scan(tmp_path)
    covered = {f.relative_to(tmp_path).as_posix() for g in s["prose_globs"] for f in tmp_path.glob(g)}
    assert {"sections/intro.tex", "appendix/details.tex", "custom/notes.tex"} <= covered


def test_cached_uncertainty_and_deliberate_retry(project_dir):
    admitted_project(project_dir)
    (project_dir / ".ah/verdicts.sqlite").unlink()  # discard fixture admission's labelled verdicts only
    p = Project(project_dir)
    ctx = build_context(p)
    b = fake(lambda _: '{"answer":"unclear"}')
    _, cold = run_rubric(ctx, b)
    assert cold["unresolved_count"] == cold["pairs"]
    _, warm = run_rubric(ctx, fake())
    assert warm["calls"] == 0 and warm["unresolved_count"] == cold["pairs"]
    _, retry = run_rubric(ctx, fake(), retry_unresolved=True, limit=2)
    assert retry["calls"] == 2


def test_uncertain_labels_cannot_be_admitted(project_dir, monkeypatch, capsys):
    from test_rubric import replace_section, make_labels
    replace_section(project_dir, {1, 3, 5, 7, 9, 11}, 12)
    labels = make_labels(project_dir, {1, 3, 5, 7, 9, 11}, 12)
    set_cfg(project_dir, verifier={"backend": "http", "url": "http://127.0.0.1:9/v1", "model": "m1"})
    monkeypatch.setattr("ah.cli._build_backend", lambda *_: fake(lambda _: '{"answer":"unclear"}'))
    capsys.readouterr()
    code = main(["rubric", "admit", "RUB-GENERAL", "--project", str(project_dir), "--labels", str(labels), "--yes", "--json"])
    result = json.loads(capsys.readouterr().out)
    assert code == 1 and not result["admitted"] and result["agreement"]["n"] == 0
    assert len(result["skipped"]["not_judged"]) == 12


def test_admission_identity_switch_and_legacy_records(project_dir):
    admitted_project(project_dir)
    assert admitted_ids(Project(project_dir)) == ["RUB-GENERAL"]
    set_cfg(project_dir, verifier={"backend": "http", "url": "http://localhost:999/v1", "model": "m1"})
    assert not admitted_ids(Project(project_dir)), "same model, different endpoint cannot keep the admission"
    path = project_dir / "rubric/admissions.yaml"
    data = yaml.safe_load(path.read_text())
    data["admitted"]["RUB-GENERAL"].pop("protocol")
    path.write_text(yaml.safe_dump(data))
    set_cfg(project_dir, verifier={"backend": "http", "url": "http://127.0.0.1:9/v1", "model": "m1"})
    assert not admitted_ids(Project(project_dir)), "legacy scoring protocol must be remeasured"
    rep = audit(Project(project_dir), DEFAULT_TIERS + ("TR",))
    assert rep["rubric_run"]["invalidated_admissions"] == ["RUB-GENERAL"]


def test_old_falsely_fixed_finding_recovers_without_rewriting_history(project_dir):
    from ah.ledger.db import Ledger
    admitted_project(project_dir)
    p = Project(project_dir)
    first = audit(p, DEFAULT_TIERS + ("TR",), rubric_backend=fake())
    led = Ledger(p)
    led.db.execute("UPDATE findings SET state='fixed' WHERE check_id='RUB-01'")
    led.db.commit()
    old_runs = len(led.all_run_manifests())
    led.close()
    recovered = audit(p, DEFAULT_TIERS + ("TR",), rubric_backend=fake(), use_cache=False)
    assert recovered["ledger"]["regressed"] == 6 and not recovered["unexplained"]
    led = Ledger(p)
    assert len(led.all_run_manifests()) == old_runs + 1
    led.close()


def test_command_envelope_usage_and_model_validation(tmp_path):
    from ah.verifier.backends import CommandBackend
    script = tmp_path / "adapter.py"
    script.write_text('import json; print(json.dumps({"version":1,"model":"m","text":"ok","usage":{"input":5,"output":2}}))')
    b = CommandBackend([sys.executable, str(script)], model="m", response_format="json-v1")
    c = b.complete("prompt")
    assert c.text == "ok" and c.usage == {"input": 5, "output": 2}
    b.model = "other"
    assert "model" in b.complete("prompt").error


def test_opencode_event_parser_rejects_partial_tool_and_error_responses():
    from ah.verifier.opencode import parse_events
    events = [{"type": "text", "part": {"text": "{}"}},
              {"type": "step_finish", "part": {"reason": "stop", "tokens": {"input": 3, "output": 2}}}]
    assert parse_events("\n".join(map(json.dumps, events))) == ("{}", {"input": 3, "output": 2, "cache_read": 0})
    for extra in ({"type": "error"}, {"type": "tool_use"}):
        with pytest.raises(ValueError):
            parse_events("\n".join(map(json.dumps, events + [extra])))
    with pytest.raises(ValueError):
        parse_events(json.dumps(events[0]))


def test_omitted_included_prose_is_reported(project_dir):
    root = project_dir / "src"
    (root / "extra.tex").write_text("This appendix contains a scientific observation with sufficient words to be independently audited by the writing compiler.")
    v = root / "views/main.tex"
    v.write_text(v.read_text().replace(r"\end{document}", "\\input{extra}\n\\end{document}"))
    rep = audit(Project(project_dir))
    assert any(f["check"] == "UNIT-04" for f in rep["findings"])


def test_state_reads_uncertain_carried_rubric_without_spending(project_dir):
    from ah.state import build_state
    admitted_project(project_dir)
    p = Project(project_dir)
    audit(p, DEFAULT_TIERS + ("TR",), rubric_backend=fake())
    audit(p, DEFAULT_TIERS + ("TR",), rubric_backend=fake(lambda _: '{"answer":"unclear"}'), use_cache=False)
    assert "Done: FAIL" in build_state(p)


def test_pi_has_no_hidden_transport_retries():
    from ah.verifier.backends import PiBackend, PolicyError
    with pytest.raises(PolicyError, match="budget"):
        PiBackend("provider", "model", retries=1)


@pytest.mark.parametrize("config", ["bad", {"workers": True}, {"files": 12}, {"off": [12]}, {"min_words": -1}])
def test_invalid_criteria_config_is_a_diagnostic(project_dir, config):
    set_cfg(project_dir, criteria=config)
    assert load_criteria(Project(project_dir))[1]
    assert audit(Project(project_dir), DEFAULT_TIERS + ("TR",))["done"]["status"] == "fail"


def test_readonly_rubric_does_not_create_a_cache(project_dir):
    cache = project_dir / ".ah/verdicts.sqlite"
    assert not cache.exists()
    run_rubric(build_context(Project(project_dir)))
    assert not cache.exists()
