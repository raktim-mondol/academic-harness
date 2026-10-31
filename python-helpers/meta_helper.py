#!/usr/bin/env python3
"""Pairwise meta-analysis helpers for the meta_analysis tool.

Reads one JSON request on stdin and writes one JSON object on stdout. Uses only
numpy/scipy. The tool stores the ledger and protocols; this helper does the
statistics and SVG plots.
"""
import json
import math
import sys
import html

try:
    import numpy as np
    from scipy import stats, optimize
except Exception as exc:  # pragma: no cover - surfaced to the tool
    print(json.dumps({"error": f"numpy and scipy are required: {exc}"}))
    sys.exit(0)

RATIO_MEASURES = {"OR", "RR", "HR", "IRR", "DOR"}
CONTINUOUS_MEASURES = {"MD", "SMD"}
Z95 = 1.959963984540054


def emit(value):
    print(json.dumps(value, allow_nan=False))


def fail(message):
    emit({"error": str(message)})


def number(value, name, *, positive=False, nonnegative=False):
    try:
        result = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be a number")
    if not math.isfinite(result):
        raise ValueError(f"{name} must be finite")
    if positive and result <= 0:
        raise ValueError(f"{name} must be greater than zero")
    if nonnegative and result < 0:
        raise ValueError(f"{name} must be non-negative")
    return result


def integer(value, name, *, positive=False, nonnegative=False):
    result = number(value, name, positive=positive, nonnegative=nonnegative)
    if not result.is_integer():
        raise ValueError(f"{name} must be an integer")
    return int(result)


def clean(value):
    return str(value if value is not None else "").strip()


def logistic(value):
    return 1.0 / (1.0 + math.exp(-value))


def logit(value):
    return math.log(value / (1.0 - value))


def ci_from_se(effect, se, alpha=0.05):
    z = stats.norm.ppf(1 - alpha / 2)
    return [float(effect - z * se), float(effect + z * se)]


def se_from_ci(low, high, alpha=0.05):
    z = stats.norm.ppf(1 - alpha / 2)
    return float((high - low) / (2 * z))


def binary_effect(a, b, c, d, measure):
    a = integer(a, "a", nonnegative=True)
    b = integer(b, "b", nonnegative=True)
    c = integer(c, "c", nonnegative=True)
    d = integer(d, "d", nonnegative=True)
    n1, n2 = a + b, c + d
    if n1 <= 0 or n2 <= 0:
        raise ValueError("each binary study needs positive group totals")
    correction = None
    if measure in {"OR", "RR"} and min(a, b, c, d) == 0:
        a, b, c, d = a + 0.5, b + 0.5, c + 0.5, d + 0.5
        correction = "0.5 added to all four cells because at least one cell was zero"
    if measure == "OR":
        effect = math.log((a * d) / (b * c))
        se = math.sqrt(1 / a + 1 / b + 1 / c + 1 / d)
        formula = "log((a*d)/(b*c)); SE = sqrt(1/a + 1/b + 1/c + 1/d)"
        log_scale = True
        display = math.exp(effect)
    elif measure == "RR":
        effect = math.log((a / n1) / (c / n2))
        se = math.sqrt(1 / a - 1 / n1 + 1 / c - 1 / n2)
        formula = "log((a/n1)/(c/n2)); SE = sqrt(1/a - 1/n1 + 1/c - 1/n2)"
        log_scale = True
        display = math.exp(effect)
    elif measure == "RD":
        p1, p2 = a / n1, c / n2
        effect = p1 - p2
        se = math.sqrt(p1 * (1 - p1) / n1 + p2 * (1 - p2) / n2)
        formula = "p1 - p2; SE = sqrt(p1(1-p1)/n1 + p2(1-p2)/n2)"
        log_scale = False
        display = effect
    else:
        raise ValueError("binary studies support OR, RR, or RD")
    return {
        "effect": float(effect),
        "se": float(se),
        "variance": float(se * se),
        "measure": measure,
        "log_scale": log_scale,
        "display_effect": float(display),
        "display_ci": [float(math.exp(effect - Z95 * se)), float(math.exp(effect + Z95 * se))] if log_scale else ci_from_se(effect, se),
        "formula": formula,
        "correction": correction,
    }


def continuous_effect(m1, sd1, n1, m2, sd2, n2, measure):
    m1 = number(m1, "m1")
    m2 = number(m2, "m2")
    sd1 = number(sd1, "sd1", nonnegative=True)
    sd2 = number(sd2, "sd2", nonnegative=True)
    n1 = integer(n1, "n1", positive=True)
    n2 = integer(n2, "n2", positive=True)
    if n1 < 2 or n2 < 2:
        raise ValueError("continuous studies need at least 2 participants per group")
    if measure == "MD":
        effect = m1 - m2
        se = math.sqrt(sd1 * sd1 / n1 + sd2 * sd2 / n2)
        formula = "m1 - m2; SE = sqrt(sd1^2/n1 + sd2^2/n2)"
    elif measure == "SMD":
        pooled_sd = math.sqrt(((n1 - 1) * sd1 * sd1 + (n2 - 1) * sd2 * sd2) / (n1 + n2 - 2))
        if pooled_sd <= 0:
            raise ValueError("pooled SD is zero")
        d = (m1 - m2) / pooled_sd
        j = 1 - 3 / (4 * (n1 + n2) - 9)
        effect = j * d
        se = math.sqrt((n1 + n2) / (n1 * n2) + effect * effect / (2 * (n1 + n2)))
        formula = "Hedges' g = J*(m1-m2)/s_pooled; SE = sqrt((n1+n2)/(n1*n2) + g^2/(2*(n1+n2)))"
    else:
        raise ValueError("continuous studies support MD or SMD")
    return {
        "effect": float(effect),
        "se": float(se),
        "variance": float(se * se),
        "measure": measure,
        "log_scale": False,
        "display_effect": float(effect),
        "display_ci": ci_from_se(effect, se),
        "formula": formula,
        "correction": None,
    }


def correlation_effect(r, n):
    r = number(r, "r")
    n = integer(n, "n", positive=True)
    if not -1 < r < 1:
        raise ValueError("r must be strictly between -1 and 1")
    if n <= 3:
        raise ValueError("n must be greater than 3 for Fisher z")
    effect = math.atanh(r)
    se = 1 / math.sqrt(n - 3)
    return {
        "effect": float(effect),
        "se": float(se),
        "variance": float(se * se),
        "measure": "ZR",
        "log_scale": False,
        "display_effect": float(math.tanh(effect)),
        "display_ci": [float(math.tanh(effect - Z95 * se)), float(math.tanh(effect + Z95 * se))],
        "formula": "Fisher z = atanh(r); SE = 1/sqrt(n-3)",
        "correction": None,
    }


