# Minikube -> ngrok -> h24 App Runbook

This guide covers the full local flow:

1. Start Minikube
2. Verify Kubernetes pods are running
3. Start the local Kubernetes observability API (`app.py`)
4. Get the ngrok public link
5. Run the h24 Next.js app
6. Connect the ngrok URL inside the h24 UI

---

## Prerequisites

- Windows PowerShell
- Minikube installed
- kubectl installed and connected to Minikube
- Python 3 installed
- Node.js and npm installed
- ngrok installed and authenticated (`ngrok config add-authtoken ...`)

---

## 1) Start Minikube

From the repo root:

```powershell
cd d:\k8s-self-healing
minikube start
```

Optional (same action via VS Code task):

- Run task: `start-minikube`

Verify cluster status:

```powershell
kubectl cluster-info
kubectl get nodes
```

---

## 2) Verify Running Pods

```powershell
kubectl get pods -A
```

Optional task:

- Run task: `list-running-pods`

You should see pods in `Running` or `Completed` states.

---

## 3) Start Local Observability API + ngrok Tunnel

From repo root:

```powershell
cd d:\k8s-self-healing
.\start-all.ps1
```

What this script does:

- Starts Flask app (`app.py`) on port `5000` if not already running
- Starts ngrok tunnel to port `5000`
- Prints local and ngrok endpoints

Expected local endpoints:

- `http://127.0.0.1:5000/health`
- `http://127.0.0.1:5000/pods`

---

## 4) Get the ngrok Public URL

### Option A: From script output

After running `start-all.ps1`, check for lines like:

- `Ngrok health: https://<your-subdomain>.ngrok-free.app/health`
- `Ngrok data:   https://<your-subdomain>.ngrok-free.app/pods`

Use the base URL (`https://<your-subdomain>.ngrok-free.app`) or direct pods URL.

### Option B: From ngrok local API

```powershell
Invoke-RestMethod http://127.0.0.1:4040/api/tunnels | Select-Object -ExpandProperty tunnels | Select-Object -ExpandProperty public_url
```

### Option C: From ngrok dashboard

Open:

- `http://127.0.0.1:4040`

---

## 5) Run h24 App

Open a new PowerShell terminal:

```powershell
cd d:\k8s-self-healing\h24-app
npm install
npm run dev
```

App URL:

- `http://localhost:3000`

Alternative launcher from repo root:

```powershell
cd d:\k8s-self-healing
.\start-healing-site.ps1
```

---

## 6) Configure ngrok URL in h24

The h24 app expects a valid HTTPS ngrok URL.

Use one of these approaches:

### Approach A: Dashboard Setup page (recommended)

1. Open `http://localhost:3000/dashboard/setup`
2. Add endpoint name (example: `local-minikube`)
3. Paste ngrok URL (example: `https://<subdomain>.ngrok-free.app/pods`)
4. Save and open dashboard

### Approach B: Healing page field

1. Open `http://localhost:3000/dashboard/healing`
2. In "Ngrok metrics URL", paste:
   - `https://<subdomain>.ngrok-free.app/pods`
3. Start analysis/healing flow

---

## 7) Quick End-to-End Validation

1. Check local API:

```powershell
curl http://127.0.0.1:5000/health
```

2. Check ngrok `/pods`:

```powershell
curl https://<subdomain>.ngrok-free.app/pods
```

3. Open h24 dashboard and confirm pods load from the configured endpoint.

---

## Common Commands (Copy/Paste)

```powershell
# Terminal 1: cluster
cd d:\k8s-self-healing
minikube start
kubectl get pods -A

# Terminal 2: flask + ngrok
cd d:\k8s-self-healing
.\start-all.ps1

# Terminal 3: h24 app
cd d:\k8s-self-healing\h24-app
npm install
npm run dev
```

---

## Troubleshooting

### Minikube not starting

```powershell
minikube status
minikube delete
minikube start
```

### kubectl cannot connect

```powershell
kubectl config current-context
minikube update-context
kubectl get nodes
```

### ngrok URL not showing

- Confirm ngrok is installed and authenticated
- Open `http://127.0.0.1:4040`
- Restart script: `.\start-all.ps1`

### h24 app fails to start

```powershell
cd d:\k8s-self-healing\h24-app
npm install
npm run dev
```

### h24 says endpoint invalid

- Use an HTTPS ngrok URL
- Use ngrok domains like `.ngrok-free.app`, `.ngrok-free.dev`, `.ngrok.app`, or `.ngrok.io`
- Try URL with `/pods` suffix for pod list endpoints

---

## Stop Everything

In each running terminal press `Ctrl+C`.

Then optionally:

```powershell
minikube stop
```
