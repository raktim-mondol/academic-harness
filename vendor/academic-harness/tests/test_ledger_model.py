"""Randomised model check of the rule the rubric tier lives by: only a valid "no" clears a finding; uncertainty carries it.

A scripted reviewer answers each paragraph from a random plan (yes / no / unclear / unverifiable / error). After every audit a tiny reference model
says what the ledger and `ah done` must show. The point is to look for a sequence nobody thought of: the unit tests of the fix cover the sequences
its author imagined, this covers the rest.
"""
from __future__ import annotations

import json
import random
import re

import pytest

from ah.audit import audit
from ah.context import build_context
from ah.project import Project
from ah.verifier.backends import Completion, FakeBackend, configured_identity
from test_done import admitted_project, tiers_tr

N = 12
ANSWERS = ["yes", "no", "unclear", "unverifiable", "error"]


class Scripted(FakeBackend):
    def __init__(self, plan: dict[int, str]):
        super().__init__(lambda _: "", "m1")
        self._identity = configured_identity({"verifier": {"backend": "http", "url": "http://127.0.0.1:9/v1", "model": "m1"}})
        self.plan = plan

    def complete(self, prompt: str) -> Completion:
        self.calls += 1
        text = re.search(r"<paragraph>\n(.*?)\n</paragraph>", prompt, re.S).group(1)
        num = re.search(r"Paragraph (\d+)", text)
        a = self.plan[int(num.group(1))] if num else "no"             # the fixture's other sections are plain
        if a == "error":
            return Completion(error="endpoint unavailable", usage={"input": 3, "output": 0})
        if a == "yes":
            return Completion(json.dumps({"answer": "yes", "quote": text[:30], "note": "n"}), {"input": 3, "output": 1})
        if a == "unverifiable":                   # a yes whose quote is not in the paragraph, twice
            return Completion(json.dumps({"answer": "yes", "quote": "words that are not in this paragraph at all", "note": "n"}), {"input": 3, "output": 1})
        return Completion(json.dumps({"answer": a, "quote": "", "note": ""}), {"input": 3, "output": 1})


def open_paragraphs(project_dir, rep) -> set[int]:
    by_ref = {(u.uid or f"{u.file}#{u.hash}"): int(re.search(r"Paragraph (\d+)", u.norm).group(1))
              for u in build_context(Project(str(project_dir))).units if "Paragraph" in u.norm}
    return {by_ref[f["unit"]] for f in rep["findings"] if f["check"] == "RUB-01" and f["state"] in ("open", "decision-needed") and f["unit"] in by_ref}


@pytest.mark.parametrize("seed", range(10))
def test_the_ledger_follows_the_rule_for_any_sequence_of_answers(project_dir, seed):
    admitted_project(project_dir)
    rnd = random.Random(seed)
    state = {i: "none" for i in range(N)}            # none -> open -> fixed -> open ...
    for step in range(8):
        plan = {i: rnd.choice(ANSWERS) for i in range(N)}
        if step == 0:
            plan = {i: ("yes" if i % 2 else "no") for i in range(N)}      # start from a known set of open findings
        fixed_now = 0
        for i, a in plan.items():
            if a == "yes":
                state[i] = "open"
            elif a == "no" and state[i] == "open":
                state[i] = "fixed"
                fixed_now += 1
        rep = audit(Project(str(project_dir)), tiers_tr(), rubric_backend=Scripted(plan), use_cache=False, rubric_criteria=["RUB-GENERAL"])
        want_open = {i for i, s in state.items() if s == "open"}
        got_open = open_paragraphs(project_dir, rep)
        ctx = f"seed {seed} step {step} plan {plan}"
        assert got_open == want_open, f"{ctx}: open findings {sorted(got_open)} != expected {sorted(want_open)}"
        assert rep["ledger"]["fixed"] == fixed_now, f"{ctx}: ledger fixed {rep['ledger']['fixed']} != {fixed_now}"
        unresolved = {i for i, a in plan.items() if a not in ("yes", "no")}
        assert rep["rubric_run"]["pairs"] > N
        status = rep["done"]["status"]
        if want_open:
            assert status == "fail", f"{ctx}: open admitted findings but done is {status}"
        elif unresolved:
            assert status == "incomplete", f"{ctx}: uncertain pairs with nothing open must be INCOMPLETE, not {status}"
        else:
            assert status == "pass", f"{ctx}: everything resolved and clean, yet done is {status}"
        run = rep["rubric_run"]
        assert run["unresolved_count"] == len(unresolved), ctx
        retried = sum(1 for a in plan.values() if a == "unverifiable")      # a quote that is not in the paragraph gets one correction request
        assert run["calls"] == run["pairs"] + retried, f"{ctx}: every request, failed or not, is counted ({run['calls']} for {run['pairs']} pairs + {retried} retries)"