def ratio_effect(effect, se=None, ci_low=None, ci_high=None, measure="OR", effect_scale="ratio", alpha=0.05):
    if effect_scale == "log":
        log_effect = number(effect, "effect")
        log_se = number(se, "se", positive=True) if se is not None else None
        if log_se is None:
            if ci_low is None or ci_high is None:
                raise ValueError("log-scale ratio effect needs se or a confidence interval")
            log_se = se_from_ci(math.log(number(ci_low, "ci_low", positive=True)),
                                math.log(number(ci_high, "ci_high", positive=True)), alpha)
        return {
            "effect": float(log_effect),
            "se": float(log_se),
            "variance": float(log_se * log_se),
            "measure": measure,
            "log_scale": True,
            "display_effect": float(math.exp(log_effect)),
            "display_ci": [float(math.exp(log_effect - Z95 * log_se)), float(math.exp(log_effect + Z95 * log_se))],
            "formula": "log effect and log SE supplied",
            "correction": None,
        }
    effect = number(effect, "effect", positive=True)
    log_effect = math.log(effect)
    if ci_low is not None and ci_high is not None:
        low = math.log(number(ci_low, "ci_low", positive=True))
        high = math.log(number(ci_high, "ci_high", positive=True))
        log_se = se_from_ci(low, high, alpha)
        formula = "log effect; SE from log CI"
    elif se is not None:
        log_se = number(se, "se", positive=True)
        formula = "log effect; supplied SE interpreted on the log scale"
    else:
        raise ValueError("ratio effect needs a confidence interval or a log-scale SE")
    return {
        "effect": float(log_effect),
        "se": float(log_se),
        "variance": float(log_se * log_se),
        "measure": measure,
        "log_scale": True,
        "display_effect": float(effect),
        "display_ci": [float(math.exp(log_effect - Z95 * log_se)), float(math.exp(log_effect + Z95 * log_se))],
        "formula": formula,
        "correction": None,
    }


def generic_effect(effect, se=None, ci_low=None, ci_high=None, measure="MD", log_scale=False, alpha=0.05):
    if log_scale:
        return ratio_effect(effect, se=se, ci_low=ci_low, ci_high=ci_high,
                            measure=measure, effect_scale="log", alpha=alpha)
    if measure in RATIO_MEASURES:
        return ratio_effect(effect, se=se, ci_low=ci_low, ci_high=ci_high,
                            measure=measure, effect_scale="ratio", alpha=alpha)
    effect = number(effect, "effect")
    if se is not None:
        se = number(se, "se", positive=True)
    elif ci_low is not None and ci_high is not None:
        se = se_from_ci(number(ci_low, "ci_low"), number(ci_high, "ci_high"), alpha)
    else:
        raise ValueError("effect needs a standard error or a confidence interval")
    return {
        "effect": float(effect),
        "se": float(se),
        "variance": float(se * se),
        "measure": measure,
        "log_scale": False,
        "display_effect": float(effect),
        "display_ci": ci_from_se(effect, se, alpha),
        "formula": "effect and SE supplied on the analysis scale",
        "correction": None,
    }


def prepare_study(study, measure):
    if not isinstance(study, dict):
        raise ValueError("each study must be an object")
    study_id = clean(study.get("id") or study.get("study_id"))
    label = clean(study.get("label") or study.get("name") or study_id)
    if not study_id:
        raise ValueError("each study needs an id")
    if not label:
        label = study_id
    study_type = clean(study.get("type")).lower()
    if not study_type:
        if all(key in study for key in ("a", "b", "c", "d")):
            study_type = "binary"
        elif all(key in study for key in ("m1", "sd1", "n1", "m2", "sd2", "n2")):
            study_type = "continuous"
        elif "r" in study and measure == "ZR":
            study_type = "correlation"
        elif "hr" in study:
            study_type = "hr"
        elif "effect" in study:
            study_type = "generic"
    if study_type == "binary":
        if all(key in study for key in ("a", "b", "c", "d")):
            result = binary_effect(study["a"], study["b"], study["c"], study["d"], measure)
        else:
            events1 = integer(study.get("events1"), "events1", nonnegative=True)
            n1 = integer(study.get("n1"), "n1", positive=True)
            events2 = integer(study.get("events2"), "events2", nonnegative=True)
            n2 = integer(study.get("n2"), "n2", positive=True)
            result = binary_effect(events1, n1 - events1, events2, n2 - events2, measure)
    elif study_type == "continuous":
        result = continuous_effect(study.get("m1"), study.get("sd1"), study.get("n1"),
                                   study.get("m2"), study.get("sd2"), study.get("n2"), measure)
    elif study_type == "correlation":
        result = correlation_effect(study.get("r"), study.get("n"))
    elif study_type == "hr":
        if study.get("log_hr") is not None:
            result = ratio_effect(study.get("log_hr"), se=study.get("se"), measure="HR", effect_scale="log")
        else:
            result = ratio_effect(study.get("hr"), ci_low=study.get("ci_low"), ci_high=study.get("ci_high"), measure="HR")
    elif study_type == "diagnostic":
        tp = integer(study.get("tp"), "tp", nonnegative=True)
        fp = integer(study.get("fp"), "fp", nonnegative=True)
        fn = integer(study.get("fn"), "fn", nonnegative=True)
        tn = integer(study.get("tn"), "tn", nonnegative=True)
        if tp + fn <= 0 or fp + tn <= 0:
            raise ValueError("diagnostic studies need non-empty positive and negative groups")
        a, b, c, d = tp, fp, fn, tn
        correction = None
        if min(a, b, c, d) == 0:
            a, b, c, d = a + 0.5, b + 0.5, c + 0.5, d + 0.5
            correction = "0.5 added to all four cells for log DOR"
        log_dor = math.log((a * d) / (b * c))
        var_dor = 1 / a + 1 / b + 1 / c + 1 / d
        result = {
            "effect": float(log_dor),
            "se": float(math.sqrt(var_dor)),
            "variance": float(var_dor),
            "measure": "DOR",
            "log_scale": False,
            "display_effect": float(math.exp(log_dor)),
            "display_ci": [float(math.exp(log_dor - Z95 * math.sqrt(var_dor))), float(math.exp(log_dor + Z95 * math.sqrt(var_dor)))],
            "formula": "log DOR = log((tp*tn)/(fp*fn)); diagnostic pooling uses the raw 2x2 counts",
            "correction": correction,
        }
    elif study_type == "generic":
        result = generic_effect(
            study.get("effect"), se=study.get("se"), ci_low=study.get("ci_low"),
            ci_high=study.get("ci_high"), measure=measure,
            log_scale=bool(study.get("log_scale")),
        )
    else:
        raise ValueError(f"unsupported study type: {study_type}")
    result.update({
        "id": study_id,
        "label": label,
        "n": int(study["n"]) if study.get("n") is not None else None,
        "meta": study,
    })
    return result


