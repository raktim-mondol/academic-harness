#!/usr/bin/env python3
"""Statistical power, sample size, effect sizes, multiplicity correction, simulation.

Reads one JSON request on stdin, writes one JSON result on stdout. Needs only
numpy and scipy. Planning aid, not a substitute for a statistician on a complex design.

Request: {"action": "power"|"effect_size"|"correct"|"sensitivity"|"simulate", ...}
Every result echoes its assumptions and method so a number can be reproduced and defended.
"""
import json
import math
import sys

try:
    import numpy as np
    from scipy import optimize, stats
except Exception as exc:  # surfaced to the caller
    print(json.dumps({"error": f"numpy and scipy are required: {exc}"}))
    sys.exit(0)

ADVISORY = (
    "A planning aid. The result is only as good as the assumed effect size and the model; "
    "for a complex design (clustering, repeated measures, missing data) have a statistician check it."
)
NORM = stats.norm


class PowerError(ValueError):
    pass


def num(params, name, default=None, minimum=None, maximum=None, required=False):
    value = params.get(name, default)
    if value is None:
        if required:
            raise PowerError(f"{name} is required")
        return None
    try:
        value = float(value)
    except (TypeError, ValueError):
        raise PowerError(f"{name} must be a number")
    if not math.isfinite(value):
        raise PowerError(f"{name} must be finite")
    if minimum is not None and value < minimum:
        raise PowerError(f"{name} must be at least {minimum}")
    if maximum is not None and value > maximum:
        raise PowerError(f"{name} must be at most {maximum}")
    return value


# ---------------------------------------------------------------- power functions
# Each returns the probability of rejecting H0. `n` is the unit named in UNITS.

def _tail_p(dist_cdf_upper, dist_cdf_lower, tails):
    return dist_cdf_upper if tails == 1 else dist_cdf_upper + dist_cdf_lower


def pw_t(df, ncp, alpha, tails):
    if df < 1:
        return 0.0
    if tails == 2:
        tc = stats.t.ppf(1 - alpha / 2, df)
        value = 1 - stats.nct.cdf(tc, df, ncp) + stats.nct.cdf(-tc, df, ncp)
    else:
        tc = stats.t.ppf(1 - alpha, df)
        value = 1 - stats.nct.cdf(tc, df, ncp)
    if not np.isfinite(value):
        # scipy's noncentral t overflows for very large noncentrality; the normal limit is exact there
        return float(NORM.cdf(abs(ncp) - tc))
    return float(min(1.0, max(0.0, value)))


def pw_z(stat, alpha, tails):
    """Power of a z test whose standardised effect under H1 is `stat` (positive direction)."""
    if tails == 2:
        zc = NORM.ppf(1 - alpha / 2)
        return float(NORM.cdf(stat - zc) + NORM.cdf(-stat - zc))
    return float(NORM.cdf(stat - NORM.ppf(1 - alpha)))


def power_t_one(n, d, alpha, tails, p):
    return pw_t(n - 1, d * math.sqrt(n), alpha, tails)


def power_t_two(n, d, alpha, tails, p):
    ratio = p["ratio"]
    n2 = n * ratio
    if p["variance"] == "unequal":
        s = p["sd_ratio"]  # sd2 / sd1, with d expressed in units of sd1
        v1, v2 = 1.0 / n, s * s / n2
        df = (v1 + v2) ** 2 / (v1 ** 2 / (n - 1) + v2 ** 2 / (n2 - 1))
        return pw_t(df, d / math.sqrt(v1 + v2), alpha, tails)
    return pw_t(n + n2 - 2, d * math.sqrt(n * n2 / (n + n2)), alpha, tails)


def power_prop_one(n, h, alpha, tails, p):
    return pw_z(abs(h) * math.sqrt(n), alpha, tails)


def power_prop_two(n, h, alpha, tails, p):
    n2 = n * p["ratio"]
    return pw_z(abs(h) * math.sqrt(n * n2 / (n + n2)), alpha, tails)


def power_anova(n, f, alpha, tails, p):
    k = p["groups"]
    total = k * n
    df1, df2 = k - 1, total - k
    if df2 < 1:
        return 0.0
    crit = stats.f.ppf(1 - alpha, df1, df2)
    return float(1 - stats.ncf.cdf(crit, df1, df2, f * f * total))


