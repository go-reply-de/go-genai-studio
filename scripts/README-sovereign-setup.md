# Sovereign inference setup (`automate_sovereign_setup.sh`)

Stages open-weight model artefacts and inference images **into a customer project**,
then deploys vLLM (generation) and TEI (embeddings) onto that environment's existing
GKE Autopilot cluster. After it runs, no inference or embedding traffic leaves the
project.

It is **idempotent** — safe and cheap to re-run. Re-running skips work already done
rather than repeating it.

---

## Division of labour

| Owner | Manages |
|---|---|
| **Terraform** (`terraform/modules/model_weights`) | The weights bucket: CMEK, public-access-prevention, soft-delete policy, reader/writer IAM |
| **Terraform** (`terraform/modules/cloudbuild`) | The Artifact Registry repo, the Cloud Build trigger and all its substitutions |
| **This script** | Putting *contents* into that bucket and registry, and applying the three inference manifests |
| **Cloud Build** (on push to `main`) | The `env` ConfigMap and the app deployment; re-applies the inference manifests when `_ENABLE_SOVEREIGN_INFERENCE=true` |

The script **never creates the bucket or the registry**. If they are missing it exits
with the `terragrunt apply` command to run. Two owners of one resource is how a
reviewed CMEK setting quietly becomes an unreviewed one.

---

## Prerequisites

```bash
# 1. Enable the feature for the environment, then create the bucket + IAM
#    environments/uksh/<env>/terragrunt.hcl:  enable_sovereign_inference = true
cd environments/uksh/<env> && terragrunt apply
```

You need `roles/iam.serviceAccountUser` on the environment's build SA — the script
grants this to the invoking account itself, since it depends on *who runs it* rather
than on the environment.

No Hugging Face token is needed. Gemma 4 is Apache-2.0 and its repos are **not
gated** (verified against the HF API: `gated=false`). A token is used only if the
`HF_TOKEN` secret happens to exist, for other gated models.

---

## Usage

### First environment (dev): weights from Google's Model Garden

```bash
./scripts/automate_sovereign_setup.sh \
  --project-id uksh-aw1-dev-genai-portal \
  --environment sov-dev \
  --cmek-key projects/cmek-.../cryptoKeys/genai-portal-sov-dev
```

### Promoting to prod: weights from the environment you validated

```bash
./scripts/automate_sovereign_setup.sh \
  --project-id uksh-aw1-prod-genai-portal \
  --environment sov-prod \
  --promote-from sov-dev \
  --weights-source-project uksh-aw1-dev-genai-portal \
  --cmek-key projects/cmek-.../cryptoKeys/genai-portal-sov-prod
```

Promotion is not a special code path — it is the same GCS-to-GCS copy from a
different prefix, one that happens to be in `europe-west3` rather than the US:

```
Model Garden : gs://vertex-model-garden-public-us/gemma4/<model>   (US, measured ~12 MB/s)
promotion    : gs://genai-portal-sov-dev-model-weights/<model>     (in-region, far faster)
```

### Measured ingest throughput — pick the source on evidence

| Source | Size | Time | Throughput |
|---|---|---|---|
| Model Garden (US) -> europe-west3 | 58.3 GB | **80 min** | 12 MB/s |
| dev -> prod (in-region GCS) | 58.3 GB | 13m28s | 74 MB/s |
| **Hugging Face (`--weight-source hf`)** | 48.1 GB | **3m28s** | **236 MB/s** |

Hugging Face is roughly **20x faster than Model Garden and 3x faster than in-region
GCS-to-GCS**, which is the opposite of what you would expect. The reason is object
layout: these checkpoints are a single ~46 GB safetensors shard, and
`gcloud storage cp` parallelises *across objects*, so one giant file gives it nothing
to parallelise. `hf_transfer` chunks *within* a file.

So: use `--weight-source hf` when you want speed. Use `--promote-from` when you want
**provenance** - prod then runs the exact bytes another environment was validated
against, verified by a post-copy byte comparison and recorded in
`<model>.manifest.txt` alongside `source=`. Use Model Garden when you want Google as
the supply chain and can wait.

Those are three different reasons; none of them dominates.

The cross-project read grant is **staging-time only**. Weights land in prod's own
CMEK bucket, so prod never depends on dev at runtime.

### Do not share one bucket between environments

Each environment gets its own copy (~58 GB, ~$1.40/month). A GCS bucket has one
default KMS key, and the environments use **different CMEK keys** — a shared bucket
would encrypt prod's weights under dev's key. It would also let a dev experiment change
what prod loads on its next restart.

---

## What each step does, and when it is skipped

| Step | Action | Skipped when |
|---|---|---|
| Preflight | Verifies the accelerator exists in the region, reports quota vs peak need | never |
| 1 | Verifies the weights bucket and AR repo exist; prints the bucket's CMEK key | never (fatal if missing) |
| 2 | Grants `monitoring.viewer` (KEDA→Managed Prometheus) and `serviceAccountUser` on the build SA | never (idempotent) |
| 3 | Mirrors vLLM + TEI images into Artifact Registry | **auto-skips** when both pinned tags already resolve, or `--skip-images` |
| 4 | Stages the generation model | **auto-skips** when destination bytes equal source, or `--skip-weights` |
| 5 | Stages the embedding model | same |
| 6 | Installs KEDA via Helm, annotates its SA for Workload Identity | skips when the `scaledobjects.keda.sh` CRD exists |
| 7 | Patches inference keys into the `env` ConfigMap, applies the three manifests | never (declarative) |

