#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TB_DIR="${TB_DIR:-/tmp/terminal-bench}"
OUTPUT_DIR="${OUTPUT_DIR:-/tmp/piecode-tb-runs}"
RUN_ID="${RUN_ID:-piecode-tb-$(date +%Y%m%d-%H%M%S)}"
PIECODE_SETTINGS_PATH="${PIECODE_SETTINGS_PATH:-$HOME/.piecode/settings.json}"
PIECODE_HOST_PATH="${PIECODE_HOST_PATH:-$REPO_DIR}"

if ! command -v uv >/dev/null 2>&1; then
  echo "error: uv is required" >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker is required" >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "error: git is required" >&2
  exit 1
fi
if [ ! -f "$PIECODE_SETTINGS_PATH" ]; then
  echo "error: settings file not found: $PIECODE_SETTINGS_PATH" >&2
  exit 1
fi

if [ ! -d "$TB_DIR/.git" ]; then
  git clone --depth 1 https://github.com/laude-institute/terminal-bench.git "$TB_DIR"
fi

has_task_id=0
effective_run_id="$RUN_ID"
for arg in "$@"; do
  if [ "$arg" = "--task-id" ] || [ "$arg" = "-t" ]; then
    has_task_id=1
  fi
done

for ((i = 1; i <= $#; i++)); do
  current="${!i}"
  if [ "$current" = "--run-id" ]; then
    next_index=$((i + 1))
    if [ "$next_index" -le "$#" ]; then
      effective_run_id="${!next_index}"
    fi
  fi
done

tb_args=(
  --agent-import-path piecode_tb_agent:PieCodeTBenchAgent
  --agent-kwarg "piecode_host_path=$PIECODE_HOST_PATH"
  --agent-kwarg "piecode_settings_path=$PIECODE_SETTINGS_PATH"
  --dataset-path "$TB_DIR/original-tasks"
  --output-path "$OUTPUT_DIR"
  --run-id "$RUN_ID"
  --no-upload-results
  --n-concurrent 1
  --n-attempts 1
  --log-level info
)

if [ "$has_task_id" -eq 0 ]; then
  tb_args+=(--task-id hello-world)
fi
tb_args+=("$@")

(
  cd "$TB_DIR"
  export PYTHONPATH="$REPO_DIR/scripts/terminal_bench:$TB_DIR${PYTHONPATH:+:$PYTHONPATH}"
  uv run tb run "${tb_args[@]}"
)

echo "results: $OUTPUT_DIR/$effective_run_id/results.json"