def tau2_dl(y, v):
    k = len(y)
    w = 1 / v
    mu = float(np.sum(w * y) / np.sum(w))
    q = float(np.sum(w * (y - mu) ** 2))
    c = float(np.sum(w) - np.sum(w * w) / np.sum(w))
    tau2 = max(0.0, (q - (k - 1)) / c) if c > 0 else 0.0
    return tau2, q


def tau2_pm(y, v):
    k = len(y)
    target = k - 1

    def q_at(tau2):
        w = 1 / (v + tau2)
        mu = float(np.sum(w * y) / np.sum(w))
        return float(np.sum(w * (y - mu) ** 2))

    q0 = q_at(0.0)
    if q0 <= target:
        return 0.0
    upper = max(10.0, 10.0 * float(np.max(v)), 10.0 * float(np.var(y)))
    while q_at(upper) > target and upper < 1e10:
        upper *= 2
    try:
        return float(optimize.brentq(lambda t: q_at(t) - target, 0.0, upper, xtol=1e-12))
    except ValueError:
        return 0.0


def tau2_reml(y, v):
    def neg_ll(tau2):
        w = 1 / (v + tau2)
        mu = float(np.sum(w * y) / np.sum(w))
        return 0.5 * (float(np.sum(np.log(v + tau2))) + math.log(float(np.sum(w))) + float(np.sum(w * (y - mu) ** 2)))

    upper = max(10.0, 10.0 * float(np.max(v)), 10.0 * float(np.var(y)))
    best = optimize.minimize_scalar(neg_ll, bounds=(0.0, upper), method="bounded", options={"xatol": 1e-12})
    if best.x >= upper * 0.999:
        upper *= 10
        best = optimize.minimize_scalar(neg_ll, bounds=(0.0, upper), method="bounded", options={"xatol": 1e-12})
    return max(0.0, float(best.x))


def pool_stats(studies, model="random", tau2_method="reml", ci_method="normal", alpha=0.05, measure="MD", log_scale=False):
    if len(studies) < 2:
        raise ValueError("at least two studies are needed to pool")
    y = np.asarray([float(study["effect"]) for study in studies], dtype=float)
    v = np.asarray([float(study["variance"]) for study in studies], dtype=float)
    if np.any(v <= 0):
        raise ValueError("all study variances must be greater than zero")
    k = len(studies)
    w_fixed = 1 / v
    pooled_fixed = float(np.sum(w_fixed * y) / np.sum(w_fixed))
    q = float(np.sum(w_fixed * (y - pooled_fixed) ** 2))
    df = k - 1
    p_q = float(stats.chi2.sf(q, df)) if df > 0 else None
    i2 = max(0.0, (q - df) / q) * 100 if q > 0 and df > 0 else 0.0
    h2 = q / df if df > 0 else None
    warnings = []
    if k < 5:
        warnings.append("fewer than 5 studies: heterogeneity estimates and CIs are unstable")

    if model == "fixed":
        weights = w_fixed
        pooled = pooled_fixed
        se = float(math.sqrt(1 / np.sum(weights)))
        tau2 = 0.0
        method = "none"
        z = pooled / se
        p = float(2 * stats.norm.sf(abs(z)))
        ci = ci_from_se(pooled, se, alpha)
        ci_method_used = "normal"
        prediction = None
    elif model == "random":
        if tau2_method == "dl":
            tau2 = tau2_dl(y, v)[0]
        elif tau2_method == "pm":
            tau2 = tau2_pm(y, v)
        elif tau2_method == "reml":
            tau2 = tau2_reml(y, v)
        else:
            raise ValueError("tau2_method must be dl, pm, or reml")
        weights = 1 / (v + tau2)
        pooled = float(np.sum(weights * y) / np.sum(weights))
        se_normal = float(math.sqrt(1 / np.sum(weights)))
        if ci_method == "hartung_knapp":
            if k < 2:
                raise ValueError("Hartung-Knapp needs at least two studies")
            q_re = float(np.sum(weights * (y - pooled) ** 2))
            se = float(math.sqrt(q_re / ((k - 1) * np.sum(weights))))
            t_value = pooled / se
            p = float(2 * stats.t.sf(abs(t_value), df))
            crit = float(stats.t.ppf(1 - alpha / 2, df))
            ci = [float(pooled - crit * se), float(pooled + crit * se)]
            ci_method_used = "hartung_knapp"
            if k == 2:
                warnings.append("Hartung-Knapp with 2 studies is very conservative")
            z = t_value
        elif ci_method == "normal":
            se = se_normal
            z = pooled / se
            p = float(2 * stats.norm.sf(abs(z)))
            ci = ci_from_se(pooled, se, alpha)
            ci_method_used = "normal"
        else:
            raise ValueError("ci_method must be normal or hartung_knapp")
        method = tau2_method
        if k >= 3:
            crit = float(stats.t.ppf(1 - alpha / 2, k - 2))
            prediction = [float(pooled - crit * math.sqrt(tau2 + se_normal ** 2)),
                          float(pooled + crit * math.sqrt(tau2 + se_normal ** 2))]
        else:
            prediction = None
            warnings.append("prediction interval needs at least 3 studies")
    else:
        raise ValueError("model must be fixed or random")

    weight_sum = float(np.sum(weights))
    out_studies = []
    for study, yi, vi, wi in zip(studies, y, v, weights):
        row = {
            "id": study.get("id"),
            "label": study.get("label"),
            "effect": float(yi),
            "se": float(math.sqrt(vi)),
            "variance": float(vi),
            "weight": float(wi),
            "weight_pct": float(100 * wi / weight_sum),
            "ci": ci_from_se(yi, math.sqrt(vi), alpha),
        }
        if log_scale:
            row["display_effect"] = float(math.exp(yi))
            row["display_ci"] = [float(math.exp(row["ci"][0])), float(math.exp(row["ci"][1]))]
        else:
            row["display_effect"] = float(yi)
            row["display_ci"] = row["ci"]
        out_studies.append(row)

    result = {
        "k": k,
        "model": model,
        "tau2_method": method,
        "ci_method": ci_method_used,
        "alpha": alpha,
        "effect_measure": measure,
        "log_scale": bool(log_scale),
        "pooled": float(pooled),
        "se": float(se),
        "ci": ci,
        "z": float(z),
        "p": float(p),
        "weights": out_studies,
        "heterogeneity": {
            "q": float(q),
            "df": df,
            "p": p_q,
            "i2": float(i2),
            "h2": float(h2) if h2 is not None else None,
            "tau2": float(tau2),
            "tau2_method": method,
        },
        "prediction_interval": prediction,
        "warnings": warnings,
    }
    if log_scale:
        result["display_pooled"] = float(math.exp(pooled))
        result["display_ci"] = [float(math.exp(ci[0])), float(math.exp(ci[1]))]
        if prediction:
            result["display_prediction_interval"] = [float(math.exp(prediction[0])), float(math.exp(prediction[1]))]
    else:
        result["display_pooled"] = float(pooled)
        result["display_ci"] = ci
    return result