### The idempotency check compares bytes, not existence

Presence is not completeness. An interrupted copy leaves a prefix holding a
**truncated checkpoint** — which happened here: a permissions failure left 11.92 GB of
a 58.3 GB model in place. An existence check would have called that done and handed
vLLM a half-written model. So the check compares total bytes and distinguishes:

```
[ok]  ... already complete (58 GB matches source) - skipping.
WARN: ... is PARTIAL (12 GB of 58 GB) - re-copying.
[info] ... absent - will copy 58 GB.
```

---

## Environment-specific behaviour

Derived from `--environment`, so **always pass it**:

| | sov-dev | sov-prod |
|---|---|---|
| Namespace | `genai-portal-sov-dev` | `genai-portal-sov-prod` |
| Weights bucket | `genai-portal-sov-dev-model-weights` | `genai-portal-sov-prod-model-weights` |
| Replicas (min/max) | 1 / 2 | 2 / 6 |

`environments/uksh/<env>/terragrunt.hcl` is the source of truth for sizing. The
script's internal table applies only when it renders manifests directly, and must be
kept in step with it.

---

## Hard-won constraints in these projects

Each of these cost a failed apply. They are org-policy and Autopilot interactions that
do not show up in a local validation.

**Local SSD is impossible.** `constraints/gcp.restrictNonCmekServices` forbids scratch
disks, and Local SSD is a scratch disk:

```
Constraint constraints/gcp.restrictNonCmekServices violated ... attempting to
create an instance with scratch disks. Scratch disks are not supported for CMEK.
```

GKE retried in both L4 zones and failed identically. The GCS FUSE cache therefore
lives on the CMEK-encrypted boot disk, which is slower.

**This blocks H100 and A100-80GB entirely.** Those families *always* attach Local SSD
with no opt-out, so they cannot be provisioned here without an org-policy exception.
Any H100 migration plan needs that exception first — it is a governance conversation,
not a quota request.

**Builds must run as the environment's build SA.** `gcloud builds submit` without
`--service-account` silently falls back to the Cloud Build default compute SA, which
has no grant on the weights bucket → 403 on `storage.objects.create`.

**`gcloud artifacts docker images describe` does not work here.** It calls
`containeranalysis.googleapis.com`, which `gcp.restrictServiceUsage` blocks. Use
`gcloud artifacts docker tags list` for existence checks.

**Autopilot ephemeral-storage caps.** Non-GPU pods are capped at **10 GiB** total
(TEI is sized to 5 GiB + a 3 GiB sidecar). GPU pods get more but their CPU/memory is
capped per accelerator *and* GPU count, non-monotonically: 1× L4 allows 31 vCPU /
115 GiB, but **2× L4 allows only 23 vCPU / 83 GiB**. Those values are derived in
`terraform/locals.tf`, not set by hand.

**Quota is not capacity.** With `NVIDIA_L4_GPUS = 32` granted, on-demand L4 in
europe-west3 still returned `GCE out of resources` for over an hour. The only thing
that makes capacity dependable is a **committed reservation** — request one per zone,
sized to `min_replicas`, before go-live.

Spot was used during bring-up because it draws a separate capacity pool and was
available when on-demand was not. It has since been **removed entirely** from the
Terraform, the manifests and this script: a reclaim at ~30 s notice takes out the only
GPU replica and recovery re-pays a multi-minute cold weight load, which is the wrong
trade even in dev. Do not reintroduce it as an availability strategy.

---

## Verifying

```bash
./scripts/test_sovereign_inference.sh genai-portal-sov-dev gemma-4-31B-it bge-m3
```

Checks four things, and the third is the one people forget:

1. `/v1/models` advertises the served model name
2. A German clinical prompt returns fluent German
3. **Tool calling returns a `tool_calls` array, not prose.** The prod `librechat.yaml`
   drives every model spec through `endpoint: "agents"` with tools/actions/chain, so
   without `--tool-call-parser=gemma4` the agents look broken to clinicians
4. The embedding dimension is **1024** for bge-m3 — `text-embedding-004` was 768, so a
   mismatch means the vector store was never migrated and retrieval silently returns
   nothing

First pod start is slow: a cold 58 GB read over GCS FUSE onto a boot disk. The
`startupProbe` allows 20 minutes; a long `PodInitializing` is expected, not a hang.

---

## Not done by this script

The application still calls Vertex AI. Three things remain:

- `k8s/env.yaml` still has `EMBEDDINGS_PROVIDER=vertexai` — flip to `openai` with
  `RAG_OPENAI_BASEURL=http://tei-embeddings-service:8000/v1`
- `librechat.yaml` needs a `custom` endpoint and `agents.allowedProviders` extended
  beyond `["google"]`
- The three production model specs pin hardcoded `agent_id`s whose Mongo records store
  a provider and model. With `modelSpecs.enforce: true`, a mismatch leaves users with
  no selectable model at all

Switching embeddings also forces a **full re-embed**: bge-m3 is 1024-dimensional where
`text-embedding-004` was 768.
