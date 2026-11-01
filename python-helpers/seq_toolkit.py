"""Local sequence computations in pure Python. JSON request on stdin, JSON on stdout.

Actions: stats, translate, orfs, primer_tm, align.
Biopython is used only when installed, for BLOSUM62 protein scoring; otherwise
protein alignment falls back to identity scoring and says so. There is no
network access and no BLAST here.
"""
from __future__ import annotations

import json
import math
import sys

MAX_RESIDUES = 2_000_000
MAX_ALIGN = 5000

CODONS = {}
_bases = "TCAG"
_aas = "FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG"
_i = 0
for a in _bases:
    for b in _bases:
        for c in _bases:
            CODONS[a + b + c] = _aas[_i]
            _i += 1

COMPLEMENT = str.maketrans("ACGTUNRYKMSWBDHVacgtunrykmswbdhv", "TGCAANYRMKSWVHDBtgcaanyrmkswvhdb")
DNA_ALPHABET = set("ACGTN")
RNA_ALPHABET = set("ACGUN")
PROTEIN_ALPHABET = set("ACDEFGHIKLMNPQRSTVWYXBZUO*")
AA_MASS = {  # average residue masses (Da), water added once per chain
    "A": 71.0788, "R": 156.1875, "N": 114.1038, "D": 115.0886, "C": 103.1388, "E": 129.1155, "Q": 128.1307,
    "G": 57.0519, "H": 137.1411, "I": 113.1594, "L": 113.1594, "K": 128.1741, "M": 131.1926, "F": 147.1766,
    "P": 97.1167, "S": 87.0782, "T": 101.1051, "W": 186.2132, "Y": 163.1760, "V": 99.1326,
}
WATER = 18.01524

# SantaLucia 1998 unified nearest-neighbour parameters: dH kcal/mol, dS cal/(mol K)
NN = {
    "AA": (-7.9, -22.2), "TT": (-7.9, -22.2), "AT": (-7.2, -20.4), "TA": (-7.2, -21.3),
    "CA": (-8.5, -22.7), "TG": (-8.5, -22.7), "GT": (-8.4, -22.4), "AC": (-8.4, -22.4),
    "CT": (-7.8, -21.0), "AG": (-7.8, -21.0), "GA": (-8.2, -22.2), "TC": (-8.2, -22.2),
    "CG": (-10.6, -27.2), "GC": (-9.8, -24.4), "GG": (-8.0, -19.9), "CC": (-8.0, -19.9),
}


def emit(value):
    print(json.dumps(value))
    sys.exit(0)


def fail(message, code=None):
    emit({"error": message, **({"code": code} if code else {})})


def parse_records(raw):
    """FASTA text or a bare sequence -> [(name, sequence)]."""
    records, name, parts = [], None, []
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith(";"):
            continue
        if line.startswith(">"):
            if name is not None or parts:
                records.append((name or f"seq{len(records) + 1}", "".join(parts)))
            name, parts = line[1:].strip() or f"seq{len(records) + 1}", []
        else:
            parts.append("".join(ch for ch in line if not ch.isspace() and not ch.isdigit()))
    if name is not None or parts:
        records.append((name or f"seq{len(records) + 1}", "".join(parts)))
    return [(n, s.upper()) for n, s in records if s]


def load(request):
    raw = request.get("sequence")
    if request.get("path"):
        raw = open(request["path"], encoding="utf-8", errors="replace").read()
    if not raw or not str(raw).strip():
        fail("sequence (FASTA or a raw sequence) or path is required")
    records = parse_records(str(raw))
    if not records:
        fail("no sequence found in the input")
    total = sum(len(s) for _, s in records)
    if total > MAX_RESIDUES:
        fail(f"input has {total} residues; the limit is {MAX_RESIDUES}. Split the file", "too_large")
    return records


def kind_of(seq):
    letters = set(seq)
    if letters <= DNA_ALPHABET:
        return "dna"
    if letters <= RNA_ALPHABET:
        return "rna"
    if letters <= PROTEIN_ALPHABET:
        return "protein"
    return "unknown"