def subgroup_analysis(studies, field, model="random", tau2_method="reml", ci_method="normal", alpha=0.05, measure="MD", log_scale=False):
    groups = {}
    for study in studies:
        value = study.get("meta", {}).get(field, study.get(field))
        key = clean(value) if value is not None and clean(value) else "(not recorded)"
        groups.setdefault(key, []).append(study)
    if len(groups) < 2:
        raise ValueError(f"subgroup field {field!r} needs at least two groups")
    results = []
    warnings = []
    for key, group_studies in sorted(groups.items()):
        if len(group_studies) >= 2:
            pooled = pool_stats(group_studies, model=model, tau2_method=tau2_method, ci_method=ci_method, alpha=alpha, measure=measure, log_scale=log_scale)
            results.append({"group": key, "k": len(group_studies), **pooled})
        else:
            study = group_studies[0]
            warnings.append(f"group {key!r} has only one study; its estimate is reported without pooling")
            results.append({
                "group": key,
                "k": 1,
                "pooled": study["effect"],
                "se": study["se"],
                "ci": ci_from_se(study["effect"], study["se"], alpha),
                "display_pooled": study.get("display_effect", study["effect"]),
                "display_ci": study.get("display_ci", ci_from_se(study["effect"], study["se"], alpha)),
                "heterogeneity": None,
                "warnings": [f"group {key!r} has only one study"],
            })
    estimates = np.asarray([row["pooled"] for row in results], dtype=float)
    errors = np.asarray([row["se"] for row in results], dtype=float)
    weights = 1 / (errors * errors)
    overall = float(np.sum(weights * estimates) / np.sum(weights))
    q_between = float(np.sum(weights * (estimates - overall) ** 2))
    df = len(results) - 1
    p_between = float(stats.chi2.sf(q_between, df)) if df > 0 else None
    return {
        "field": field,
        "groups": results,
        "q_between": q_between,
        "df": df,
        "p": p_between,
        "overall": overall,
        "measure": measure,
        "log_scale": bool(log_scale),
        "warnings": warnings,
    }


def wls_fit(X, y, weights):
    w = np.asarray(weights, dtype=float)
    XtW = X.T * w
    cov = np.linalg.pinv(XtW @ X)
    beta = cov @ (XtW @ y)
    residual = y - X @ beta
    q_e = float(np.sum(w * residual * residual))
    return beta, cov, residual, q_e


def meta_regression(studies, covariates, model="random", tau2_method="reml", ci_method="normal", alpha=0.05, measure="MD", log_scale=False):
    if not covariates:
        raise ValueError("at least one covariate is required")
    rows = []
    dropped = []
    for study in studies:
        values = []
        for covariate in covariates:
            raw = study.get("meta", {}).get(covariate, study.get(covariate))
            try:
                values.append(float(raw))
            except (TypeError, ValueError):
                dropped.append({"id": study.get("id"), "reason": f"missing/non-numeric {covariate}"})
                break
        else:
            rows.append((study, values))
    if len(rows) < len(covariates) + 2:
        raise ValueError("not enough complete studies for the requested covariates")
    y = np.asarray([row[0]["effect"] for row in rows], dtype=float)
    v = np.asarray([row[0]["variance"] for row in rows], dtype=float)
    X = np.column_stack([np.ones(len(rows))] + [np.asarray([row[1][i] for row in rows], dtype=float) for i in range(len(covariates))])
    k, p = X.shape
    # Method-of-moments residual tau2 from a fixed-effect WLS fit.
    beta0, cov0, _, q_e0 = wls_fit(X, y, 1 / v)
    A = (X.T * (1 / v)) @ X
    B = (X.T * (1 / (v * v))) @ X
    denominator = float(np.trace(np.linalg.pinv(A) @ B))
    tau2 = max(0.0, (q_e0 - (k - p)) / (float(np.sum(1 / v)) - denominator)) if denominator > 0 else 0.0
    weights = 1 / (v + tau2)
    beta, cov, residual, q_e = wls_fit(X, y, weights)
    scale = 1.0
    if ci_method == "hartung_knapp":
        scale = max(1.0, q_e / (k - p))
        se = np.sqrt(np.diag(cov) * scale)
        crit = float(stats.t.ppf(1 - alpha / 2, k - p))
        pvals = [float(2 * stats.t.sf(abs(b / s), k - p)) for b, s in zip(beta, se)]
    else:
        se = np.sqrt(np.diag(cov))
        crit = float(stats.norm.ppf(1 - alpha / 2))
        pvals = [float(2 * stats.norm.sf(abs(b / s))) for b, s in zip(beta, se)]
    names = ["intercept"] + covariates
    coefficients = []
    for i, name in enumerate(names):
        coefficients.append({
            "name": name,
            "estimate": float(beta[i]),
            "se": float(se[i]),
            "ci": [float(beta[i] - crit * se[i]), float(beta[i] + crit * se[i])],
            "p": pvals[i],
        })
    total_tau2 = pool_stats([row[0] for row in rows], model=model, tau2_method=tau2_method, ci_method=ci_method, alpha=alpha, measure=measure, log_scale=log_scale)["heterogeneity"]["tau2"]
    r2 = max(0.0, 1 - tau2 / total_tau2) if total_tau2 and total_tau2 > 0 else None
    return {
        "covariates": covariates,
        "k": k,
        "coefficients": coefficients,
        "tau2": float(tau2),
        "q_e": float(q_e),
        "df": k - p,
        "p_qe": float(stats.chi2.sf(q_e, k - p)),
        "r2": r2,
        "scale": scale,
        "ci_method": ci_method,
        "dropped": dropped,
        "measure": measure,
        "log_scale": bool(log_scale),
        "warnings": ["covariates must be numeric; categorical moderators need explicit dummy coding"] if any(clean(row[0].get("meta", {}).get(c)).lower() in {"true", "false"} for row in rows for c in covariates) else [],
    }


