#!/usr/bin/env zsh
set -euo pipefail

workspace_root="/Users/vishruth/Projects/HTF4.0"
env_file="$workspace_root/.vscode/mcp.env"

if [[ -f "$env_file" ]]; then
  set -a
  source "$env_file"
  set +a
fi

server_name="${1:-}"

case "$server_name" in
  topology) exec npm --prefix "$workspace_root/src/mcp-servers" run start:topology ;;
  prometheus) exec npm --prefix "$workspace_root/src/mcp-servers" run start:prometheus ;;
  git) exec npm --prefix "$workspace_root/src/mcp-servers" run start:git ;;
  memory) exec npm --prefix "$workspace_root/src/mcp-servers" run start:memory ;;
  policy) exec npm --prefix "$workspace_root/src/mcp-servers" run start:policy ;;
  filesystem) exec npm --prefix "$workspace_root/src/mcp-servers" run start:filesystem ;;
  all)
    zsh "$0" topology &
    zsh "$0" prometheus &
    zsh "$0" git &
    zsh "$0" memory &
    zsh "$0" policy &
    zsh "$0" filesystem &
    wait
    ;;
  *)
    echo "Usage: $0 {topology|prometheus|git|memory|policy|filesystem|all}" >&2
    exit 1
    ;;
esac