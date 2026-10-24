.PHONY: all clean view

all:
	latexmk -pdf -interaction=nonstopmode main.tex

view: all
	@command -v xdg-open >/dev/null && xdg-open main.pdf || echo "open main.pdf"

clean:
	latexmk -C
	rm -f main.bbl main.blg