def power_chisq(n, w, alpha, tails, p):
    df = p["df"]
    crit = stats.chi2.ppf(1 - alpha, df)
    return float(1 - stats.ncx2.cdf(crit, df, w * w * n))


def power_corr(n, r, alpha, tails, p):
    if n <= 3:
        return 0.0
    zeff = math.atanh(abs(r)) + abs(r) / (2 * (n - 1))
    return pw_z(zeff * math.sqrt(n - 3), alpha, tails)


def power_regression(n, f2, alpha, tails, p):
    u = p["predictors"]
    v = n - u - 1
    if v < 1:
        return 0.0
    crit = stats.f.ppf(1 - alpha, u, v)
    return float(1 - stats.ncf.cdf(crit, u, v, f2 * (u + v + 1)))


def power_logrank(events, hr, alpha, tails, p):
    a = p["allocation"]  # fraction in group 1
    return pw_z(abs(math.log(hr)) * math.sqrt(events * a * (1 - a)), alpha, tails)


def power_equivalence(n, true_d, alpha, tails, p):
    """TOST for two means (Schuirmann's approximation). `true_d` is the true difference in sd units."""
    margin = p["margin"]
    n2 = n * p["ratio"]
    df = n + n2 - 2
    se = math.sqrt(1.0 / n + 1.0 / n2)
    tc = stats.t.ppf(1 - alpha, df)
    lower = 1 - stats.nct.cdf(tc, df, (true_d + margin) / se)
    upper = stats.nct.cdf(-tc, df, (true_d - margin) / se)
    return float(max(0.0, lower + upper - 1.0))


def power_noninferiority(n, true_d, alpha, tails, p):
    n2 = n * p["ratio"]
    df = n + n2 - 2
    ncp = (true_d + p["margin"]) * math.sqrt(n * n2 / (n + n2))
    return pw_t(df, ncp, alpha, 1)


# name -> (function, effect label, unit of n, default effect upper bound, effect symbol)
TESTS = {
    "t_one_sample": (power_t_one, "Cohen's d", "subjects", 10.0, "d"),
    "t_paired": (power_t_one, "Cohen's d (of the differences)", "pairs", 10.0, "d"),
    "t_two_sample": (power_t_two, "Cohen's d", "per group (group 1)", 10.0, "d"),
    "proportion_one": (power_prop_one, "Cohen's h", "subjects", 3.0, "h"),
    "proportion_two": (power_prop_two, "Cohen's h", "per group (group 1)", 3.0, "h"),
    "anova_oneway": (power_anova, "Cohen's f", "per group", 5.0, "f"),
    "chisq": (power_chisq, "Cohen's w", "total", 3.0, "w"),
    "correlation": (power_corr, "r", "pairs", 0.999, "r"),
    "regression": (power_regression, "Cohen's f2", "total", 5.0, "f2"),
    "logrank": (power_logrank, "hazard ratio", "events", None, "HR"),
    "equivalence_means": (power_equivalence, "true difference / sd", "per group (group 1)", 5.0, "d"),
    "noninferiority_means": (power_noninferiority, "true difference / sd (positive = favours the new arm)", "per group (group 1)", 5.0, "d"),
}
MIN_N = {"t_one_sample": 2, "t_paired": 2, "t_two_sample": 2, "proportion_one": 2, "proportion_two": 2,
         "anova_oneway": 2, "chisq": 2, "correlation": 4, "regression": 4, "logrank": 2,
         "equivalence_means": 2, "noninferiority_means": 2}


def design_params(test, params):
    p = {
        "ratio": num(params, "ratio", 1.0, minimum=0.05, maximum=20),
        "groups": int(num(params, "groups", 3, minimum=2, maximum=100)),
        "df": num(params, "df", 1, minimum=1, maximum=1000),
        "predictors": int(num(params, "predictors", 1, minimum=1, maximum=500)),
        "allocation": num(params, "allocation", 0.5, minimum=0.01, maximum=0.99),
        "margin": num(params, "margin", None),
        "sd_ratio": num(params, "sd_ratio", 1.0, minimum=0.05, maximum=20),
        "variance": params.get("variance", "equal"),
    }
    if p["variance"] not in ("equal", "unequal"):
        raise PowerError("variance must be equal or unequal")
    if test in ("equivalence_means", "noninferiority_means") and (p["margin"] is None or p["margin"] <= 0):
        raise PowerError("margin (the equivalence / non-inferiority margin in sd units) is required and must be positive")
    return p