def leave_one_out(studies, model="random", tau2_method="reml", ci_method="normal", alpha=0.05, measure="MD", log_scale=False):
    if len(studies) < 3:
        raise ValueError("leave-one-out needs at least three studies")
    full = pool_stats(studies, model=model, tau2_method=tau2_method, ci_method=ci_method, alpha=alpha, measure=measure, log_scale=log_scale)
    rows = []
    for index, study in enumerate(studies):
        remainder = studies[:index] + studies[index + 1:]
        pooled = pool_stats(remainder, model=model, tau2_method=tau2_method, ci_method=ci_method, alpha=alpha, measure=measure, log_scale=log_scale)
        rows.append({
            "omitted": study.get("id"),
            "label": study.get("label"),
            "pooled": pooled["pooled"],
            "se": pooled["se"],
            "ci": pooled["ci"],
            "display_pooled": pooled.get("display_pooled"),
            "display_ci": pooled.get("display_ci"),
            "tau2": pooled["heterogeneity"]["tau2"],
            "i2": pooled["heterogeneity"]["i2"],
            "delta": pooled["pooled"] - full["pooled"],
        })
    return {"full": full, "rows": rows, "measure": measure, "log_scale": bool(log_scale)}


def publication_bias(studies, model="random", tau2_method="reml", ci_method="normal", alpha=0.05, measure="MD", log_scale=False):
    if len(studies) < 3:
        raise ValueError("publication-bias diagnostics need at least three studies")
    y = np.asarray([float(study["effect"]) for study in studies], dtype=float)
    se = np.asarray([float(study["se"]) for study in studies], dtype=float)
    v = se * se
    precision = 1 / se
    standardized = y / se
    egger = None
    if len(studies) >= 3:
        X = np.column_stack([np.ones(len(y)), precision])
        beta = np.linalg.lstsq(X, standardized, rcond=None)[0]
        residual = standardized - X @ beta
        df = len(y) - 2
        sigma2 = float(np.sum(residual * residual) / df)
        cov = sigma2 * np.linalg.pinv(X.T @ X)
        se_intercept = float(math.sqrt(max(0.0, cov[0, 0])))
        t_value = float(beta[0] / se_intercept) if se_intercept > 0 else None
        p_value = float(2 * stats.t.sf(abs(t_value), df)) if t_value is not None else None
        egger = {
            "intercept": float(beta[0]),
            "se": se_intercept,
            "t": t_value,
            "p": p_value,
            "slope": float(beta[1]),
            "df": df,
        }
    kendall = stats.kendalltau(standardized, v)
    kendall_tau = float(kendall.statistic)
    kendall_p = float(kendall.pvalue)
    if not math.isfinite(kendall_tau):
        kendall_tau = None
    if not math.isfinite(kendall_p):
        kendall_p = None
    pooled = pool_stats(studies, model=model, tau2_method=tau2_method, ci_method=ci_method, alpha=alpha, measure=measure, log_scale=log_scale)
    warnings = []
    if len(studies) < 10:
        warnings.append("fewer than 10 studies: funnel-plot tests have low power and are unreliable")
    warnings.append("funnel-plot asymmetry is not proof of publication bias; it can reflect heterogeneity or small-study effects")
    return {
        "egger": egger,
        "begg": {
            "tau": kendall_tau,
            "p": kendall_p,
            "note": "Kendall rank correlation; exploratory only",
        },
        "pooled": pooled,
        "funnel": {
            "points": [
                {
                    "id": study.get("id"),
                    "label": study.get("label"),
                    "effect": float(yi),
                    "se": float(sei),
                    "display_effect": study.get("display_effect", float(yi)),
                }
                for study, yi, sei in zip(studies, y, se)
            ],
            "pooled": pooled["pooled"],
            "display_pooled": pooled.get("display_pooled"),
        },
        "trimfill": {
            "implemented": False,
            "note": "trim-and-fill is not implemented in this release; use Egger/funnel and a sensitivity analysis",
        },
        "warnings": warnings,
    }