def revcomp(seq):
    return seq.translate(COMPLEMENT)[::-1]


def translate_seq(dna, to_stop=False):
    out = []
    dna = dna.replace("U", "T")
    for i in range(0, len(dna) - len(dna) % 3, 3):
        aa = CODONS.get(dna[i:i + 3], "X")
        if aa == "*" and to_stop:
            break
        out.append(aa)
    return "".join(out)


def action_stats(request):
    rows = []
    for name, seq in load(request):
        kind = request.get("kind") or kind_of(seq)
        row = {"name": name, "length": len(seq), "type": kind}
        counts = {}
        for ch in seq:
            counts[ch] = counts.get(ch, 0) + 1
        row["composition"] = dict(sorted(counts.items()))
        if kind in ("dna", "rna"):
            gc = counts.get("G", 0) + counts.get("C", 0)
            unambiguous = len(seq) - counts.get("N", 0)
            row["gc_percent"] = round(100 * gc / unambiguous, 2) if unambiguous else None
            row["ambiguous_bases"] = counts.get("N", 0)
        elif kind == "protein":
            known = [ch for ch in seq if ch in AA_MASS]
            row["unknown_residues"] = len(seq) - len(known)
            row["mass_da"] = round(sum(AA_MASS[ch] for ch in known) + WATER, 2) if known else None
            row["mass_note"] = "average mass of the standard residues only; unknown residues are excluded" if len(known) != len(seq) else "average mass"
        else:
            row["warning"] = "contains characters outside DNA, RNA, and protein alphabets"
        rows.append(row)
    return {"rows": rows}


def action_translate(request):
    frame = int(request.get("frame") or 1)
    if frame not in (1, 2, 3, -1, -2, -3):
        fail("frame must be 1, 2, 3, -1, -2, or -3")
    to_stop = bool(request.get("to_stop"))
    rows = []
    for name, seq in load(request):
        if kind_of(seq) == "protein":
            rows.append({"name": name, "error": "this looks like a protein, not nucleotide, sequence"})
            continue
        template = revcomp(seq) if frame < 0 else seq
        sub = template[abs(frame) - 1:]
        protein = translate_seq(sub, to_stop)
        rows.append({"name": name, "frame": frame, "nucleotides_used": len(sub) - len(sub) % 3, "protein": protein, "protein_length": len(protein), "trailing_nucleotides": len(sub) % 3, "internal_stops": protein[:-1].count("*") if not to_stop else 0})
    return {"table": "standard genetic code (NCBI table 1)", "rows": rows}


def action_orfs(request):
    min_aa = int(request.get("min_length_aa") or 100)
    allow_alt = bool(request.get("alt_starts"))
    starts = {"ATG", "GTG", "TTG"} if allow_alt else {"ATG"}
    found = []
    for name, seq in load(request):
        if kind_of(seq) == "protein":
            continue
        dna = seq.replace("U", "T")
        n = len(dna)
        for strand, template in (("+", dna), ("-", revcomp(dna))):
            for offset in range(3):
                i = offset
                while i + 3 <= n:
                    if template[i:i + 3] in starts:
                        j = i
                        while j + 3 <= n and CODONS.get(template[j:j + 3], "X") != "*":
                            j += 3
                        complete = j + 3 <= n
                        length_aa = (j - i) // 3
                        if length_aa >= min_aa:
                            start_pos, end_pos = (i + 1, j + 3 if complete else n) if strand == "+" else (n - (j + 3 if complete else n) + 1, n - i)
                            found.append({"name": name, "strand": strand, "frame": offset + 1, "start": start_pos, "end": end_pos, "length_aa": length_aa, "has_stop": complete, "protein_preview": translate_seq(template[i:j])[:60]})
                        i = j + 3
                    else:
                        i += 3
    found.sort(key=lambda row: -row["length_aa"])
    return {"min_length_aa": min_aa, "start_codons": sorted(starts), "found": len(found), "orfs": found[:100], "truncated": len(found) > 100, "caveat": "an open reading frame is a candidate, not evidence of an expressed or functional gene; coordinates are 1-based on the input strand", "table": "standard genetic code (NCBI table 1)"}


