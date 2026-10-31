"""data_profile: local scientific-data profiling for Academic Harness.

Reads one JSON request on stdin, writes one JSON result on stdout.

Request: {path, target?, split?, id_columns?, max_rows?, association_threshold?}

The profiler reports schema, quality, and leakage *risks*. It never claims
data are safe, de-identified, or PHI-free: checks it cannot run are listed in
`not_checked`.
"""
import json
import re
import sys


def fail(message):
    print(json.dumps({"error": message}))
    sys.exit(0)


def load_frame(path, max_rows):
    import pandas as pd

    lowered = path.lower()
    kwargs = {}
    if max_rows:
        kwargs["nrows"] = int(max_rows)
    if lowered.endswith((".tsv", ".tab")):
        frame = pd.read_csv(path, sep="\t", **kwargs)
    elif lowered.endswith(".csv"):
        frame = pd.read_csv(path, **kwargs)
    elif lowered.endswith((".parquet", ".pq")):
        frame = pd.read_parquet(path, **({"columns": None} | kwargs))
    elif lowered.endswith(".arrow"):
        frame = pd.read_feather(path)
    elif lowered.endswith((".xlsx", ".xls")):
        frame = pd.read_excel(path, **kwargs)
    elif lowered.endswith(".jsonl") or lowered.endswith(".ndjson"):
        frame = pd.read_json(path, lines=True, **kwargs)
    elif lowered.endswith(".json"):
        frame = pd.read_json(path, **kwargs)
    else:
        frame = pd.read_csv(path, **kwargs)
    sampled = bool(max_rows) and len(frame) >= int(max_rows)
    return frame, sampled


DATE_PATTERN = re.compile(r"^\d{4}[-/]\d{1,2}([-/]\d{1,2})?")


def looks_like_dates(series, sample=200):
    import pandas as pd

    if str(series.dtype) != "object":
        return False
    values = series.dropna().astype(str).head(sample)
    if values.empty:
        return False
    hits = values.str.match(DATE_PATTERN).mean()
    if hits < 0.8:
        return False
    parsed = pd.to_datetime(values, errors="coerce", format="mixed")
    return float(parsed.notna().mean()) >= 0.9


def column_profile(frame, name, id_pattern):
    import pandas as pd

    series = frame[name]
    total = int(len(series))
    missing = int(series.isna().sum())
    unique = int(series.nunique(dropna=True))
    profile = {
        "name": str(name),
        "dtype": str(series.dtype),
        "rows": total,
        "missing": missing,
        "missing_pct": round(100.0 * missing / total, 2) if total else 0.0,
        "unique": unique,
        "constant": unique <= 1 and missing == 0,
        "id_like": bool(id_pattern.search(str(name).lower())) or (unique > 20 and total and unique / total > 0.9),
        "date_like": pd.api.types.is_datetime64_any_dtype(series) or looks_like_dates(series),
    }
    if pd.api.types.is_numeric_dtype(series) and not pd.api.types.is_bool_dtype(series):
        described = series.describe()
        profile["numeric"] = {
            "min": float(described["min"]),
            "max": float(described["max"]),
            "mean": float(described["mean"]),
            "std": float(described["std"]) if pd.notna(described["std"]) else None,
            "median": float(described["50%"]),
        }
    elif not pd.api.types.is_datetime64_any_dtype(series):
        counts = series.value_counts(dropna=True).head(5)
        profile["top_categories"] = [
            {"value": str(key), "count": int(value)} for key, value in counts.items()
        ]
    return profile


