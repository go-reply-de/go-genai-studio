#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Master Sovereign AI Automation Script
# Universal provisioning & deployment for any Sovereign Cloud environment
#
# Stages open-weight model artefacts and inference images into the customer's
# own project, then deploys vLLM (generation) and TEI (embeddings) onto the
# existing GKE Autopilot cluster. After this runs, no inference or embedding
# traffic leaves the project.
#
# NOTE ON REGIONAL REALITY (europe-west3, verified against the live projects):
#   - nvidia-l4        -> zones -a, -b     quota NVIDIA_L4_GPUS = 32 (granted)
#   - nvidia-h100-80gb -> zone  -c  only   no quota granted yet, must be requested
#   - A100             -> NOT OFFERED in europe-west3 at all
# So L4 is the only accelerator you can actually schedule today. The profiles
# below are sized for that, with H100 profiles ready for when quota lands.
# ==============================================================================

# Default configurations with environment fallbacks
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || echo "")}"
REGION="${REGION:-europe-west3}"
ENVIRONMENT="${ENVIRONMENT:-sov-dev}"
GKE_CLUSTER="${GKE_CLUSTER:-}"
# Deliberately NOT defaulted here. Anything derived from ENVIRONMENT must be
# resolved AFTER argument parsing - see the "Derived values" block below.
# Defaulting at declaration time meant `--environment sov-prod` still produced
# sov-dev's namespace and bucket, which would have written prod weights into
# dev's bucket and deployed prod manifests into dev's namespace.
GKE_NAMESPACE="${GKE_NAMESPACE:-}"
REGISTRY_NAME="${REGISTRY_NAME:-}"
CMEK_KEY="${CMEK_KEY:-}"
# Must match terraform/modules/model_weights, whose name is built in
# terraform/locals.tf as "<application>-<environment>-model-weights". If these
# two ever disagree, the pods mount an empty bucket and vLLM fails to find the
# weights this script just staged somewhere else.
MODELS_BUCKET="${MODELS_BUCKET:-}"
HF_TOKEN="${HF_TOKEN:-}"

# --- Model selection -----------------------------------------------------------
# GEMMA_MODEL is a real Hugging Face repo id. "gemma-4" (the previous default)
# is not a model and would have made vLLM exit immediately with a missing-path
# error, since --model pointed at /models/gemma-4 which nothing ever created.
GEMMA_MODEL="${GEMMA_MODEL:-google/gemma-4-31B-it}"
EMBEDDING_MODEL="${EMBEDDING_MODEL:-BAAI/bge-m3}"

# Where the generation weights come from.
#   modelgarden (default) - Google's public Model Garden bucket. A GCS-to-GCS
#                           copy, so no third-party account, no token, and the
#                           provenance is Google rather than a third-party CDN,
#                           which is the easier answer at a hospital security
#                           review. Only E2B/E4B/26B-A4B/31B are published there
#                           (no 12B), and only in the -us bucket.
#   hf                    - Hugging Face. Needed for anything Model Garden does
#                           not carry. Gemma 4 repos are Apache-2.0 and NOT
#                           gated, so this needs no token either; a token is
#                           only used if one happens to exist.
WEIGHT_SOURCE="${WEIGHT_SOURCE:-modelgarden}"

# Parent GCS prefix that CONTAINS the model directories. Both supported layouts
# are just a prefix + "/<model-dir>":
#   Model Garden : gs://vertex-model-garden-public-us/gemma4/gemma-4-31B-it
#   another env  : gs://genai-portal-sov-dev-model-weights/gemma-4-31B-it
# so promoting dev -> prod needs no new code path, only a different prefix.
MODEL_GARDEN_BUCKET="${MODEL_GARDEN_BUCKET:-gs://vertex-model-garden-public-us/gemma4}"
WEIGHTS_SOURCE_URI="${WEIGHTS_SOURCE_URI:-}"

# Project owning WEIGHTS_SOURCE_URI, when it is a bucket in a DIFFERENT project
# (the dev->prod promotion case). Used to grant this environment's build SA read
# access on it. Staging-time only - it creates no runtime dependency, because the
# weights are copied into this project's own CMEK bucket.
WEIGHTS_SOURCE_PROJECT="${WEIGHTS_SOURCE_PROJECT:-}"
ACCELERATOR_TYPE="${ACCELERATOR_TYPE:-nvidia-l4}"

