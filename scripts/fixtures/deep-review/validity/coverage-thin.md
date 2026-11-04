# A Single Registered Number for a Queue-Routing Benchmark

## Abstract

A tuned queue-router is stated against the original implementation. The submitted variant
beats the reproduced reference on the registered number by 3.1%.

## Results

The benchmark registers one scalar, and the experiment reports only that column.

| Method | Accuracy |
|---|---|
| Reference | 0.7120 |
| Tuned router (ours) | 0.7341 |

## Discussion

The registered number is cleared in a single run on the single split the task ships.

<!--
  Narrative case transcribed from the ScientistTwo paper's AutoSOTA comparison
  (sections/4_experiment.tex and sections/appendix.tex): the tuner "operates in a distinct
  setting, i.e., modifying existing codebases to optimize a single scalar metric". The
  paper's wide-vs-thin figures-and-tables contrast is ScientistOne-vs-ScientistTwo
  (sections/4_experiment.tex), a self-report that includes the Appendix. Self-reported
  against each system's own reproduced reference. Shaped to carry one failure pattern; not
  a measured result grid.
-->