def association(frame, column, target):
    """Symmetric-ish 0..1 association between one column and the target."""
    import numpy as np
    import pandas as pd

    source = frame[[column, target]].dropna()
    if len(source) < 3:
        return None
    x, y = source[column], source[target]

    def numericised(series):
        if pd.api.types.is_numeric_dtype(series):
            return series.astype(float), "numeric"
        if pd.api.types.is_bool_dtype(series):
            return series.astype(float), "numeric"
        codes = series.astype("category").cat.codes.astype(float)
        return codes, "categorical"

    xs, xkind = numericised(x)
    ys, ykind = numericised(y)
    if xkind == "numeric" and ykind == "numeric":
        if xs.nunique() <= 1 or ys.nunique() <= 1:
            return None
        correlation = float(np.corrcoef(xs, ys)[0, 1])
        return None if np.isnan(correlation) else abs(correlation)
    if xkind == "numeric" and ykind == "categorical":
        grouped = pd.DataFrame({"x": xs, "y": ys}).groupby("y")["x"]
        grand = float(xs.mean())
        variance = float(xs.var(ddof=0))
        if variance == 0 or grouped.ngroups <= 1:
            return None
        eta = sum(
            len(group) * (float(group.mean()) - grand) ** 2
            for _, group in grouped
        ) / (len(xs) * variance)
        return float(min(1.0, max(0.0, eta))) ** 0.5
    # categorical x, categorical y -> normalized mutual information
    if min(xs.nunique(), ys.nunique()) > 2000:
        return None
    contingency = pd.crosstab(xs, ys)
    total = float(contingency.values.sum())
    if total <= 0:
        return None
    joint = contingency.values / total
    px = joint.sum(axis=1, keepdims=True)
    py = joint.sum(axis=0, keepdims=True)
    with np.errstate(divide="ignore", invalid="ignore"):
        ratio = np.where(joint > 0, joint / (px @ py), 0.0)
        mutual = float(np.nansum(joint * np.log2(ratio)))
    hx = float(-np.nansum(px[px > 0] * np.log2(px[px > 0])))
    hy = float(-np.nansum(py[py > 0] * np.log2(py[py > 0])))
    if hx <= 0 or hy <= 0:
        return None
    return float(min(1.0, max(0.0, mutual / min(hx, hy))))