# Pinned image versions. ":latest" on an inference engine means a pod restart can
# silently change model behaviour - unacceptable in a clinical system, and a
# change-control finding waiting to happen.
# Gemma 4 support landed after the last stable vLLM tag, so this must be a build
# that carries the gemma4 reasoning/tool-call parsers. Verify with:
#   docker run --rm --entrypoint python IMAGE -c \
#     "import vllm; print(vllm.__version__)"
VLLM_IMAGE="${VLLM_IMAGE:-vllm/vllm-openai:nightly}"
TEI_IMAGE="${TEI_IMAGE:-ghcr.io/huggingface/text-embeddings-inference:cpu-1.8}"
VLLM_IMAGE_TAG="${VLLM_IMAGE_TAG:-gemma4}"
TEI_IMAGE_TAG="${TEI_IMAGE_TAG:-cpu-1.8}"

# Parse CLI arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --project-id) PROJECT_ID="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --environment) ENVIRONMENT="$2"; shift 2 ;;
    --gke-cluster) GKE_CLUSTER="$2"; shift 2 ;;
    --gke-namespace) GKE_NAMESPACE="$2"; shift 2 ;;
    --registry-name) REGISTRY_NAME="$2"; shift 2 ;;
    --cmek-key) CMEK_KEY="$2"; shift 2 ;;
    --models-bucket) MODELS_BUCKET="$2"; shift 2 ;;
    --gemma-model) GEMMA_MODEL="$2"; shift 2 ;;
    # These three were read as variables but had no flag, so passing them was
    # impossible without exporting env vars.
    --embedding-model) EMBEDDING_MODEL="$2"; shift 2 ;;
    --accelerator-type) ACCELERATOR_TYPE="$2"; shift 2 ;;
    --vllm-image) VLLM_IMAGE="$2"; shift 2 ;;
    --weight-source) WEIGHT_SOURCE="$2"; shift 2 ;;
    --weights-source-uri) WEIGHTS_SOURCE_URI="$2"; WEIGHT_SOURCE=gcs; shift 2 ;;
    --weights-source-project) WEIGHTS_SOURCE_PROJECT="$2"; shift 2 ;;
    # Convenience for the common case: take the exact bytes another environment
    # already validated, from a bucket in the same region.
    --promote-from)
      WEIGHTS_SOURCE_URI="gs://genai-portal-$2-model-weights"
      WEIGHT_SOURCE=gcs
      shift 2 ;;
    --hf-token) HF_TOKEN="$2"; shift 2 ;;
    --skip-images) SKIP_IMAGES=1; shift ;;
    --skip-weights) SKIP_WEIGHTS=1; shift ;;
    --stage-only) shift ;;   # now the default - accepted for compatibility
    -h|--help)
      cat <<'USAGE'
Usage: automate_sovereign_setup.sh [options]
Options:
  --project-id        GCP Project ID
  --region            GCP Region (default: europe-west3)
  --environment       Environment name (e.g. sov-dev, sov-prod)
  --gke-cluster       GKE Cluster Name (auto-detected if omitted)
  --gke-namespace     GKE Namespace (default: genai-portal-<env>)
  --registry-name     Artifact Registry repo name
  --cmek-key          KMS CMEK key resource name (required by org policy in sov-*)
  --models-bucket     GCS bucket for model weights
  --gemma-model       Repo/dir name, default google/gemma-4-31B-it
                                       google/gemma-4-26B-A4B-it | google/gemma-4-E4B-it
  --embedding-model   HF repo id, e.g. BAAI/bge-m3
  --accelerator-type  nvidia-l4 (zones a,b) | nvidia-h100-80gb (zone c only)
  --vllm-image        Upstream vLLM image to mirror (must support Gemma 4)
  --weight-source     modelgarden (default, no credentials) | gcs | hf
  --promote-from ENV  Copy the weights another environment already validated,
                      e.g. --promote-from sov-dev. In-region GCS-to-GCS, so far
                      faster than re-fetching from the US Model Garden bucket.
  --weights-source-uri  Explicit gs:// parent prefix holding the model dirs
  --weights-source-project  Project owning that bucket, if cross-project
  --hf-token          Optional. Gemma 4 is Apache-2.0 and ungated, so not needed.
  --skip-images       Do not re-mirror inference images
  --skip-weights      Do not re-stage model weights
  --stage-only        Stage images and weights, then STOP. Installs no KEDA and
                      applies no manifests, so no GPU pods start and nothing
                      begins billing. Use this to prepare an environment ahead of
                      the decision to deploy it.
USAGE
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "${PROJECT_ID}" ]]; then
  echo "Error: --project-id is required." >&2
  exit 1
fi

# Check credentials before anything else. An expired session makes every
# subsequent gcloud call fail, and the first one to fail is the cluster lookup -
# which then reports "no GKE cluster found", pointing at the wrong problem.
if ! gcloud auth print-access-token >/dev/null 2>&1; then
  echo "FATAL: no usable gcloud credentials. Run:" >&2
  echo "  gcloud auth login" >&2
  exit 1
