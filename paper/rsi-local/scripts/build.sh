#!/bin/sh
set -e
cd "$(dirname "$0")/.."
latexmk -pdf -interaction=nonstopmode main.tex
