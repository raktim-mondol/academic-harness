# A Controlled Study of Warm-Start Solvers

## Abstract

We compare a warm-start solver against a cold-start reference across three datasets.
The warm-start variant reduces latency by 16.7% while constraint violation and accuracy
are reported beside it in the same table.

## Ablation

The w/o warm-start arm and the w/o caching arm remove each mechanism in turn, so the gain
is attributed to the proposed warm start rather than to the shared training recipe.

## Results

| Method | Accuracy | Latency | Violation | Data A | Data B | Data C |
|---|---|---|---|---|---|---|
| Baseline | 0.812 | 120 | 0.031 | 0.80 | 0.81 | 0.82 |
| Reference | 0.824 | 118 | 0.030 | 0.82 | 0.82 | 0.83 |
| w/o warm-start | 0.815 | 121 | 0.032 | 0.81 | 0.81 | 0.82 |
| w/o caching | 0.829 | 112 | 0.030 | 0.83 | 0.83 | 0.83 |
| Warm start (ours) | 0.841 | 100 | 0.029 | 0.84 | 0.84 | 0.85 |

Accuracy, latency, and constraint violation are all reported for every arm.
