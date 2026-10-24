#!/usr/bin/env python3
"""Generate the paper's experiment tables from results/*.json."""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
RES = HERE / 'results'
TAB = HERE.parent / 'tables'

def j(name):
    return json.loads((RES / name).read_text())

def pct(x):
    return '--' if x is None else f'{100*x:.1f}\\%'

corpus = j('corpus.json')
defects = j('defects.json')
transfer = j('transfer.json')
classification = j('classification.json')
safety = j('safety.json')

# Corpus table
rows = []
for r in corpus:
    rows.append(
        f"{r['id']} & {r['type']} & {r['units']} & {r['citations']} & {r['bib_entries']} & "
        f"{r['findings']} & {r['blocking']} & {', '.join(r['families'])} \\\\"
    )
corpus_tex = r"""\begin{table}[t]
\centering
\scriptsize
\caption{Cold-start audit of nine real documents. All nine gates failed. \texttt{BIB-02} and \texttt{NUM-001} are expected in part because the migration overlay starts with an empty source registry and no bound facts; the table therefore measures the signal stream the RSI would see in a cold-start project, not final manuscript quality.}
\label{tab:corpus-experiments}
\begin{tabularx}{\linewidth}{@{}l l r r r r r >{\raggedright\arraybackslash}X@{}}
\toprule
Doc & Type & Units & Cites & Bib & Find. & Block. & Families \\
\midrule
""" + "\n".join(rows) + r"""
\midrule
Total & 3M+6P & 690 & 584 & 316 & 1158 & 122 & BIB/NUM/PRF (9); EVD (8); UNIT (5); LAT/STY (2) \\
\bottomrule
\end{tabularx}
\end{table}
"""
(TAB / 'corpus-results.tex').write_text(corpus_tex)

# Defect table
agg = {'missing_citation': [0, 0], 'missing_ref': [0, 0], 'duplicate_label': [0, 0], 'removed_anchor': [0, 0]}
for r in defects:
    for d in r.get('detected', []):
        agg[d['type']][0] += 1
        agg[d['type']][1] += int(bool(d['detected']))
labels = {
    'missing_citation': 'Missing citation key',
    'missing_ref': 'Missing ref target',
    'duplicate_label': 'Duplicate label',
    'removed_anchor': 'Removed unit anchor',
}
drows = []
for key in ['missing_citation', 'missing_ref', 'duplicate_label', 'removed_anchor']:
    p, d = agg[key]
    drows.append(f"{labels[key]} & {p} & {d} & {pct(d/p if p else None)} \\\\")
total_p = sum(v[0] for v in agg.values())
total_d = sum(v[1] for v in agg.values())
drows.append(f"\\midrule\nTotal & {total_p} & {total_d} & {pct(total_d/total_p)} \\\\")
defect_tex = r"""\begin{table}[t]
\centering
\small
\caption{Injected-defect detection across the nine real documents. A mutation is counted only when the project contains the relevant \LaTeX{} pattern. Detection compares the count of the expected check family before and after injection.}
\label{tab:defects}
\begin{tabular}{@{}lrrr@{}}
\toprule
Mutation & Possible & Detected & Rate \\
\midrule
""" + "\n".join(drows) + r"""
\bottomrule
\end{tabular}
\end{table}
"""
(TAB / 'defects.tex').write_text(defect_tex)

# Transfer table
trows = []
for r in transfer:
    held = f"{r['heldin_covered']}/{len(r['specific_families'])}"
    loo = '--' if r['loo_covered'] is None else f"{r['loo_covered']}/{len(r['specific_families'])}"
    trows.append(f"{r['id']} & {r['type']} & {len(r['specific_families'])} & {held} & {loo} & {r['injected_tokens']} & {r['generic_tokens']} \\\\")
man = [r for r in transfer if r['type'] == 'manuscript']
pro = [r for r in transfer if r['type'] == 'proposal']
def aggrow(name, rows):
    sf = sum(len(r['specific_families']) for r in rows)
    hi = sum(r['heldin_covered'] for r in rows)
    lo = sum(r['loo_covered'] or 0 for r in rows)
    tok = sum(r['injected_tokens'] for r in rows)
    gen = sum(r['generic_tokens'] for r in rows)
    return f"{name} & -- & {sf} & {hi}/{sf} & {lo}/{sf} & {tok} & {gen} \\\\"
trows.append('\\midrule')
trows.append(aggrow('Manuscripts', man))
trows.append(aggrow('Proposals', pro))
trows.append(aggrow('Total', transfer))
transfer_tex = r"""\begin{table}[t]
\centering
\scriptsize
\caption{Leave-one-project-out lesson coverage. \emph{Specific families} are check families with a specific remedy. \emph{Held-in} trains on the document itself; \emph{LOO} trains on the other documents of the same type. \emph{Tokens} is the injected lesson budget for the document; \emph{Generic} is a single generic finding lesson. Coverage is catalogue-level, not agent behavior.}
\label{tab:transfer}
\begin{tabular}{@{}l l r r r r r@{}}
\toprule
Doc & Type & Specific & Held-in & LOO & Tokens & Generic \\
\midrule
""" + "\n".join(trows) + r"""
\bottomrule
\end{tabular}
\end{table}
"""
(TAB / 'transfer.tex').write_text(transfer_tex)

# Routing table
rrows = []
for cls, m in classification['metrics']['per_class'].items():
    rrows.append(f"\\texttt{{{cls}}} & {m['support']} & {pct(m['precision'])} & {pct(m['recall'])} & {pct(m['f1'])} & -- \\\\")
rrows.append(f"\\midrule\nOverall & {classification['metrics']['n']} & -- & -- & -- & {pct(classification['metrics']['accuracy'])} \\\\")
routing_tex = r"""\begin{table}[t]
\centering
\footnotesize
\caption{Task routing on 30 hand-labeled research requests derived from the corpus. This is a descriptive routing test, not a natural task distribution. The Acc. column is shown only for the Overall row.}
\label{tab:routing}
\begin{tabular}{@{}lrrrrr@{}}
\toprule
Class & Support & Precision & Recall & F1 & Acc. \\
\midrule
""" + "\n".join(rrows) + r"""
\bottomrule
\end{tabular}
\end{table}
"""
(TAB / 'routing.tex').write_text(routing_tex)

# Safety table
def srow(name, m):
    return f"{name} & {m['n']} & {pct(m['precision'])} & {pct(m['recall'])} & {pct(m['f1'])} & {pct(m['accuracy'])} \\\\"
srows = [
    srow('Safety lint (dev)', safety['lint']['metrics']),
    srow('Safety lint (held-out)', safety['lint_heldout']['metrics']),
    srow('Preference (dev)', safety['preferences']['metrics']),
    srow('Preference (held-out)', safety['preference_heldout']['metrics']),
]
safety_tex = r"""\begin{table}[t]
\centering
\footnotesize
\caption{Safety and preference validation. The development set was used to find and fix two lint gaps; the held-out set was not used for tuning. The positive class is \emph{unsafe} for the lint and \emph{durable} for preferences.}
\label{tab:safety}
\begin{tabular}{@{}lrrrrr@{}}
\toprule
Evaluation & $n$ & Precision & Recall & F1 & Accuracy \\
\midrule
""" + "\n".join(srows) + r"""
\bottomrule
\end{tabular}
\end{table}
"""
(TAB / 'safety.tex').write_text(safety_tex)
print('tables written')
