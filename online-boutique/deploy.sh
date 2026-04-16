#!/usr/bin/env bash
set -euo pipefail

# Deploy Online Boutique manifests and configure namespace sidecar injection.
# Usage:
#   ./deploy.sh
#   ./deploy.sh --managed-data-plane
#   ./deploy.sh --with-gateway

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANAGED_DATA_PLANE=false
WITH_GATEWAY=false

for arg in "$@"; do
  case "$arg" in
    --managed-data-plane)
      MANAGED_DATA_PLANE=true
      ;;
    --with-gateway)
      WITH_GATEWAY=true
      ;;
    *)
      echo "Unknown flag: $arg"
      echo "Valid flags: --managed-data-plane --with-gateway"
      exit 1
      ;;
  esac
done

NAMESPACES=(
  ad cart checkout currency email frontend loadgenerator
  payment product-catalog recommendation shipping
)

echo "[1/6] Creating namespaces..."
kubectl apply -f "$ROOT_DIR/kubernetes-manifests/namespaces"

echo "[2/6] Deploying workloads (service accounts + deployments)..."
kubectl apply -f "$ROOT_DIR/kubernetes-manifests/deployments"

echo "[3/6] Creating services..."
kubectl apply -f "$ROOT_DIR/kubernetes-manifests/services"

echo "[4/6] Creating egress service entries..."
kubectl apply -f "$ROOT_DIR/istio-manifests/allow-egress-googleapis.yaml"

echo "[5/6] Enabling sidecar auto-injection labels..."
for ns in "${NAMESPACES[@]}"; do
  kubectl label namespace "$ns" istio-injection=enabled --overwrite

done

if [[ "$MANAGED_DATA_PLANE" == "true" ]]; then
  echo "[5b/6] Annotating namespaces for managed Cloud Service Mesh data plane..."
  for ns in "${NAMESPACES[@]}"; do
    kubectl annotate --overwrite namespace "$ns" mesh.cloud.google.com/proxy='{"managed":"true"}'
  done
fi

echo "[6/6] Restarting deployments to pick up sidecars..."
for ns in "${NAMESPACES[@]}"; do
  kubectl rollout restart deployment -n "$ns"

done

if [[ "$WITH_GATEWAY" == "true" ]]; then
  echo "Applying frontend gateway/virtualservice..."
  kubectl apply -f "$ROOT_DIR/istio-manifests/frontend-gateway.yaml"
fi

echo
echo "Deployment complete."
echo "Tips:"
echo "- Check pods: kubectl get pods -A | grep -E 'ad|cart|checkout|currency|email|frontend|loadgenerator|payment|product|recommendation|shipping'"
echo "- If using ingress gateway: kubectl get service istio-ingressgateway -n istio-system"