def diagnostic_analysis(studies, model="random", tau2_method="reml", ci_method="normal", alpha=0.05):
    if len(studies) < 2:
        raise ValueError("diagnostic pooling needs at least two studies")
    prepared = []
    warnings = []
    for study in studies:
        tp = integer(study.get("tp"), "tp", nonnegative=True)
        fp = integer(study.get("fp"), "fp", nonnegative=True)
        fn = integer(study.get("fn"), "fn", nonnegative=True)
        tn = integer(study.get("tn"), "tn", nonnegative=True)
        if tp + fn <= 0 or fp + tn <= 0:
            raise ValueError(f"study {study.get('id')}: positive and negative groups must be non-empty")
        correction = None
        a, b, c, d = tp, fp, fn, tn
        if min(a, b, c, d) == 0:
            a, b, c, d = a + 0.5, b + 0.5, c + 0.5, d + 0.5
            correction = "0.5 added to all four cells for logit variances"
        sens = a / (a + c)
        spec = d / (b + d)
        logit_sens = math.log(sens / (1 - sens))
        logit_spec = math.log(spec / (1 - spec))
        var_sens = 1 / a + 1 / c
        var_spec = 1 / b + 1 / d
        log_dor = math.log((a * d) / (b * c))
        var_dor = 1 / a + 1 / b + 1 / c + 1 / d
        prepared.append({
            "id": study.get("id"),
            "label": study.get("label") or study.get("id"),
            "tp": tp, "fp": fp, "fn": fn, "tn": tn,
            "sensitivity": sens, "specificity": spec,
            "fpr": 1 - spec,
            "logit_sensitivity": logit_sens, "logit_specificity": logit_spec,
            "var_logit_sensitivity": var_sens, "var_logit_specificity": var_spec,
            "log_dor": log_dor, "var_log_dor": var_dor,
            "correction": correction,
            "meta": study,
        })
        if correction:
            warnings.append(f"{study.get('id')}: {correction}")
    sens_studies = [{
        "id": row["id"], "label": row["label"], "effect": row["logit_sensitivity"],
        "se": math.sqrt(row["var_logit_sensitivity"]), "variance": row["var_logit_sensitivity"], "meta": row,
    } for row in prepared]
    spec_studies = [{
        "id": row["id"], "label": row["label"], "effect": row["logit_specificity"],
        "se": math.sqrt(row["var_logit_specificity"]), "variance": row["var_logit_specificity"], "meta": row,
    } for row in prepared]
    dor_studies = [{
        "id": row["id"], "label": row["label"], "effect": row["log_dor"],
        "se": math.sqrt(row["var_log_dor"]), "variance": row["var_log_dor"], "meta": row,
    } for row in prepared]
    sens_pool = pool_stats(sens_studies, model=model, tau2_method=tau2_method, ci_method=ci_method, alpha=alpha, measure="LOGIT_SENS", log_scale=False)
    spec_pool = pool_stats(spec_studies, model=model, tau2_method=tau2_method, ci_method=ci_method, alpha=alpha, measure="LOGIT_SPEC", log_scale=False)
    dor_pool = pool_stats(dor_studies, model=model, tau2_method=tau2_method, ci_method=ci_method, alpha=alpha, measure="LOG_DOR", log_scale=False)
    sens_ci = [logistic(sens_pool["ci"][0]), logistic(sens_pool["ci"][1])]
    spec_ci = [logistic(spec_pool["ci"][0]), logistic(spec_pool["ci"][1])]
    dor_ci = [math.exp(dor_pool["ci"][0]), math.exp(dor_pool["ci"][1])]
    if len(studies) < 4:
        warnings.append("fewer than 4 diagnostic studies: pooled sensitivity/specificity models are unstable")
    warnings.append("univariate logit pooling and study-point SROC; a full bivariate/HSROC model is not implemented in this release")
    return {
        "k": len(studies),
        "studies": prepared,
        "sensitivity": {
            "pooled": logistic(sens_pool["pooled"]),
            "ci": sens_ci,
            "logit": sens_pool,
        },
        "specificity": {
            "pooled": logistic(spec_pool["pooled"]),
            "ci": spec_ci,
            "logit": spec_pool,
        },
        "dor": {
            "pooled": math.exp(dor_pool["pooled"]),
            "ci": dor_ci,
            "log": dor_pool,
        },
        "sroc_points": [
            {
                "id": row["id"],
                "label": row["label"],
                "fpr": row["fpr"],
                "tpr": row["sensitivity"],
            }
            for row in prepared
        ],
        "model": model,
        "tau2_method": tau2_method,
        "ci_method": ci_method,
        "alpha": alpha,
        "warnings": warnings,
    }


def svg_escape(value):
    return html.escape(str(value), quote=True)


def forest_svg(pool):
    studies = pool["weights"]
    k = len(studies)
    log_scale = pool.get("log_scale")
    width = 960
    height = max(240, 150 + k * 34)
    left = 280
    right = 900
    top = 100
    values = []
    for row in studies:
        values.extend([row.get("display_ci", row["ci"])[0], row.get("display_ci", row["ci"])[1]])
    values.extend([pool.get("display_ci", pool["ci"])[0], pool.get("display_ci", pool["ci"])[1]])
    lo, hi = min(values), max(values)
    if hi <= lo:
        hi, lo = lo + 1, lo - 1
    pad = (hi - lo) * 0.08
    lo -= pad
    hi += pad

    def xpos(value):
        return left + (float(value) - lo) / (hi - lo) * (right - left)

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img">',
        '<style>text{font-family:Inter,Segoe UI,Arial,sans-serif;}</style>',
        f'<rect x="0" y="0" width="{width}" height="{height}" fill="#ffffff"/>',
        f'<text x="24" y="34" font-size="20" font-weight="bold" fill="#0f172a">Forest plot</text>',
        f'<text x="24" y="56" font-size="13" fill="#475569">{svg_escape(pool["k"])} studies · {svg_escape(pool["model"])} model · {svg_escape(pool["tau2_method"])} τ² · {svg_escape(pool["ci_method"])} CI</text>',
        f'<text x="{left}" y="82" font-size="12" fill="#475569">Effect ({"ratio" if log_scale else "analysis"} scale)</text>',
        f'<line x1="{left}" y1="{top - 14}" x2="{right}" y2="{top - 14}" stroke="#94a3b8"/>',
        f'<line x1="{left}" y1="{top - 14}" x2="{left}" y2="{top + k * 34}" stroke="#94a3b8"/>',
    ]
    for row_index, row in enumerate(studies):
        y = top + row_index * 34
        effect = row.get("display_effect", row["effect"])
        ci = row.get("display_ci", row["ci"])
        size = max(3.0, min(10.0, 2.0 + math.sqrt(max(0.1, row["weight_pct"])) * 1.1))
        parts.append(f'<text x="24" y="{y + 4}" font-size="12" fill="#1f2937">{svg_escape(row.get("label") or row.get("id"))}</text>')
        parts.append(f'<text x="{left - 12}" y="{y + 4}" font-size="11" text-anchor="end" fill="#475569">{row["weight_pct"]:.1f}%</text>')
        parts.append(f'<line x1="{xpos(ci[0]):.2f}" y1="{y}" x2="{xpos(ci[1]):.2f}" y2="{y}" stroke="#334155" stroke-width="1.5"/>')
        parts.append(f'<rect x="{xpos(effect) - size / 2:.2f}" y="{y - size / 2:.2f}" width="{size:.2f}" height="{size:.2f}" fill="#2563eb"/>')
        parts.append(f'<text x="{right + 10}" y="{y + 4}" font-size="11" fill="#475569">{effect:.3g} [{ci[0]:.3g}, {ci[1]:.3g}]</text>')
    pooled_y = top + k * 34 + 6
    pooled = pool.get("display_pooled", pool["pooled"])
    pooled_ci = pool.get("display_ci", pool["ci"])
    diamond = f'{xpos(pooled_ci[0]):.2f},{pooled_y - 8} {xpos(pooled):.2f},{pooled_y} {xpos(pooled_ci[1]):.2f},{pooled_y - 8} {xpos(pooled):.2f},{pooled_y - 16}'
    parts.append(f'<polygon points="{diamond}" fill="#0f766e"/>')
    parts.append(f'<text x="24" y="{pooled_y}" font-size="13" font-weight="bold" fill="#0f172a">Pooled</text>')
    parts.append(f'<text x="{right + 10}" y="{pooled_y}" font-size="12" font-weight="bold" fill="#0f172a">{pooled:.3g} [{pooled_ci[0]:.3g}, {pooled_ci[1]:.3g}]</text>')
    het = pool["heterogeneity"]
    parts.append(f'<text x="24" y="{height - 24}" font-size="12" fill="#64748b">Q = {het["q"]:.3g}, df = {het["df"]}, p = {het["p"] if het["p"] is not None else "n/a"}; I² = {het["i2"]:.1f}%; τ² = {het["tau2"]:.3g}</text>')
    if pool.get("prediction_interval"):
        pi = pool.get("display_prediction_interval", pool["prediction_interval"])
        parts.append(f'<text x="24" y="{height - 6}" font-size="12" fill="#64748b">Prediction interval: {pi[0]:.3g} to {pi[1]:.3g}</text>')
    parts.append('</svg>')
    return "\n".join(parts)


