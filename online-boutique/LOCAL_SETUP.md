# Online Boutique Local Setup

This folder was downloaded from:

- `GoogleCloudPlatform/anthos-service-mesh-packages`
- `samples/online-boutique`

## Prerequisites

- `kubectl` configured to your target cluster
- Cloud Service Mesh / Istio available in the cluster
- Optional: ingress gateway (`istio-ingressgateway` in `istio-system`)

## Quick deploy

From this folder:

```bash
chmod +x deploy.sh cleanup.sh
./deploy.sh
```

Optional flags:

```bash
./deploy.sh --managed-data-plane
./deploy.sh --with-gateway
./deploy.sh --managed-data-plane --with-gateway
```

## Access app

If you enabled gateway and have `istio-ingressgateway` in `istio-system`:

```bash
kubectl get service istio-ingressgateway -n istio-system
```

Open `http://EXTERNAL_IP/`.

If your gateway service/namespace is different, use your values:

```bash
kubectl get service <gateway_service_name> -n <gateway_namespace>
```

## Cleanup

```bash
./cleanup.sh
```