def nn_tm(seq, primer_nm, na_mm):
    r = 1.987
    dh = ds = 0.0
    for i in range(len(seq) - 1):
        h, s = NN[seq[i:i + 2]]
        dh += h
        ds += s
    for end in (seq[0], seq[-1]):
        if end in "GC":
            dh += 0.1
            ds += -2.8
        else:
            dh += 2.3
            ds += 4.1
    self_comp = seq == revcomp(seq)
    if self_comp:
        ds += -1.4
    ds += 0.368 * (len(seq) - 1) * math.log(na_mm / 1000.0)
    ct = primer_nm * 1e-9
    divisor = 1 if self_comp else 4
    return dh * 1000 / (ds + r * math.log(ct / divisor)) - 273.15, self_comp


def action_primer_tm(request):
    primer_nm = float(request.get("primer_nm") or 250)
    na_mm = float(request.get("na_mm") or 50)
    if primer_nm <= 0 or na_mm <= 0:
        fail("primer_nm and na_mm must be positive")
    rows = []
    for name, seq in load(request):
        seq = seq.replace("U", "T")
        if set(seq) - set("ACGT"):
            rows.append({"name": name, "length": len(seq), "error": "Tm needs an unambiguous A/C/G/T primer"})
            continue
        if len(seq) < 8 or len(seq) > 60:
            rows.append({"name": name, "length": len(seq), "error": "primer length outside 8-60 nt; the nearest-neighbour model is not meant for this range"})
            continue
        tm, self_comp = nn_tm(seq, primer_nm, na_mm)
        gc = (seq.count("G") + seq.count("C")) / len(seq)
        rows.append({"name": name, "length": len(seq), "gc_percent": round(100 * gc, 1), "tm_c": round(tm, 1), "wallace_tm_c": 2 * (seq.count("A") + seq.count("T")) + 4 * (seq.count("G") + seq.count("C")), "self_complementary": self_comp, "three_prime_gc_clamp": seq[-1] in "GC"})
    return {"method": "SantaLucia 1998 nearest-neighbour with Na+ correction", "conditions": {"primer_nM": primer_nm, "Na_mM": na_mm}, "rows": rows, "caveat": "a calculated Tm for a two-state model; real melting depends on Mg2+, dNTPs, buffer, mismatches, and the polymerase. Verify before ordering"}


def blosum62():
    try:
        from Bio.Align import substitution_matrices

        return substitution_matrices.load("BLOSUM62")
    except Exception:  # noqa: BLE001
        return None