fi

# --- Derived values (must come AFTER argument parsing) ----------------------
# Must match terraform/modules/model_weights, whose name is built in
# terraform/locals.tf as "<application>-<environment>-model-weights".
[[ -z "${MODELS_BUCKET}" ]] && MODELS_BUCKET="genai-portal-${ENVIRONMENT}-model-weights"
[[ -z "${GKE_NAMESPACE}" ]] && GKE_NAMESPACE="genai-portal-${ENVIRONMENT}"

if [[ -z "${REGISTRY_NAME}" ]]; then
  REGISTRY_NAME="go-de-${ENVIRONMENT}-genai-portal"
fi

if [[ -z "${GKE_CLUSTER}" ]]; then
  GKE_CLUSTER=$(gcloud container clusters list --project="${PROJECT_ID}" --region="${REGION}" --format="value(name)" | head -n 1)
fi

if [[ -z "${GKE_CLUSTER}" ]]; then
  echo "Error: no GKE cluster found in ${PROJECT_ID}/${REGION}; pass --gke-cluster." >&2
  exit 1
fi

# Local directory name the manifests mount as /models/<name>.
GEMMA_LOCAL_NAME="$(basename "${GEMMA_MODEL}")"
EMBEDDING_LOCAL_NAME="$(basename "${EMBEDDING_MODEL}")"

# --- GPU count per model -------------------------------------------------------
# Only the GPU count, and only to estimate quota in the preflight below and to
# print it in the summary. CPU/memory/replicas used to live here too, to render
# manifests; that is cloudbuild.yaml's job now, from terraform's
# autopilot_gpu_pod_sizing map - the single source of truth.
#
# The count is still worth encoding: it is not a free choice. Autopilot's
# CPU/memory ceiling per accelerator is not monotonic, and the model decides how
# many cards it needs.
case "${GEMMA_MODEL}:${ACCELERATOR_TYPE}" in
  # 11.95B params. BF16 ~24GB does NOT fit a 24GB L4 alongside a KV cache,
  # so FP8 (~12GB) is mandatory here, leaving ~9GB for KV.
  *gemma-4-12B*:nvidia-l4)
    GPU_COUNT=1 ;;
  # 30.7B params, 33.4 GB at fp8 (measured). 2x L4 fits the WEIGHTS but leaves
  # only 2.38 GiB of KV cache - not enough for even 8K context, because Gemma 4's
  # head_dim 512 full-attention layers make KV ~4x more expensive than a
  # Llama-class model. 4x L4 leaves ~54 GB of KV, which is what 32K context needs.
  *gemma-4-31B*:nvidia-l4)
    GPU_COUNT=4 ;;
  # 25.2B total / 3.8B active. FP8 ~25GB just overflows one L4 -> TP2.
  # Only 3.8B params activate per token, so decode is much cheaper than 31B.
  *gemma-4-26B-A4B*:nvidia-l4)
    GPU_COUNT=2 ;;
  # 8B total / 4.5B effective. Comfortable in BF16 on one L4.
  *gemma-4-E4B*:nvidia-l4|*gemma-4-E2B*:nvidia-l4)
    GPU_COUNT=1 ;;
  # 80GB and 3.35TB/s of bandwidth: everything fits in BF16 on a single card.
  *gemma-4-31B*:nvidia-h100-80gb|*gemma-4-26B-A4B*:nvidia-h100-80gb)
    GPU_COUNT=1 ;;
  *:nvidia-h100-80gb)
    GPU_COUNT=1 ;;
  *)
    echo "WARN: no GPU-count profile for ${GEMMA_MODEL} on ${ACCELERATOR_TYPE}; assuming 1." >&2
    GPU_COUNT=1 ;;
esac

# Upper bound only, and only to size the quota estimate above. The replica
# counts that actually get deployed come from sovereign_inference.{min,max}_replicas
# in the environment's terragrunt.hcl, via Cloud Build.
if [[ "${ENVIRONMENT}" == *prod* ]]; then
  # GEMMA_REPLICAS is 1 for the 2026-09-01 pilot launch window, matching
  # sov-prod/terragrunt.hcl - see the note there. TEI stays at 2: it runs on
  # ordinary nodes, so it is not competing for scarce GPU capacity.
  GEMMA_MAX_REPLICAS=3
else
  GEMMA_MAX_REPLICAS=2
fi

