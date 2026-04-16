#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$BASE_DIR/.env.gemini"
TEMPLATE_FILE="$BASE_DIR/sre_solutions_prompt.template.txt"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

if [[ ! -f "$TEMPLATE_FILE" ]]; then
  echo "Missing template file: $TEMPLATE_FILE" >&2
  exit 1
fi

if [[ $# -lt 1 ]]; then
  echo "Usage:" >&2
  echo "  ./run_sre_solutions.sh \"RCA text here\" [model]" >&2
  echo "  ./run_sre_solutions.sh --file /path/to/rca.txt [model]" >&2
  exit 1
fi

RCA_INPUT=""
MODEL="${2:-gemini-2.5-flash}"

if [[ "$1" == "--file" ]]; then
  if [[ $# -lt 2 ]]; then
    echo "Missing file path after --file" >&2
    exit 1
  fi
  RCA_FILE="$2"
  MODEL="${3:-gemini-2.5-flash}"
  if [[ ! -f "$RCA_FILE" ]]; then
    echo "RCA file not found: $RCA_FILE" >&2
    exit 1
  fi
  RCA_INPUT="$(cat "$RCA_FILE")"
else
  RCA_INPUT="$1"
fi

if [[ -z "$RCA_INPUT" ]]; then
  echo "RCA input is empty." >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

export BASE_DIR MODEL RCA_INPUT

python3 - <<'PY'
import json
import os
import sys
import time
import urllib.error
import urllib.request

base_dir = os.environ["BASE_DIR"]
model = os.environ.get("MODEL", "gemini-2.5-flash")
rca_input = os.environ.get("RCA_INPUT", "")
api_key = os.environ.get("API_KEY", "")

if not api_key:
    print("Missing API_KEY in cost/.env.gemini", file=sys.stderr)
    sys.exit(1)

template_path = os.path.join(base_dir, "sre_solutions_prompt.template.txt")
with open(template_path, "r", encoding="utf-8") as f:
    template = f.read()

prompt = template.replace("{INSERT_RCA_OR_PROBLEM_HERE}", rca_input)

candidate_models = [model, "gemini-2.5-flash", "gemini-2.5-pro", "gemini-pro"]
seen = set()
models = [m for m in candidate_models if not (m in seen or seen.add(m))]

payload = {
    "contents": [{"parts": [{"text": prompt}]}],
    "generationConfig": {
        "responseMimeType": "application/json",
        "temperature": 0.2,
    },
}

raw_text = None
last_error = None

for m in models:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent?key={api_key}"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            cands = data.get("candidates", [])
            if cands:
                parts = cands[0].get("content", {}).get("parts", [])
                raw_text = "".join(p.get("text", "") for p in parts if isinstance(p, dict)).strip()
            if raw_text:
                break
            last_error = (500, "Empty model response")
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="ignore")
            last_error = (e.code, body)
            if e.code == 404:
                break
            if e.code in (429, 500, 503) and attempt < 2:
                time.sleep(2 * (attempt + 1))
                continue
            break

    if raw_text:
        break

if not raw_text:
    code, body = last_error if last_error else ("unknown", "No response")
    print(f"Gemini API error ({code}): {body}", file=sys.stderr)
    sys.exit(1)

try:
    parsed = json.loads(raw_text)
except json.JSONDecodeError:
    print(raw_text)
    sys.exit(0)

if not isinstance(parsed, list):
    print(raw_text)
    sys.exit(0)

# Enforce exactly 3 solutions in output while preserving strict JSON.
if len(parsed) > 3:
    parsed = parsed[:3]
elif len(parsed) < 3:
    while len(parsed) < 3:
        parsed.append({
            "action": "",
            "what_it_does": "",
            "advantages": ["", ""],
            "tradeoffs": ["", ""],
            "infra_cost_impact": {"level": "Low", "reason": "Insufficient model output"},
            "llm_cost_impact": {"level": "Low", "effect": "Same", "reason": "Insufficient model output"},
        })

print(json.dumps(parsed, ensure_ascii=True, indent=2))
PY