def funnel_svg(pool):
    funnel = pool.get("funnel") or {}
    points = funnel.get("points") or pool.get("points") or []
    pooled_value = pool.get("pooled")
    if isinstance(pooled_value, dict):
        pooled_value = pooled_value.get("pooled")
    if pooled_value is None:
        pooled_value = funnel.get("pooled")
    if pooled_value is None:
        raise ValueError("funnel plot needs a pooled effect")
    width, height = 760, 540
    left, right, top, bottom = 90, 700, 70, 460
    effects = [point["effect"] for point in points] + [float(pooled_value)]
    se_max = max([point["se"] for point in points] + [0.01])
    effect_min, effect_max = min(effects), max(effects)
    if effect_max <= effect_min:
        effect_max, effect_min = effect_min + 1, effect_min - 1
    pad = (effect_max - effect_min) * 0.1
    effect_min -= pad
    effect_max += pad
    se_max *= 1.1

    def xpos(value):
        return left + (float(value) - effect_min) / (effect_max - effect_min) * (right - left)

    def ypos(value):
        return top + (float(value) / se_max) * (bottom - top)

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img">',
        '<style>text{font-family:Inter,Segoe UI,Arial,sans-serif;}</style>',
        f'<rect x="0" y="0" width="{width}" height="{height}" fill="#ffffff"/>',
        f'<text x="24" y="34" font-size="20" font-weight="bold" fill="#0f172a">Funnel plot</text>',
        f'<text x="24" y="56" font-size="13" fill="#475569">x = effect (analysis scale), y = standard error</text>',
        f'<line x1="{left}" y1="{top}" x2="{left}" y2="{bottom}" stroke="#94a3b8"/>',
        f'<line x1="{left}" y1="{top}" x2="{right}" y2="{top}" stroke="#94a3b8"/>',
        f'<line x1="{left}" y1="{bottom}" x2="{right}" y2="{bottom}" stroke="#94a3b8"/>',
    ]
    for frac in (0, 0.25, 0.5, 0.75, 1):
        value = effect_min + frac * (effect_max - effect_min)
        parts.append(f'<text x="{xpos(value):.1f}" y="{bottom + 20}" font-size="11" text-anchor="middle" fill="#64748b">{value:.3g}</text>')
    for frac in (0, 0.5, 1):
        value = frac * se_max
        parts.append(f'<text x="{left - 10}" y="{ypos(value) + 4}" font-size="11" text-anchor="end" fill="#64748b">{value:.3g}</text>')
    # Pseudo 95% funnel: pooled ± 1.96*SE, drawn on the analysis scale.
    x_left = xpos(float(pooled_value) - 1.96 * se_max)
    x_right = xpos(float(pooled_value) + 1.96 * se_max)
    parts.append(f'<line x1="{xpos(float(pooled_value)):.1f}" y1="{top}" x2="{x_left:.1f}" y2="{bottom}" stroke="#cbd5e1" stroke-dasharray="4 4"/>')
    parts.append(f'<line x1="{xpos(float(pooled_value)):.1f}" y1="{top}" x2="{x_right:.1f}" y2="{bottom}" stroke="#cbd5e1" stroke-dasharray="4 4"/>')
    parts.append(f'<line x1="{xpos(float(pooled_value)):.1f}" y1="{top}" x2="{xpos(float(pooled_value)):.1f}" y2="{bottom}" stroke="#0f766e" stroke-width="2"/>')
    for point in points:
        parts.append(f'<circle cx="{xpos(point["effect"]):.1f}" cy="{ypos(point["se"]):.1f}" r="4" fill="#2563eb"/>')
        parts.append(f'<text x="{xpos(point["effect"]) + 7:.1f}" y="{ypos(point["se"]) + 4:.1f}" font-size="10" fill="#475569">{svg_escape(point.get("label") or point.get("id"))}</text>')
    parts.append(f'<text x="24" y="{height - 24}" font-size="12" fill="#64748b">Pooled effect = {float(pooled_value):.3g}. Funnel-plot asymmetry is not proof of publication bias.</text>')
    parts.append('</svg>')
    return "\n".join(parts)


def sroc_svg(diagnostic):
    width, height = 640, 560
    left, right, top, bottom = 80, 580, 60, 500

    def xpos(value):
        return left + float(value) * (right - left)

    def ypos(value):
        return bottom - float(value) * (bottom - top)

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img">',
        '<style>text{font-family:Inter,Segoe UI,Arial,sans-serif;}</style>',
        f'<rect x="0" y="0" width="{width}" height="{height}" fill="#ffffff"/>',
        f'<text x="24" y="32" font-size="20" font-weight="bold" fill="#0f172a">SROC plot</text>',
        f'<text x="24" y="52" font-size="12" fill="#475569">Study points and pooled sensitivity/specificity</text>',
        f'<line x1="{left}" y1="{top}" x2="{left}" y2="{bottom}" stroke="#94a3b8"/>',
        f'<line x1="{left}" y1="{bottom}" x2="{right}" y2="{bottom}" stroke="#94a3b8"/>',
    ]
    for frac in (0, 0.25, 0.5, 0.75, 1):
        parts.append(f'<text x="{xpos(frac):.1f}" y="{bottom + 20}" font-size="11" text-anchor="middle" fill="#64748b">{frac:.2f}</text>')
        parts.append(f'<text x="{left - 10}" y="{ypos(frac) + 4}" font-size="11" text-anchor="end" fill="#64748b">{frac:.2f}</text>')
    parts.append(f'<text x="{(left + right) / 2:.1f}" y="{height - 20}" font-size="12" text-anchor="middle" fill="#64748b">False positive rate (1 − specificity)</text>')
    parts.append(f'<text x="18" y="{(top + bottom) / 2:.1f}" font-size="12" fill="#64748b" transform="rotate(-90 18 {(top + bottom) / 2:.1f})">Sensitivity</text>')
    parts.append(f'<line x1="{xpos(0):.1f}" y1="{ypos(0):.1f}" x2="{xpos(1):.1f}" y2="{ypos(1):.1f}" stroke="#e2e8f0"/>')
    for point in diagnostic["sroc_points"]:
        parts.append(f'<circle cx="{xpos(point["fpr"]):.1f}" cy="{ypos(point["tpr"]):.1f}" r="5" fill="#2563eb"/>')
        parts.append(f'<text x="{xpos(point["fpr"]) + 8:.1f}" y="{ypos(point["tpr"]) + 4:.1f}" font-size="10" fill="#475569">{svg_escape(point.get("label") or point.get("id"))}</text>')
    sens = diagnostic["sensitivity"]["pooled"]
    spec = diagnostic["specificity"]["pooled"]
    parts.append(f'<circle cx="{xpos(1 - spec):.1f}" cy="{ypos(sens):.1f}" r="8" fill="#0f766e"/>')
    parts.append(f'<text x="{xpos(1 - spec) + 12:.1f}" y="{ypos(sens) - 10:.1f}" font-size="12" font-weight="bold" fill="#0f766e">Pooled</text>')
    parts.append(f'<text x="24" y="{height - 4}" font-size="11" fill="#64748b">Sensitivity {sens:.3f} · Specificity {spec:.3f} · DOR {diagnostic["dor"]["pooled"]:.3g}</text>')
    parts.append('</svg>')
    return "\n".join(parts)