def effect_from_inputs(test, params):
    """The effect on the test's own scale, from `effect_size` or from proportions / hazard inputs."""
    if test in ("proportion_one", "proportion_two"):
        if params.get("effect_size") is not None:
            return num(params, "effect_size", required=True)
        p1 = num(params, "p1", minimum=0, maximum=1)
        p2 = num(params, "p2" if test == "proportion_two" else "p0", minimum=0, maximum=1)
        if p1 is None or p2 is None:
            return None
        return abs(2 * math.asin(math.sqrt(p1)) - 2 * math.asin(math.sqrt(p2)))
    value = num(params, "effect_size")
    return value


def solve_power(test, params):
    fn, label, unit, upper, symbol = TESTS[test]
    p = design_params(test, params)
    alpha_in = num(params, "alpha", 0.05, minimum=1e-12, maximum=0.5)
    tails = int(num(params, "tails", 2, minimum=1, maximum=2))
    if test in ("noninferiority_means",):
        tails = 1
    target = num(params, "power", None, minimum=0.01, maximum=0.9999)
    n_in = num(params, "n", None, minimum=MIN_N[test])
    if n_in is not None and float(n_in).is_integer():
        n_in = int(n_in)
    effect = effect_from_inputs(test, params)
    solve = params.get("solve") or ("n" if n_in is None else "power")
    if solve not in ("n", "power", "effect_size", "alpha"):
        raise PowerError("solve must be n, power, effect_size, or alpha")
    if test == "logrank" and effect is not None and effect <= 0:
        raise PowerError("hazard ratio must be positive")
    if test == "logrank" and effect is not None and abs(effect - 1) < 1e-12:
        raise PowerError("a hazard ratio of exactly 1 is no effect; there is nothing to detect")
    given = {"n": n_in, "effect_size": effect, "power": target}
    need = {"n": ("effect_size", "power"), "power": ("n", "effect_size"), "effect_size": ("n", "power"),
            "alpha": ("n", "effect_size", "power")}[solve]
    missing = [name for name in need if given[name] is None]
    if missing:
        raise PowerError(f"to solve for {solve} give: {', '.join(missing)}")
    eff_zero = lambda e: e is not None and (e == 0 if test != "equivalence_means" else False)  # noqa: E731
    if solve != "effect_size" and eff_zero(effect):
        raise PowerError("an effect size of 0 has no power to detect; use a non-zero effect")

    def pw(n, e, a):
        return fn(n, e, a, tails, p)

    notes = []
    result = {}
    if solve == "power":
        result["power"] = pw(n_in, effect, alpha_in)
        result["n"] = n_in
    elif solve == "n":
        lo = MIN_N[test]
        if pw(1e6, effect, alpha_in) < target:
            raise PowerError("the target power cannot be reached for this effect size, even with a very large n")
        if pw(lo, effect, alpha_in) >= target:
            exact = float(lo)
        else:
            hi = lo * 2.0
            while pw(hi, effect, alpha_in) < target:
                hi *= 2
            exact = float(optimize.brentq(lambda n: pw(n, effect, alpha_in) - target, lo, hi, xtol=1e-6))
        n_int = max(lo, math.ceil(exact - 1e-9))
        while pw(n_int, effect, alpha_in) < target - 1e-12:
            n_int += 1
        while n_int > lo and pw(n_int - 1, effect, alpha_in) >= target:
            n_int -= 1
        result.update({"n": n_int, "n_unrounded": round(exact, 4), "power": pw(n_int, effect, alpha_in)})
    elif solve == "effect_size":
        hi = upper if upper is not None else None
        if test == "logrank":
            lo_e, hi_e = 1e-6, 1 - 1e-9
            f = lambda e: pw(n_in, e, alpha_in) - target  # noqa: E731
            if f(lo_e) < 0:
                raise PowerError("this many events cannot reach the target power for any hazard ratio below 1")
            e = float(optimize.brentq(f, lo_e, hi_e, xtol=1e-9))
            result["effect_size"] = e
            result["note_direction"] = "smallest detectable hazard ratio below 1 (its reciprocal is the same effect above 1)"
        else:
            if pw(n_in, hi, alpha_in) < target:
                raise PowerError("the target power cannot be reached with this n for any effect size in range")
            e = float(optimize.brentq(lambda x: pw(n_in, x, alpha_in) - target, 1e-9, hi, xtol=1e-9))
            result["effect_size"] = e
        result["n"] = n_in
        result["power"] = target
    else:
        f = lambda a: pw(n_in, effect, a) - target  # noqa: E731
        if f(1e-12) > 0:
            raise PowerError("even a very small alpha reaches this power; alpha is not the binding constraint")
        if f(0.5) < 0:
            raise PowerError("the target power cannot be reached at any alpha up to 0.5")
        result["alpha"] = float(optimize.brentq(f, 1e-12, 0.5, xtol=1e-12))
        result["n"] = n_in
        result["power"] = target

    # sample-size bookkeeping
    n_final = result.get("n")
    totals = {}
    if n_final is not None:
        if test in ("t_two_sample", "proportion_two", "equivalence_means", "noninferiority_means"):
            n2 = math.ceil(n_final * p["ratio"] - 1e-9)
            totals = {"group_1": n_final, "group_2": n2, "total": n_final + n2}
        elif test == "anova_oneway":
            totals = {"per_group": n_final, "groups": p["groups"], "total": n_final * p["groups"]}
        elif test == "logrank":
            totals = {"events": n_final}
            ep = num(params, "event_prob", None, minimum=0.001, maximum=1)
            if ep:
                totals["participants_needed"] = math.ceil(n_final / ep)
                totals["assumed_overall_event_probability"] = ep
            else:
                notes.append("This is the number of events, not participants. Give event_prob to convert it to participants.")
        elif test == "regression":
            totals = {"total": n_final, "predictors": p["predictors"]}
        else:
            totals = {"total": n_final}
        result["sample"] = totals
        # inflation for clustering and dropout, reported separately from the analytic n
        inflate = 1.0
        cs, icc = num(params, "cluster_size", None, minimum=1), num(params, "icc", None, minimum=0, maximum=1)
        if (cs is None) != (icc is None):
            raise PowerError("clustering needs both cluster_size and icc")
        if cs is not None:
            de = 1 + (cs - 1) * icc
            inflate *= de
            result["design_effect"] = round(de, 4)
        drop = num(params, "dropout", None, minimum=0, maximum=0.95)
        if drop:
            inflate /= (1 - drop)
            result["dropout"] = drop
        if inflate != 1.0 and solve == "n":
            key = "total" if "total" in totals else next(iter(totals))
            result["enrol"] = {
                "inflation_factor": round(inflate, 4),
                **{k: math.ceil(v * inflate - 1e-9) for k, v in totals.items() if isinstance(v, int) and k != "groups"},
            }
        if test in ("t_two_sample", "proportion_two") and p["variance"] == "unequal":
            notes.append("Welch (unequal variance) power uses the Satterthwaite degrees of freedom: an approximation.")
        if test == "equivalence_means":
            notes.append("TOST power uses Schuirmann's approximation; confirm with the simulate action for a final design.")
        if test == "correlation":
            notes.append("Fisher-z approximation with the small-sample bias correction (as in the R pwr package); G*Power's exact test can differ by 1.")

    echo = {
        "test": test, "solve": solve, "alpha": result.get("alpha", alpha_in), "tails": tails,
        "effect_metric": label, "effect_symbol": symbol,
        "effect_size": result.get("effect_size", effect),
        "power_target": target if solve in ("n", "effect_size", "alpha") else None,
        "n_unit": unit,
    }
    for key in ("ratio", "groups", "df", "predictors", "allocation", "margin", "variance", "sd_ratio"):
        if (test in ("t_two_sample", "proportion_two", "equivalence_means", "noninferiority_means") and key in ("ratio",)) \
                or (key == "groups" and test == "anova_oneway") or (key == "df" and test == "chisq") \
                or (key == "predictors" and test == "regression") or (key == "allocation" and test == "logrank") \
                or (key == "margin" and test in ("equivalence_means", "noninferiority_means")) \
                or (key in ("variance", "sd_ratio") and test == "t_two_sample"):
            echo[key] = p[key]
    method = {
        "t_one_sample": "noncentral t", "t_paired": "noncentral t on the paired differences", "t_two_sample": "noncentral t (pooled)" if p["variance"] == "equal" else "noncentral t (Welch approximation)",
        "proportion_one": "arcsine (Cohen's h) normal approximation", "proportion_two": "arcsine (Cohen's h) normal approximation",
        "anova_oneway": "noncentral F", "chisq": "noncentral chi-square", "correlation": "Fisher z with bias correction",
        "regression": "noncentral F (lambda = f2 * N)", "logrank": "Schoenfeld events formula", "equivalence_means": "two one-sided t tests (Schuirmann)",
        "noninferiority_means": "one-sided noncentral t against the margin",
    }[test]
    return {"action": "power", "result": result, "inputs": echo, "method": method, "notes": notes}


