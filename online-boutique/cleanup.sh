#!/usr/bin/env bash
set -euo pipefail

# Cleanup Online Boutique sample resources.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Deleting service entries..."
kubectl delete -f "$ROOT_DIR/istio-manifests/allow-egress-googleapis.yaml" --ignore-not-found

echo "Deleting optional frontend gateway/virtualservice (if present)..."
kubectl delete -f "$ROOT_DIR/istio-manifests/frontend-gateway.yaml" --ignore-not-found

echo "Deleting application namespaces..."
kubectl delete -f "$ROOT_DIR/kubernetes-manifests/namespaces" --ignore-not-found

echo "Cleanup complete."