def main():
    try:
        request = json.load(sys.stdin)
    except Exception as error:  # noqa: BLE001
        fail(f"invalid request JSON: {error}")
        return

    path = request.get("path")
    if not path:
        fail("path is required")
        return
    target = request.get("target")
    split = request.get("split")
    id_columns = [str(entry) for entry in (request.get("id_columns") or [])]
    max_rows = request.get("max_rows")
    threshold = float(request.get("association_threshold") or 0.6)

    try:
        import pandas as pd
    except ImportError:
        print(json.dumps({"error": "data_profile needs pandas; run: cd python-helpers && uv sync", "code": "pandas_missing"}))
        return

    try:
        frame, sampled = load_frame(path, max_rows)
    except Exception as error:  # noqa: BLE001
        fail(f"could not read {path}: {error}")
        return

    id_pattern = re.compile(r"(^|_)(id|uuid|guid|hash|code|key|record|patient|subject)($|_)|id$|uuid$", re.I)
    columns = list(frame.columns)
    for name in [target, split]:
        if name and name not in columns:
            fail(f"column '{name}' is not in the file")
            return

    profiles = [column_profile(frame, name, id_pattern) for name in columns]

    duplicate_rows = int(frame.duplicated().sum())
    column_hashes = {}
    for name in columns:
        digest = int(pd.util.hash_pandas_object(frame[name], index=False).sum())
        column_hashes.setdefault(digest, []).append(str(name))
    duplicate_groups = [names for names in column_hashes.values() if len(names) > 1]
    duplicate_columns = sum(len(names) - 1 for names in duplicate_groups)

    findings = []
    associations = {}
    if target:
        for name in columns:
            if name == target:
                continue
            value = association(frame, name, target)
            if value is not None:
                associations[name] = round(value, 4)
        near = [name for name, value in associations.items() if value >= 0.95]
        high = [name for name, value in associations.items() if threshold <= value < 0.95]
        if near:
            findings.append({
                "kind": "possible_leakage",
                "severity": "high",
                "columns": near,
                "note": "near-deterministic association with the target; confirm these are known at prediction time",
            })
        if high:
            findings.append({
                "kind": "high_target_association",
                "severity": "review",
                "columns": high,
                "note": f"association >= {threshold} with the target; not automatically leakage",
            })
        suspicious_ids = [
            profile["name"] for profile in profiles
            if profile["name"] != target and profile["id_like"] and associations.get(profile["name"], 0) >= threshold
        ]
        if suspicious_ids:
            findings.append({
                "kind": "id_like_target_correlation",
                "severity": "high",
                "columns": suspicious_ids,
                "note": "ID-like columns that track the target often encode the outcome",
            })
        target_series = frame[target].dropna()
        if pd.api.types.is_numeric_dtype(target_series) and target_series.nunique() > 10:
            balance = {"kind": "numeric", "mean": float(target_series.mean()), "std": float(target_series.std())}
        else:
            counts = frame[target].value_counts(dropna=False)
            balance = {"kind": "categories", "counts": {str(key): int(value) for key, value in counts.items()}}
            smallest = counts.min()
            if int(counts.shape[0]) > 1 and float(smallest) < max(5, 0.01 * len(frame)):
                findings.append({"kind": "small_target_class", "severity": "review", "columns": [target],
                                 "note": f"smallest class has {int(smallest)} rows"})
    else:
        balance = None

    if split:
        groups = frame[split].astype(str)
        frame_key = frame.drop(columns=[split]).apply(lambda row: "|".join(map(str, row)), axis=1)
        duplicated_across = 0
        seen = {}
        for key, group in zip(frame_key, groups):
            owner = seen.setdefault(key, set())
            owner.add(group)
        duplicated_across = sum(len(groups_) - 1 for groups_ in seen.values() if len(groups_) > 1)
        if duplicated_across:
            findings.append({
                "kind": "split_overlap",
                "severity": "high",
                "columns": [split],
                "note": f"{duplicated_across} row(s) appear in more than one split value",
            })
        split_summary = {str(key): int(value) for key, value in groups.value_counts().items()}
    else:
        duplicated_across = 0
        split_summary = None

    small_cells = []
    for profile in profiles:
        if profile["name"] in (target, split) or profile.get("numeric"):
            continue
        if 1 < profile["unique"] <= 50:
            counts = frame[profile["name"]].value_counts()
            if int(counts.min()) < 5:
                small_cells.append({"column": profile["name"], "min_cell": int(counts.min())})
    if small_cells:
        findings.append({"kind": "small_categorical_cells", "severity": "review",
                         "columns": [entry["column"] for entry in small_cells],
                         "note": "cells with fewer than 5 rows are unstable for strata and quasi-identifiers"})

    constant_columns = [profile["name"] for profile in profiles if profile["constant"]]
    high_missing = [profile["name"] for profile in profiles if profile["missing_pct"] > 50]
    if constant_columns:
        findings.append({"kind": "constant_columns", "severity": "info", "columns": constant_columns, "note": "no variation"})
    if high_missing:
        findings.append({"kind": "high_missingness", "severity": "review", "columns": high_missing, "note": ">50% missing"})

    result = {
        "path": path,
        "rows": int(len(frame)),
        "columns": len(columns),
        "sampled": sampled,
        "sample_note": (f"only the first {int(max_rows)} rows were read; totals describe the sample" if sampled else None),
        "duplicate_rows": duplicate_rows,
        "duplicate_columns": duplicate_columns,
        "column_profiles": profiles,
        "target": target,
        "target_balance": balance,
        "associations_with_target": associations if target else None,
        "split": split,
        "split_summary": split_summary,
        "split_overlap_rows": duplicated_across,
        "id_columns_flagged": sorted({profile["name"] for profile in profiles if profile["id_like"]} | set(id_columns)),
        "small_cells": small_cells,
        "findings": findings,
        "not_checked": [
            "protected health information or personal data content",
            "provenance or consent of the source",
            "temporal validity of recorded values",
            "correctness of any label assignment",
        ],
    }
    print(json.dumps(result, default=str))


if __name__ == "__main__":
    main()