# ---------------------------------------------------------------- effect sizes

def effect_size(params):
    kind = params.get("from")
    v = params.get("inputs") or {}
    out = {}
    notes = []

    def f(name, **kw):
        return num(v, name, **kw)

    d = None
    if kind == "d":
        d = f("d", required=True)
    elif kind == "r":
        r = f("r", required=True, minimum=-0.999999, maximum=0.999999)
        d = 2 * r / math.sqrt(1 - r * r)
        notes.append("d from r assumes two equal-sized groups.")
    elif kind == "f":
        d = 2 * f("f", required=True, minimum=0)
        notes.append("d = 2f holds for two groups.")
    elif kind == "f2":
        d = 2 * math.sqrt(f("f2", required=True, minimum=0))
        notes.append("d = 2*sqrt(f2) holds for two groups.")
    elif kind == "eta2":
        e = f("eta2", required=True, minimum=0, maximum=0.999999)
        d = 2 * math.sqrt(e / (1 - e))
        notes.append("d from eta-squared holds for two groups.")
    elif kind == "odds_ratio":
        orr = f("odds_ratio", required=True, minimum=1e-9)
        d = math.log(orr) * math.sqrt(3) / math.pi
        notes.append("d from an odds ratio uses the logistic approximation (ln OR * sqrt(3)/pi).")
    elif kind == "t_two_sample":
        t, n1, n2 = f("t", required=True), f("n1", required=True, minimum=2), f("n2", required=True, minimum=2)
        d = t * math.sqrt(1 / n1 + 1 / n2)
        out["df"] = n1 + n2 - 2
    elif kind == "t_paired":
        t, n = f("t", required=True), f("n", required=True, minimum=2)
        d = t / math.sqrt(n)
        out["df"] = n - 1
    elif kind == "F":
        F, n1, n2 = f("F", required=True, minimum=0), f("n1", required=True, minimum=2), f("n2", required=True, minimum=2)
        d = math.sqrt(F * (1 / n1 + 1 / n2))
        notes.append("F with one numerator df equals t squared; the sign of the effect is lost.")
    elif kind == "means":
        m1, m2, s1, s2 = f("m1", required=True), f("m2", required=True), f("sd1", required=True, minimum=0), f("sd2", required=True, minimum=0)
        n1, n2 = f("n1", required=True, minimum=2), f("n2", required=True, minimum=2)
        pooled = math.sqrt(((n1 - 1) * s1 * s1 + (n2 - 1) * s2 * s2) / (n1 + n2 - 2))
        if pooled == 0:
            raise PowerError("pooled sd is 0")
        d = (m1 - m2) / pooled
        out["pooled_sd"] = pooled
        out["glass_delta"] = (m1 - m2) / s2 if s2 else None
        out["df"] = n1 + n2 - 2
        se = math.sqrt((n1 + n2) / (n1 * n2) + d * d / (2 * (n1 + n2)))
        out["d_ci95"] = [d - 1.96 * se, d + 1.96 * se]
        notes.append("The confidence interval is the large-sample normal approximation.")
    elif kind == "proportions":
        p1, p2 = f("p1", required=True, minimum=0, maximum=1), f("p2", required=True, minimum=0, maximum=1)
        h = 2 * math.asin(math.sqrt(p1)) - 2 * math.asin(math.sqrt(p2))
        out.update({"h": h, "risk_difference": p1 - p2})
        if p2 > 0:
            out["risk_ratio"] = p1 / p2
        if 0 < p1 < 1 and 0 < p2 < 1:
            orr = (p1 / (1 - p1)) / (p2 / (1 - p2))
            out["odds_ratio"] = orr
            d = math.log(orr) * math.sqrt(3) / math.pi
            out["number_needed_to_treat"] = (1 / abs(p1 - p2)) if p1 != p2 else None
    elif kind == "chi2":
        chi, n = f("chi2", required=True, minimum=0), f("N", required=True, minimum=1)
        out["w"] = math.sqrt(chi / n)
        out["note_cramers_v"] = "Cramer's V = w / sqrt(min(rows, columns) - 1)"
    else:
        raise PowerError("from must be one of: d, r, f, f2, eta2, odds_ratio, t_two_sample, t_paired, F, means, proportions, chi2")
    if d is not None:
        r_eq = d / math.sqrt(d * d + 4)
        out.update({
            "d": d, "r": r_eq, "f": abs(d) / 2, "f2": d * d / 4, "eta2": (d * d / 4) / (1 + d * d / 4),
            "odds_ratio_equivalent": math.exp(d * math.pi / math.sqrt(3)),
        })
        df_g = out.get("df")
        if df_g:
            j = 1 - 3 / (4 * df_g - 1)
            out["hedges_g"] = d * j
            out["hedges_correction_J"] = j
    out["note_conventions"] = "Cohen's labels (d 0.2/0.5/0.8) are a last resort; prefer an effect size from a pilot, the literature, or the smallest effect that matters."
    return {"action": "effect_size", "from": kind, "result": out, "notes": notes}


