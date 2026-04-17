#!/usr/bin/env bash
set -euo pipefail

USERS="${1:-80}"
TARGET_NAMESPACE="${2:-frontend}"
TARGET_LABEL="${3:-app=frontend}"

echo "[1/4] Increasing loadgenerator USERS=${USERS}"
kubectl set env deployment/loadgenerator -n loadgenerator "USERS=${USERS}" >/dev/null
kubectl rollout restart deployment/loadgenerator -n loadgenerator >/dev/null
kubectl rollout status deployment/loadgenerator -n loadgenerator --timeout=90s

echo "[2/4] Selecting a target pod from namespace=${TARGET_NAMESPACE} label=${TARGET_LABEL}"
TARGET_POD="$(kubectl get pod -n "${TARGET_NAMESPACE}" -l "${TARGET_LABEL}" -o jsonpath='{.items[0].metadata.name}')"
if [[ -z "${TARGET_POD}" ]]; then
  echo "No pod found for namespace=${TARGET_NAMESPACE} label=${TARGET_LABEL}" >&2
  exit 1
fi

echo "[3/4] Failing pod ${TARGET_NAMESPACE}/${TARGET_POD}"
kubectl delete pod "${TARGET_POD}" -n "${TARGET_NAMESPACE}" --grace-period=0 --force >/dev/null

echo "[4/4] Waiting for replacement pod"
kubectl get pods -n "${TARGET_NAMESPACE}" -l "${TARGET_LABEL}" -o wide

echo ""
echo "Demo trigger complete."
echo "Next: open /dashboard, click Start Healing, choose dynamic LLM option with cost, then execute."