echo "============================================================"
echo "Starting Master Sovereign AI Automation"
echo "============================================================"
printf '%-18s %s\n' \
  "Project ID:"      "${PROJECT_ID}" \
  "Region:"          "${REGION}" \
  "Environment:"     "${ENVIRONMENT}" \
  "Cluster:"         "${GKE_CLUSTER}" \
  "Namespace:"       "${GKE_NAMESPACE}" \
  "Registry:"        "${REGISTRY_NAME}" \
  "Models Bucket:"   "gs://${MODELS_BUCKET}" \
  "Gemma Model:"     "${GEMMA_MODEL}" \
  "Embedding Model:" "${EMBEDDING_MODEL}" \
  "Accelerator:"     "${ACCELERATOR_TYPE} x${GPU_COUNT}" \
  "Serving knobs:"   "from k8s/env.yaml (VLLM_QUANTIZATION, VLLM_MAX_MODEL_LEN, VLLM_MAX_NUM_SEQS)"
echo "============================================================"

# --- Preflight: fail early on the things that actually block --------------------
echo ""
echo "[Preflight] Checking accelerator availability and quota..."
ACCEL_ZONES=$(gcloud compute accelerator-types list --project="${PROJECT_ID}" \
  --filter="name=${ACCELERATOR_TYPE} AND zone~${REGION}" --format="value(zone)" | tr '\n' ' ')
if [[ -z "${ACCEL_ZONES}" ]]; then
  echo "FATAL: ${ACCELERATOR_TYPE} is not offered in any ${REGION} zone." >&2
  echo "       Available accelerators in ${REGION}:" >&2
  gcloud compute accelerator-types list --project="${PROJECT_ID}" \
    --filter="zone~${REGION}" --format="value(name,zone)" | sort -u >&2
  exit 1
fi
echo "[ok] ${ACCELERATOR_TYPE} available in zones: ${ACCEL_ZONES}"

QUOTA_METRIC="NVIDIA_$(echo "${ACCELERATOR_TYPE}" | sed 's/^nvidia-//; s/-/_/g' | tr '[:lower:]' '[:upper:]')_GPUS"
QUOTA_LIMIT=$(gcloud compute regions describe "${REGION}" --project="${PROJECT_ID}" \
  --format="value(quotas)" | tr ';' '\n' | grep -F "'${QUOTA_METRIC}'" | grep -oE "'limit': [0-9.]+" | grep -oE "[0-9.]+" || echo "0")
NEEDED=$(( GPU_COUNT * (GEMMA_MAX_REPLICAS + 1) ))
echo "[info] quota ${QUOTA_METRIC} = ${QUOTA_LIMIT:-0}; peak need (incl. rollout surge) = ${NEEDED}"
if [[ "${QUOTA_LIMIT%%.*}" -lt "${NEEDED}" ]] 2>/dev/null; then
  echo "WARN: quota may be insufficient at max scale. Request an increase for ${QUOTA_METRIC} in ${REGION}." >&2
fi

# Verified against the HF API: google/gemma-4-*-it return HTTP 200 with
# gated=false and license=apache-2.0, so no token is required. This differs from
# Gemma 2/3, which shipped under the custom Gemma Terms of Use and did gate.
# One effective prefix, whatever the caller asked for.
if [[ -n "${WEIGHTS_SOURCE_URI}" ]]; then
  SOURCE_PREFIX="${WEIGHTS_SOURCE_URI}"
  WEIGHT_SOURCE=gcs
elif [[ "${WEIGHT_SOURCE}" == "modelgarden" ]]; then
  SOURCE_PREFIX="${MODEL_GARDEN_BUCKET}"
  WEIGHT_SOURCE=gcs
else
  SOURCE_PREFIX=""
fi

if [[ "${WEIGHT_SOURCE}" == "gcs" ]]; then
  echo "[info] weights source: ${SOURCE_PREFIX} (GCS-to-GCS, no credentials needed)"
  if [[ "${SOURCE_PREFIX}" == *"model-weights"* ]]; then
    echo "[info] promoting from another environment - prod will run the exact bytes"
    echo "       that environment was validated against."
  fi
fi

# Step 1: Verify the Terraform-managed bucket and registry exist
#
# This script deliberately does NOT create the bucket. It is owned by
# terraform/modules/model_weights (CMEK, public-access-prevention enforced,
# soft-delete disabled, reviewed IAM). Creating it here too would give one
# resource two owners, and a bucket made by an ad-hoc gcloud call would silently
# miss the encryption and access settings a sovereign environment requires.
echo ""
echo "[Step 1/6] Verifying Terraform-managed storage and registry..."
K8S_SA="genai-portal-${ENVIRONMENT}-k8s-sa@${PROJECT_ID}.iam.gserviceaccount.com"
# The identity every Cloud Build in this script runs as. Terraform grants THIS
# account objectAdmin on the weights bucket (modules/model_weights.writer_members).
# Without --service-account, `gcloud builds submit` silently falls back to the
# Cloud Build default compute SA, which has no grant on that bucket - the
# resulting 403 on storage.objects.create is not a project misconfiguration but
# a wrong-identity bug.
BUILD_SA="genai-portal-${ENVIRONMENT}-build-sa@${PROJECT_ID}.iam.gserviceaccount.com"
BUILD_SA_REF="projects/${PROJECT_ID}/serviceAccounts/${BUILD_SA}"

