# Interactive fish child with a temporary "workshop" function for this
# checkout. The launcher always runs the frozen-lockfile dependency check in
# the checkout first; see launch-workshop-cli.sh for details.
.PHONY: cli
cli:
	@./launch-workshop-cli.sh