# ---------------------------------------------------------------- multiplicity

def correct(params):
    raw = params.get("p_values")
    if not isinstance(raw, list) or not raw:
        raise PowerError("p_values must be a non-empty list")
    try:
        p = np.array([float(x) for x in raw])
    except (TypeError, ValueError):
        raise PowerError("p_values must be numbers")
    if np.any(p < 0) or np.any(p > 1) or not np.all(np.isfinite(p)):
        raise PowerError("every p-value must be between 0 and 1")
    method = (params.get("method") or "holm").lower()
    alpha = num(params, "alpha", 0.05, minimum=1e-12, maximum=0.5)
    m = len(p)
    order = np.argsort(p)
    ps = p[order]
    if method == "bonferroni":
        adj_sorted = np.minimum(1, ps * m)
    elif method == "holm":
        adj_sorted = np.minimum(1, np.maximum.accumulate(ps * (m - np.arange(m))))
    elif method == "hochberg":
        adj_sorted = np.minimum(1, np.minimum.accumulate((ps * (m - np.arange(m)))[::-1])[::-1])
    elif method in ("bh", "fdr_bh"):
        adj_sorted = np.minimum(1, np.minimum.accumulate((ps * m / (np.arange(m) + 1))[::-1])[::-1])
    elif method in ("by", "fdr_by"):
        c = np.sum(1.0 / (np.arange(m) + 1))
        adj_sorted = np.minimum(1, np.minimum.accumulate((ps * m * c / (np.arange(m) + 1))[::-1])[::-1])
    else:
        raise PowerError("method must be bonferroni, holm, hochberg, bh, or by")
    adj = np.empty(m)
    adj[order] = adj_sorted
    planning = {
        "tests": m, "bonferroni_alpha": alpha / m, "sidak_alpha": 1 - (1 - alpha) ** (1 / m), "holm_first_step_alpha": alpha / m,
    }
    notes = []
    if method in ("hochberg", "bh", "by"):
        notes.append({"hochberg": "Hochberg assumes independent or positively dependent tests.",
                      "bh": "Benjamini-Hochberg controls the false discovery rate under independence or positive dependence.",
                      "by": "Benjamini-Yekutieli controls the false discovery rate under any dependence (more conservative)."}[method])
    return {"action": "correct", "result": {
        "method": method, "alpha": alpha,
        "adjusted_p": [float(x) for x in adj], "reject": [bool(x <= alpha) for x in adj],
        "rejected": int(np.sum(adj <= alpha)), "planning_alpha_per_test": planning,
    }, "notes": notes}