if ! gcloud storage buckets describe "gs://${MODELS_BUCKET}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  cat >&2 <<MSG
FATAL: gs://${MODELS_BUCKET} does not exist.

This bucket is managed by Terraform, not by this script. Create it by setting
  enable_sovereign_inference = true
in environments/uksh/${ENVIRONMENT}/terragrunt.hcl, then:
  terragrunt apply --working-dir environments/uksh/${ENVIRONMENT}
MSG
  exit 1
fi

# Confirm the weights really are encrypted with a customer-managed key - the
# point of staging them in-project rather than pulling from a public hub.
BUCKET_KMS=$(gcloud storage buckets describe "gs://${MODELS_BUCKET}" \
  --project="${PROJECT_ID}" --format="value(default_kms_key)" 2>/dev/null || echo "")
if [[ -n "${BUCKET_KMS}" ]]; then
  echo "[ok] gs://${MODELS_BUCKET} - CMEK: ${BUCKET_KMS}"
else
  echo "WARN: gs://${MODELS_BUCKET} has no default CMEK key, which is unexpected in a sov-* project." >&2
fi

if ! gcloud artifacts repositories describe "${REGISTRY_NAME}" \
     --project="${PROJECT_ID}" --location="${REGION}" >/dev/null 2>&1; then
  cat >&2 <<MSG
FATAL: Artifact Registry repo ${REGISTRY_NAME} not found in ${REGION}.

It is created by terraform/modules/cloudbuild as
google_artifact_registry_repository.repo, with
repository_id = "<prefix>-<environment>-<application>". Run terragrunt apply for
this environment, or pass the correct name with --registry-name.
MSG
  exit 1
fi
echo "[ok] Artifact Registry: ${REGION}-docker.pkg.dev/${PROJECT_ID}/${REGISTRY_NAME}"

# Step 2: The one grant Terraform does not already make.
#
# modules/model_weights grants the k8s SA objectViewer on the weights bucket and
# the build SA objectAdmin; modules/cloudbuild grants the build SA
# artifactregistry.writer; modules/gke_cluster grants the node SA
# artifactregistry.reader. Only monitoring.viewer is missing, which KEDA needs to
# query Managed Prometheus - without it the ScaledObject reports a scaler error
# and the GPU fleet never autoscales.
echo ""
echo "[Step 2/6] Granting the two bindings Terraform cannot own..."

# KEDA queries Managed Prometheus through the Cloud Monitoring API.
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${K8S_SA}" \
  --role="roles/monitoring.viewer" --quiet >/dev/null
echo "[ok] monitoring.viewer granted to ${K8S_SA}."

# Submitting a build that RUNS AS the build SA requires the caller to be able to
# impersonate it. This depends on who is running the script, not on the
# environment, which is why it lives here rather than in Terraform.
CALLER=$(gcloud config get-value account 2>/dev/null)
if [[ -n "${CALLER}" ]]; then
  gcloud iam service-accounts add-iam-policy-binding "${BUILD_SA}" \
    --project="${PROJECT_ID}" \
    --member="user:${CALLER}" \
    --role="roles/iam.serviceAccountUser" --quiet >/dev/null 2>&1 \
    && echo "[ok] ${CALLER} may now act as ${BUILD_SA}." \
    || echo "WARN: could not grant serviceAccountUser on ${BUILD_SA} to ${CALLER}; builds may fail to submit." >&2
fi

# Step 3: Mirror inference images into the sovereign registry
# Auto-detect: if both pinned tags already resolve in Artifact Registry there is
# nothing to mirror. Saves having to remember --skip-images, which is a ~16
# minute mistake.
if [[ -z "${SKIP_IMAGES:-}" ]]; then
  AR_PATH="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REGISTRY_NAME}"
  # NOTE: `gcloud artifacts docker images describe` is NOT usable here - it calls
  # containeranalysis.googleapis.com, which gcp.restrictServiceUsage blocks in
  # the sov-* projects, so it fails with a policy error regardless of whether the
  # image exists. `tags list` reads Artifact Registry directly and is allowed.
  if gcloud artifacts docker tags list "${AR_PATH}/vllm" --project="${PROJECT_ID}" \
       --format="value(tag)" 2>/dev/null | grep -qx "${VLLM_IMAGE_TAG}" \
  && gcloud artifacts docker tags list "${AR_PATH}/tei" --project="${PROJECT_ID}" \
       --format="value(tag)" 2>/dev/null | grep -qx "${TEI_IMAGE_TAG}"; then
    echo ""
    echo "[Step 3/6] vllm:${VLLM_IMAGE_TAG} and tei:${TEI_IMAGE_TAG} already present - skipping mirror."
    SKIP_IMAGES=1
  fi
