# LightGBM RCA (Mock Data + Dynamic Root Cause)

This project now includes a LightGBM-based root-cause finder that can be trained on synthetic incident data and used dynamically at runtime.

## Files

- `ai_agents/lightgbm_rca.py`: trains and predicts root cause
- `ai_agents/models/lightgbm_rca_model.txt`: trained LightGBM model (generated)
- `ai_agents/models/lightgbm_rca_meta.json`: model metadata and validation metrics (generated)
- `ai_agents/models/mock_rca_samples.json`: generated mock incident samples (generated)

## Install dependency

```bash
pip install lightgbm
```

## Train with mock data

```bash
python3 ai_agents/lightgbm_rca.py --mode train --output-dir ai_agents/models --rows 12000
```

This creates model + metadata + sample mock records.

## Predict dynamically

The script expects JSON on stdin:

```json
{
  "pods": [
    { "name": "api-server", "status": "CrashLoopBackOff", "cpu": 1.2, "memory": 980000000, "restart_count": 4 }
  ],
  "dependency_map": {
    "api-server": ["cache-redis", "database-primary"],
    "web-frontend": ["api-server"]
  }
}
```

Run:

```bash
cat payload.json | python3 ai_agents/lightgbm_rca.py --mode predict --model-dir ai_agents/models
```

Response contains:

- `rootCauses`: top predicted root cause
- `rankedRootCauses`: scored candidates
- `affectedPods`: dynamically traversed cascading impact
- `remediations`: next actions
- `modelInfo`: feature list and validation metrics