# ---------------------------------------------------------------- sensitivity

def sensitivity(params):
    test = params.get("test")
    if test not in TESTS:
        raise PowerError(f"test must be one of: {', '.join(TESTS)}")
    curve = params.get("curve")
    if curve:
        ns = curve.get("n_values") or []
        effects = curve.get("effects") or []
        if not ns or not effects or len(ns) * len(effects) > 400:
            raise PowerError("curve needs n_values and effects (at most 400 combinations)")
        fn = TESTS[test][0]
        p = design_params(test, params)
        alpha = num(params, "alpha", 0.05, minimum=1e-12, maximum=0.5)
        tails = 1 if test == "noninferiority_means" else int(num(params, "tails", 2, minimum=1, maximum=2))
        table = []
        for n in ns:
            n = float(n)
            if n < MIN_N[test]:
                raise PowerError(f"n must be at least {MIN_N[test]} for {test}")
            table.append({"n": n, "power": [{"effect_size": float(e), "power": round(fn(n, float(e), alpha, tails, p), 4)} for e in effects]})
        return {"action": "sensitivity", "result": {"curve": table, "alpha": alpha, "tails": tails}, "inputs": {"test": test}}
    out = solve_power(test, {**params, "solve": "effect_size"})
    out["action"] = "sensitivity"
    out["notes"] = out.get("notes", []) + ["This is the smallest effect the design can detect at the stated power, not an estimate of the true effect."]
    return out


