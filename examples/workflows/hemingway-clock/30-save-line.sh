#!/bin/sh
set -eu
: "${WORKSHOP_DATA_DIR:?WORKSHOP_DATA_DIR is required}"
result=$(cat)
printf '%s\n' "$result" >> "$WORKSHOP_DATA_DIR/results.md"
