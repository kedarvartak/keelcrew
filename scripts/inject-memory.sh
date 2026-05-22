#!/usr/bin/env bash
# Reads the last 30 messages from AGENTS.md and prints them to stdout.
# Claude Code's UserPromptSubmit hook injects stdout into the prompt context
# automatically — so this file is seen before every message, no agent action needed.

REPO_PATH="${CLAUDE_PROJECT_DIR:-$(pwd)}"
AGENTS_FILE="$REPO_PATH/AGENTS.md"

if [ ! -f "$AGENTS_FILE" ]; then
  exit 0
fi

# Extract last 30 **speaker** lines
CONTEXT=$(grep -E '^\*\*[^*]+\*\* — ' "$AGENTS_FILE" | tail -30)

if [ -z "$CONTEXT" ]; then
  exit 0
fi

cat <<EOF
<agent_memory>
The following is the shared memory log from AGENTS.md — recent messages from all agents working on this project. Use this to avoid repeating decisions and to stay consistent with prior work.

$CONTEXT
</agent_memory>
EOF