fi

if [[ -z "${SKIP_IMAGES:-}" ]]; then
  echo ""
  echo "[Step 3/6] Mirroring inference images to Sovereign Artifact Registry..."
  AR_HOST="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REGISTRY_NAME}"
  cat > /tmp/sync_images.yaml <<EOF
steps:
- name: 'gcr.io/cloud-builders/docker'
  id: 'mirror-vllm'
  entrypoint: bash
  args:
    - -c
    - |
      set -e
      docker pull ${VLLM_IMAGE}
      docker tag ${VLLM_IMAGE} ${AR_HOST}/vllm:${VLLM_IMAGE_TAG}
      docker push ${AR_HOST}/vllm:${VLLM_IMAGE_TAG}
      # Record the immutable digest so the deployed engine is auditable.
      docker inspect --format='{{index .RepoDigests 0}}' ${VLLM_IMAGE}
- name: 'gcr.io/cloud-builders/docker'
  id: 'mirror-tei'
  entrypoint: bash
  args:
    - -c
    - |
      set -e
      docker pull ${TEI_IMAGE}
      docker tag ${TEI_IMAGE} ${AR_HOST}/tei:${TEI_IMAGE_TAG}
      docker push ${AR_HOST}/tei:${TEI_IMAGE_TAG}
      docker inspect --format='{{index .RepoDigests 0}}' ${TEI_IMAGE}
options:
  machineType: 'E2_HIGHCPU_8'
  # vLLM images are ~10-20GB; the 100GB default fills up once layers are
  # unpacked alongside TEI.
  diskSizeGb: 200
  logging: CLOUD_LOGGING_ONLY
# Default is 10 minutes, which these pulls exceed.
timeout: 3600s
EOF
  gcloud builds submit --project="${PROJECT_ID}" --region="${REGION}" --service-account="${BUILD_SA_REF}" --no-source --config=/tmp/sync_images.yaml
  echo "[ok] Images mirrored."
else
  echo ""
  echo "[Step 3/6] Skipped (--skip-images)."
fi


# ---------------------------------------------------------------------------
# Idempotency: is this model already fully staged?
#
# Compares TOTAL BYTES at source and destination rather than just testing that
# the prefix exists. Presence is not completeness - a copy interrupted partway
# (which is exactly what a permissions failure leaves behind) produces a prefix
# holding a truncated checkpoint. Skipping on presence alone would then hand
# vLLM a half-written model, which fails at load or, worse, half-loads.
#
# Returns 0 = complete (skip), 1 = absent or partial (copy).
weights_complete() {
  local src="$1" dst="$2"
  local src_bytes dst_bytes
  src_bytes=$(gcloud storage du -s "${src}" 2>/dev/null | awk '{print $1}')
  dst_bytes=$(gcloud storage du -s "${dst}" 2>/dev/null | awk '{print $1}')
  [[ -z "${src_bytes}" ]] && return 1
  if [[ -z "${dst_bytes}" || "${dst_bytes}" == "0" ]]; then
    echo "[info] ${dst} absent - will copy $(( src_bytes / 1024 / 1024 / 1024 )) GB." >&2
    return 1
  fi
  if [[ "${src_bytes}" == "${dst_bytes}" ]]; then
    echo "[ok] ${dst} already complete ($(( dst_bytes / 1024 / 1024 / 1024 )) GB matches source) - skipping." >&2
    return 0
  fi
  echo "WARN: ${dst} is PARTIAL ($(( dst_bytes / 1024 / 1024 / 1024 )) GB of $(( src_bytes / 1024 / 1024 / 1024 )) GB) - re-copying." >&2
  return 1
}