def action_align(request):
    records = load(request)
    other = request.get("sequence_b")
    if other:
        second = parse_records(str(other))
        if not second:
            fail("sequence_b contains no sequence")
        name_b = second[0][0] if str(other).lstrip().startswith(">") else "seq2"
        pair = [records[0], (name_b, second[0][1])]
    elif len(records) >= 2:
        pair = records[:2]
    else:
        fail("align needs two sequences: give sequence_b, or a FASTA with two records")
    (name_a, a), (name_b, b) = pair
    if len(a) > MAX_ALIGN or len(b) > MAX_ALIGN:
        fail(f"sequences longer than {MAX_ALIGN} residues are not aligned here (the dynamic-programming table would be too large)", "too_large")
    mode = request.get("mode") or "global"
    if mode not in ("global", "local"):
        fail("mode must be global or local")
    protein = kind_of(a) == "protein" or kind_of(b) == "protein"
    matrix = blosum62() if protein else None
    if protein:
        scoring = "BLOSUM62 (Biopython)" if matrix is not None else "identity fallback (+1 match, -1 mismatch): install biopython for BLOSUM62"
        gap = float(request.get("gap") if request.get("gap") is not None else (-8 if matrix is not None else -2))
        def score(x, y):
            if matrix is not None:
                try:
                    return float(matrix[x][y])
                except Exception:  # noqa: BLE001
                    return -4.0
            return 1.0 if x == y else -1.0
    else:
        match = float(request.get("match") if request.get("match") is not None else 2)
        mismatch = float(request.get("mismatch") if request.get("mismatch") is not None else -1)
        gap = float(request.get("gap") if request.get("gap") is not None else -2)
        scoring = f"match {match:g}, mismatch {mismatch:g}, linear gap {gap:g}"
        def score(x, y):
            return match if x == y else mismatch
    n, m = len(a), len(b)
    local = mode == "local"
    h = [[0.0] * (m + 1) for _ in range(n + 1)]
    ptr = [[0] * (m + 1) for _ in range(n + 1)]  # 1 diag, 2 up, 3 left, 0 stop
    if not local:
        for i in range(1, n + 1):
            h[i][0], ptr[i][0] = i * gap, 2
        for j in range(1, m + 1):
            h[0][j], ptr[0][j] = j * gap, 3
    best, best_pos = 0.0, (0, 0)
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            d = h[i - 1][j - 1] + score(a[i - 1], b[j - 1])
            u = h[i - 1][j] + gap
            l = h[i][j - 1] + gap
            top = max(d, u, l)
            if local and top <= 0:
                h[i][j], ptr[i][j] = 0.0, 0
                continue
            h[i][j] = top
            ptr[i][j] = 1 if top == d else (2 if top == u else 3)
            if local and top > best:
                best, best_pos = top, (i, j)
    i, j = best_pos if local else (n, m)
    end_i, end_j = i, j
    top_row, bot_row, mid = [], [], []
    while (i > 0 or j > 0) and not (local and ptr[i][j] == 0):
        step = ptr[i][j]
        if step == 1:
            top_row.append(a[i - 1]); bot_row.append(b[j - 1])
            mid.append("|" if a[i - 1] == b[j - 1] else ".")
            i -= 1; j -= 1
        elif step == 2:
            top_row.append(a[i - 1]); bot_row.append("-"); mid.append(" "); i -= 1
        elif step == 3:
            top_row.append("-"); bot_row.append(b[j - 1]); mid.append(" "); j -= 1
        else:
            break
    top_s, bot_s, mid_s = "".join(reversed(top_row)), "".join(reversed(bot_row)), "".join(reversed(mid))
    columns = len(top_s)
    identities = mid_s.count("|")
    return {
        "mode": mode, "scoring": scoring, "score": best if local else h[n][m],
        "a": {"name": name_a, "length": n, "aligned_from": i + 1 if columns else None, "aligned_to": end_i if columns else None},
        "b": {"name": name_b, "length": m, "aligned_from": j + 1 if columns else None, "aligned_to": end_j if columns else None},
        "alignment_columns": columns, "identities": identities,
        "percent_identity_of_columns": round(100 * identities / columns, 2) if columns else None,
        "gaps": top_s.count("-") + bot_s.count("-"),
        "alignment": {"a": top_s[:2000], "match": mid_s[:2000], "b": bot_s[:2000], "truncated": columns > 2000},
        "caveat": "a single optimal pairwise alignment under the stated scoring; it is not a homology test and carries no E-value. Use BLAST or HMMER for database searches",
    }


ACTIONS = {"stats": action_stats, "translate": action_translate, "orfs": action_orfs, "primer_tm": action_primer_tm, "align": action_align}


def main():
    try:
        request = json.load(sys.stdin)
    except Exception as exc:  # noqa: BLE001
        fail(f"invalid request JSON: {exc}")
    action = request.get("action")
    if action not in ACTIONS:
        fail(f"action must be one of {', '.join(ACTIONS)}")
    try:
        result = ACTIONS[action](request)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        fail(f"{action} failed: {exc}")
    emit({"action": action, **result, "tool_versions": {"python": sys.version.split()[0], "biopython": _bio_version()}})


def _bio_version():
    try:
        import Bio

        return Bio.__version__
    except Exception:  # noqa: BLE001
        return None


if __name__ == "__main__":
    main()