def handle(request):
    action = clean(request.get("action")).lower()
    if action == "effect_size":
        measure = clean(request.get("measure") or "MD").upper()
        data = request.get("input") or {}
        study_type = clean(data.get("type")).lower()
        if study_type == "binary":
            return binary_effect(data.get("a"), data.get("b"), data.get("c"), data.get("d"), measure)
        if study_type == "continuous":
            return continuous_effect(data.get("m1"), data.get("sd1"), data.get("n1"),
                                     data.get("m2"), data.get("sd2"), data.get("n2"), measure)
        if study_type == "correlation":
            return correlation_effect(data.get("r"), data.get("n"))
        if study_type == "ratio":
            return ratio_effect(data.get("effect"), se=data.get("se"), ci_low=data.get("ci_low"),
                                ci_high=data.get("ci_high"), measure=measure,
                                effect_scale=clean(data.get("effect_scale") or "ratio"))
        return generic_effect(data.get("effect"), se=data.get("se"), ci_low=data.get("ci_low"),
                              ci_high=data.get("ci_high"), measure=measure,
                              log_scale=bool(data.get("log_scale")) or measure in RATIO_MEASURES)

    if action == "prepare":
        measure = clean(request.get("measure") or "MD").upper()
        prepared = []
        skipped = []
        for study in request.get("studies") or []:
            try:
                prepared.append(prepare_study(study, measure))
            except Exception as exc:
                skipped.append({"id": study.get("id") if isinstance(study, dict) else None, "reason": str(exc)})
        return {"prepared": prepared, "skipped": skipped, "measure": measure}

    if action == "pool":
        return pool_stats(
            request.get("studies") or [],
            model=clean(request.get("model") or "random").lower(),
            tau2_method=clean(request.get("tau2_method") or "reml").lower(),
            ci_method=clean(request.get("ci_method") or "normal").lower(),
            alpha=number(request.get("alpha", 0.05), "alpha", positive=True),
            measure=clean(request.get("effect_measure") or "MD").upper(),
            log_scale=bool(request.get("log_scale")),
        )

    if action == "subgroup":
        return subgroup_analysis(
            request.get("studies") or [],
            clean(request.get("field")),
            model=clean(request.get("model") or "random").lower(),
            tau2_method=clean(request.get("tau2_method") or "reml").lower(),
            ci_method=clean(request.get("ci_method") or "normal").lower(),
            alpha=number(request.get("alpha", 0.05), "alpha", positive=True),
            measure=clean(request.get("effect_measure") or "MD").upper(),
            log_scale=bool(request.get("log_scale")),
        )

    if action == "meta_regression":
        return meta_regression(
            request.get("studies") or [],
            request.get("covariates") or [],
            model=clean(request.get("model") or "random").lower(),
            tau2_method=clean(request.get("tau2_method") or "reml").lower(),
            ci_method=clean(request.get("ci_method") or "normal").lower(),
            alpha=number(request.get("alpha", 0.05), "alpha", positive=True),
            measure=clean(request.get("effect_measure") or "MD").upper(),
            log_scale=bool(request.get("log_scale")),
        )

    if action == "leave_one_out":
        return leave_one_out(
            request.get("studies") or [],
            model=clean(request.get("model") or "random").lower(),
            tau2_method=clean(request.get("tau2_method") or "reml").lower(),
            ci_method=clean(request.get("ci_method") or "normal").lower(),
            alpha=number(request.get("alpha", 0.05), "alpha", positive=True),
            measure=clean(request.get("effect_measure") or "MD").upper(),
            log_scale=bool(request.get("log_scale")),
        )

    if action == "publication_bias":
        return publication_bias(
            request.get("studies") or [],
            model=clean(request.get("model") or "random").lower(),
            tau2_method=clean(request.get("tau2_method") or "reml").lower(),
            ci_method=clean(request.get("ci_method") or "normal").lower(),
            alpha=number(request.get("alpha", 0.05), "alpha", positive=True),
            measure=clean(request.get("effect_measure") or "MD").upper(),
            log_scale=bool(request.get("log_scale")),
        )

    if action == "diagnostic":
        return diagnostic_analysis(
            request.get("studies") or [],
            model=clean(request.get("model") or "random").lower(),
            tau2_method=clean(request.get("tau2_method") or "reml").lower(),
            ci_method=clean(request.get("ci_method") or "normal").lower(),
            alpha=number(request.get("alpha", 0.05), "alpha", positive=True),
        )

    if action == "plot":
        kind = clean(request.get("kind") or "forest").lower()
        if kind == "forest":
            return {"svg": forest_svg(request.get("pool") or {})}
        if kind == "funnel":
            return {"svg": funnel_svg(request.get("pool") or {})}
        if kind == "sroc":
            return {"svg": sroc_svg(request.get("diagnostic") or {})}
        raise ValueError("plot kind must be forest, funnel, or sroc")

    raise ValueError(f"unknown action: {action}")


def main():
    try:
        request = json.load(sys.stdin)
        emit(handle(request))
    except Exception as exc:
        fail(exc)


if __name__ == "__main__":
    main()