# Step 4+5: Stage both models into this environment's CMEK bucket.
#
# One code path for all three sources. Promotion (dev -> prod) is not a special
# case: it is just a different GCS prefix that happens to live in the same
# region, which is why it is ~5x faster than re-fetching from the US.
stage_model() {
  local repo_id="$1" local_name="$2" label="$3"
  local dst="gs://${MODELS_BUCKET}/${local_name}"

  if [[ "${WEIGHT_SOURCE}" == "gcs" ]]; then
    local src="${SOURCE_PREFIX}/${local_name}"
    if ! gcloud storage ls "${src}/" >/dev/null 2>&1; then
      if [[ "${label}" == "embedding" ]]; then
        echo "[info] ${src} not present at the GCS source; falling back to Hugging Face." >&2
        stage_model_from_hf "${repo_id}" "${local_name}"
        return
      fi
      echo "FATAL: ${src} not found." >&2
      echo "Available under ${SOURCE_PREFIX}:" >&2
      gcloud storage ls "${SOURCE_PREFIX}/" 2>/dev/null | sed "s|${SOURCE_PREFIX}/||" >&2
      exit 1
    fi

    if [[ "${src}" == "${dst}" ]]; then
      echo "FATAL: source and destination are the same (${src})." >&2
      echo "That means ENVIRONMENT and the promotion source resolved identically." >&2
      exit 1
    fi

    if weights_complete "${src}" "${dst}"; then
      return
    fi

    cat > "/tmp/stage_${local_name}.yaml" <<EOF
steps:
- name: 'gcr.io/google.com/cloudsdktool/google-cloud-cli:slim'
  entrypoint: 'bash'
  args:
    - -c
    - |
      set -e
      gcloud storage cp -r "${src}" "gs://${MODELS_BUCKET}/"
      gcloud storage du -s -r "${dst}"
      # Provenance record: which bytes, from where. Without this there is no way
      # to show later that prod ran the weights dev was validated against.
      gcloud storage ls -l "${dst}/**" > /workspace/manifest.txt
      echo "source=${src}" >> /workspace/manifest.txt
      gcloud storage cp /workspace/manifest.txt "${dst}.manifest.txt"
options:
  machineType: 'E2_HIGHCPU_32'
  diskSizeGb: 100
  logging: CLOUD_LOGGING_ONLY
timeout: 7200s
EOF
    gcloud builds submit --project="${PROJECT_ID}" --region="${REGION}" \
      --service-account="${BUILD_SA_REF}" --no-source --config="/tmp/stage_${local_name}.yaml"

    # Prove the copy is byte-identical to its source rather than assuming it.
    if weights_complete "${src}" "${dst}"; then
      echo "[ok] ${local_name} verified identical to ${src}."
    else
      echo "FATAL: ${dst} does not match ${src} after copy." >&2
      exit 1
    fi
  else
    stage_model_from_hf "${repo_id}" "${local_name}"
  fi
}

stage_model_from_hf() {
  local repo_id="$1" local_name="$2"
  local hf_secret_env="" hf_secret_block=""
  if gcloud secrets describe HF_TOKEN --project="${PROJECT_ID}" >/dev/null 2>&1; then
    hf_secret_env="  secretEnv: ['HF_TOKEN']"
    hf_secret_block="availableSecrets:
  secretManager:
    - versionName: projects/${PROJECT_ID}/secrets/HF_TOKEN/versions/latest
      env: 'HF_TOKEN'"
  fi
  cat > "/tmp/stage_${local_name}.yaml" <<EOF
steps:
- name: 'python:3.11-slim'
  entrypoint: 'bash'
  args:
    - -c
    - |
      set -e
      pip install --no-cache-dir "huggingface_hub[hf_transfer]"
      export HF_HUB_ENABLE_HF_TRANSFER=1
      python - <<'PYEOF'
      import os
      from huggingface_hub import snapshot_download
      snapshot_download(
          "${repo_id}",
          local_dir="/workspace/${local_name}",
          token=os.environ.get("HF_TOKEN") or None,
          allow_patterns=["*.safetensors", "*.safetensors.index.json", "*.json", "*.model", "*.txt", "*.jinja"],
      )
      PYEOF
${hf_secret_env}
- name: 'gcr.io/google.com/cloudsdktool/google-cloud-cli:slim'
  entrypoint: 'bash'
  args:
    - -c
    - |
      set -e
      gcloud storage cp -r "/workspace/${local_name}" "gs://${MODELS_BUCKET}/"
      gcloud storage du -s -r "gs://${MODELS_BUCKET}/${local_name}"
${hf_secret_block}
options:
  machineType: 'E2_HIGHCPU_32'
  diskSizeGb: 500
  logging: CLOUD_LOGGING_ONLY
timeout: 7200s
EOF
  gcloud builds submit --project="${PROJECT_ID}" --region="${REGION}" \
    --service-account="${BUILD_SA_REF}" --no-source --config="/tmp/stage_${local_name}.yaml"
}