# ---------------------------------------------------------------- simulation

def _wilson(k, n):
    z = 1.96
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return [max(0.0, centre - half), min(1.0, centre + half)]


def simulate(params):
    seed = params.get("seed")
    if seed is None or isinstance(seed, bool):
        raise PowerError("seed is required so a simulation can be reproduced")
    rng = np.random.default_rng(int(seed))
    nsim = int(num(params, "nsim", 2000, minimum=100, maximum=20000))
    design = params.get("design")
    d = params.get("params") or {}
    alpha = num(d, "alpha", 0.05, minimum=1e-9, maximum=0.5)
    hits = 0
    if design == "two_group":
        n1, n2 = int(num(d, "n1", required=True, minimum=2)), int(num(d, "n2", num(d, "n1"), minimum=2))
        diff, sd1, sd2 = num(d, "diff", required=True), num(d, "sd1", 1.0, minimum=1e-9), num(d, "sd2", num(d, "sd1", 1.0), minimum=1e-9)
        test = d.get("test", "welch")
        tdf = num(d, "t_df", None, minimum=1)
        for _ in range(nsim):
            if tdf:
                a = rng.standard_t(tdf, n1) * sd1 + diff
                b = rng.standard_t(tdf, n2) * sd2
            else:
                a, b = rng.normal(diff, sd1, n1), rng.normal(0, sd2, n2)
            if test == "mannwhitney":
                pv = stats.mannwhitneyu(a, b, alternative="two-sided").pvalue
            else:
                pv = stats.ttest_ind(a, b, equal_var=(test == "student")).pvalue
            hits += pv < alpha
        assumptions = [f"normal data" if not tdf else f"t({tdf}) heavy-tailed data", f"test: {test}"]
    elif design == "paired":
        n, dd, rho = int(num(d, "n", required=True, minimum=2)), num(d, "d", required=True), num(d, "rho", 0.5, minimum=-0.99, maximum=0.99)
        test = d.get("test", "t")
        cov = [[1, rho], [rho, 1]]
        for _ in range(nsim):
            xy = rng.multivariate_normal([dd, 0], cov, n)
            pv = stats.wilcoxon(xy[:, 0] - xy[:, 1]).pvalue if test == "wilcoxon" else stats.ttest_rel(xy[:, 0], xy[:, 1]).pvalue
            hits += pv < alpha
        assumptions = ["bivariate normal pairs", f"correlation {rho}", f"test: {test}"]
    elif design == "proportions":
        n1, n2 = int(num(d, "n1", required=True, minimum=2)), int(num(d, "n2", num(d, "n1"), minimum=2))
        p1, p2 = num(d, "p1", required=True, minimum=0, maximum=1), num(d, "p2", required=True, minimum=0, maximum=1)
        test = d.get("test", "chisq")
        for _ in range(nsim):
            a, b = rng.binomial(n1, p1), rng.binomial(n2, p2)
            table = [[a, n1 - a], [b, n2 - b]]
            if test == "fisher":
                pv = stats.fisher_exact(table)[1]
            else:
                try:
                    pv = stats.chi2_contingency(table, correction=False)[1]
                except ValueError:
                    pv = 1.0
            hits += pv < alpha
        assumptions = ["independent binomial samples", f"test: {test}"]
    elif design == "cluster_two_arm":
        k, m = int(num(d, "clusters_per_arm", required=True, minimum=2)), int(num(d, "cluster_size", required=True, minimum=1))
        icc, dd = num(d, "icc", required=True, minimum=0, maximum=0.99), num(d, "d", required=True)
        sb, sw = math.sqrt(icc), math.sqrt(1 - icc)
        for _ in range(nsim):
            def arm(shift):
                centres = rng.normal(0, sb, k)
                data = centres[:, None] + rng.normal(0, sw, (k, m)) + shift
                return data.mean(axis=1)
            pv = stats.ttest_ind(arm(dd), arm(0.0), equal_var=True).pvalue
            hits += pv < alpha
        assumptions = ["analysis on cluster means (a t test between arms)", f"icc {icc}", "equal cluster sizes, no missing data"]
    elif design == "correlation":
        n, r = int(num(d, "n", required=True, minimum=4)), num(d, "r", required=True, minimum=-0.99, maximum=0.99)
        for _ in range(nsim):
            xy = rng.multivariate_normal([0, 0], [[1, r], [r, 1]], n)
            hits += stats.pearsonr(xy[:, 0], xy[:, 1])[1] < alpha
        assumptions = ["bivariate normal", "Pearson correlation test"]
    else:
        raise PowerError("design must be two_group, paired, proportions, cluster_two_arm, or correlation")
    est = hits / nsim
    return {"action": "simulate", "result": {
        "design": design, "power": est, "monte_carlo_se": math.sqrt(est * (1 - est) / nsim),
        "ci95": _wilson(int(hits), nsim), "nsim": nsim, "seed": int(seed), "alpha": alpha,
    }, "inputs": {k: v for k, v in d.items()}, "notes": assumptions}


