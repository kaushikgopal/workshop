#!/bin/sh
set -eu
: "${WORKSHOP_DATA_DIR:?WORKSHOP_DATA_DIR is required}"
: "${WORKSHOP_AGENT_RESULT:?WORKSHOP_AGENT_RESULT is required}"
printf '%s\n' "$WORKSHOP_AGENT_RESULT" >> "$WORKSHOP_DATA_DIR/results.md"