if [[ -z "${SKIP_WEIGHTS:-}" ]]; then
  # Cross-project read, for the promotion case. Granted on the SOURCE bucket, and
  # only so the build can read it - the weights end up in this project's own CMEK
  # bucket, so there is no standing runtime dependency on the other environment.
  if [[ "${WEIGHT_SOURCE}" == "gcs" && -n "${WEIGHTS_SOURCE_PROJECT}" ]]; then
    SRC_BUCKET="${SOURCE_PREFIX#gs://}"; SRC_BUCKET="${SRC_BUCKET%%/*}"
    echo ""
    echo "[Step 4/6] Granting ${BUILD_SA} read on gs://${SRC_BUCKET} (project ${WEIGHTS_SOURCE_PROJECT})..."
    gcloud storage buckets add-iam-policy-binding "gs://${SRC_BUCKET}" \
      --project="${WEIGHTS_SOURCE_PROJECT}" \
      --member="serviceAccount:${BUILD_SA}" \
      --role="roles/storage.objectViewer" --quiet >/dev/null \
      && echo "[ok] cross-project read granted." \
      || echo "WARN: could not grant read on gs://${SRC_BUCKET}. Someone with admin on ${WEIGHTS_SOURCE_PROJECT} must run this." >&2
  fi

  echo ""
  echo "[Step 4/6] Staging generation model (${GEMMA_MODEL})..."
  stage_model "${GEMMA_MODEL}" "${GEMMA_LOCAL_NAME}" generation
  echo "[ok] Generation weights at gs://${MODELS_BUCKET}/${GEMMA_LOCAL_NAME}."

  echo ""
  echo "[Step 5/6] Staging embedding model (${EMBEDDING_MODEL})..."
  stage_model "${EMBEDDING_MODEL}" "${EMBEDDING_LOCAL_NAME}" embedding
  echo "[ok] Embedding weights at gs://${MODELS_BUCKET}/${EMBEDDING_LOCAL_NAME}."
else
  echo ""
  echo "[Steps 4-5/6] Skipped (--skip-weights)."
fi

echo ""


echo "[Step 6/6] Checking KEDA Autoscaler on GKE Cluster..."
gcloud container clusters get-credentials "${GKE_CLUSTER}" --region="${REGION}" --project="${PROJECT_ID}"
if kubectl get crd scaledobjects.keda.sh >/dev/null 2>&1; then
  echo "[ok] KEDA already installed."
else
  echo "[+] Installing KEDA via Helm..."
  helm repo add kedacore https://kedacore.github.io/charts --force-update
  helm repo update
  helm install keda kedacore/keda --namespace keda --create-namespace --wait
  echo "[ok] KEDA installed."
fi

# The KEDA operator authenticates to Managed Prometheus as the project's k8s SA
# via Workload Identity. Without this annotation the TriggerAuthentication with
# provider: gcp has no identity to assume.
kubectl annotate serviceaccount keda-operator -n keda \
  "iam.gke.io/gcp-service-account=${K8S_SA}" --overwrite
gcloud iam service-accounts add-iam-policy-binding "${K8S_SA}" \
  --project="${PROJECT_ID}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:${PROJECT_ID}.svc.id.goog[keda/keda-operator]" --quiet >/dev/null || true
kubectl rollout restart deployment/keda-operator -n keda >/dev/null 2>&1 || true

# ==============================================================================
# Deployment is NOT this script's job.
#
# cloudbuild.yaml renders and applies vllm-gemma.yaml, tei-embeddings.yaml and
# keda-vllm-autoscaler.yaml from the Cloud Build substitutions, which terraform
# owns. This script used to do the same from its own sizing table, which meant
# two writers to the same objects and to the "env" ConfigMap - whichever ran
# last won. Staging (images, weights, KEDA) is the part only this script can do.
# ==============================================================================
echo "============================================================"
echo "Staging complete. Nothing was deployed."
echo "============================================================"
echo "Images   : ${REGION}-docker.pkg.dev/${PROJECT_ID}/${REGISTRY_NAME}"
echo "Weights  : gs://${MODELS_BUCKET}"
echo "KEDA     : installed in namespace 'keda'"
echo ""
echo "To deploy, set the environment's terragrunt input to"
echo ""
echo "    self_hosted_inference = \"serving\""
echo ""
echo "apply, and push to the trigger branch. Terraform arms the build only once"
echo "it can see the weights in the bucket, so this ordering is safe."
echo ""
echo "First GPU pod start is SLOW: node provisioning plus a cold GCS FUSE read"
echo "of the weights. Allow up to 20 minutes before treating it as failed."
echo ""
echo "  kubectl get pods -n ${GKE_NAMESPACE} -w"
echo "  kubectl logs -n ${GKE_NAMESPACE} deploy/gemma-vllm -c vllm -f"
echo ""
echo "Verify end to end once the pods are up:"
echo "  ./scripts/test_sovereign_inference.sh ${GKE_NAMESPACE} ${GEMMA_LOCAL_NAME} ${EMBEDDING_LOCAL_NAME}"
echo "============================================================"