# ---------------------------------------------------------------- diagnostics precision

def diagnostic_precision(params):
    """Sample size (or achievable CI half-width) to estimate a sensitivity or specificity (Buderer)."""
    p = num(params, "expected", required=True, minimum=0.01, maximum=0.99)
    conf = num(params, "confidence", 0.95, minimum=0.5, maximum=0.999)
    z = NORM.ppf(1 - (1 - conf) / 2)
    width, n = num(params, "width", None, minimum=0.001, maximum=0.5), num(params, "n", None, minimum=2)
    prev = num(params, "prevalence", None, minimum=0.001, maximum=0.999)
    if (width is None) == (n is None):
        raise PowerError("give exactly one of width (the half-width wanted) or n (cases with the condition)")
    if width is not None:
        cases = math.ceil(z * z * p * (1 - p) / (width * width) - 1e-9)
        out = {"cases_needed": cases, "half_width": width}
        if prev:
            out["total_participants"] = math.ceil(cases / prev - 1e-9)
            out["assumed_prevalence"] = prev
    else:
        out = {"half_width": z * math.sqrt(p * (1 - p) / n), "cases": n}
    out.update({"expected": p, "confidence": conf})
    return {"action": "diagnostic_precision", "result": out, "method": "normal approximation to the binomial (Buderer)", "notes": [
        "Cases are participants who truly have the condition (sensitivity) or truly do not (specificity); divide by prevalence (or 1 - prevalence) for the total."]}


ACTIONS = {"power": None, "effect_size": effect_size, "correct": correct, "sensitivity": sensitivity,
           "simulate": simulate, "diagnostic_precision": diagnostic_precision}


def main():
    try:
        request = json.loads(sys.stdin.read() or "{}")
        action = request.get("action") or "power"
        if action not in ACTIONS:
            raise PowerError(f"action must be one of: {', '.join(ACTIONS)}")
        if action == "power":
            test = request.get("test")
            if test not in TESTS:
                raise PowerError(f"test must be one of: {', '.join(TESTS)}")
            out = solve_power(test, request)
        else:
            out = ACTIONS[action](request)
        out["software"] = f"numpy {np.__version__}, scipy {stats.__name__.split('.')[0]} {__import__('scipy').__version__}"
        out["advisory"] = ADVISORY
    except PowerError as exc:
        out = {"error": str(exc)}
    except Exception as exc:  # pragma: no cover - unexpected: report, do not crash silently
        out = {"error": f"unexpected failure: {exc}"}
    print(json.dumps(out))


if __name__ == "__main__":
    main()
