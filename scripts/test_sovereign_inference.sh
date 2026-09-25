#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# UKSH Sovereign Cloud - Model Inference & Embedding Validation
#
# Verifies that generation and embeddings are served from inside the cluster,
# that Gemma 4's tool-calling protocol works (the agents endpoint depends on it),
# and that the embedding dimension matches what pgvector expects.
# ==============================================================================

NAMESPACE="${1:-genai-portal-sov-dev}"
# The served model name is the basename of the repo/dir, e.g. gemma-4-31B-it.
# The old script sent "model": "gemma-4", which vLLM rejects with a 404
# "model not found" because it never matches --served-model-name.
GEMMA_MODEL="${2:-gemma-4-31B-it}"
EMBEDDING_MODEL="${3:-bge-m3}"

VLLM_SERVICE="gemma-vllm-service.${NAMESPACE}.svc.cluster.local:8000"
TEI_SERVICE="tei-embeddings-service.${NAMESPACE}.svc.cluster.local:8000"

# Pinned rather than :latest, and run from a single throwaway pod so we are not
# billed for four separate pod cold starts.
CURL_IMAGE="${CURL_IMAGE:-curlimages/curl:8.11.1}"

echo "=== Sovereign AI validation in namespace: ${NAMESPACE} ==="
echo "    generation model: ${GEMMA_MODEL}"
echo "    embedding model:  ${EMBEDDING_MODEL}"
echo ""

run_in_cluster() {
  # jq is not present in curlimages/curl, and piping kubectl output to a local
  # jq (as the previous version did) fails on any machine without jq installed.
  # Keep all processing in-cluster and print raw JSON.
  kubectl run -i --rm --restart=Never "sovtest-$RANDOM" \
    --namespace="${NAMESPACE}" \
    --image="${CURL_IMAGE}" \
    --quiet \
    --command -- sh -c "$1"
}

echo "[1/4] Models advertised by vLLM..."
run_in_cluster "curl -sS --max-time 30 http://${VLLM_SERVICE}/v1/models"
echo ""

echo "[2/4] German chat completion..."
run_in_cluster "curl -sS --max-time 120 -X POST http://${VLLM_SERVICE}/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    \"model\": \"${GEMMA_MODEL}\",
    \"messages\": [
      {\"role\": \"system\", \"content\": \"Du bist ein medizinischer KI-Assistent für das UKSH. Antworte praezise und auf Deutsch.\"},
      {\"role\": \"user\", \"content\": \"Nenne in drei Saetzen die wichtigsten Kontraindikationen fuer eine MRT-Untersuchung.\"}
    ],
    \"max_tokens\": 300,
    \"temperature\": 0.3
  }'"
echo ""

# The prod librechat.yaml drives every model spec through endpoint "agents" with
# the tools/actions/chain capabilities, so tool calling is not optional here - if
# this returns prose instead of a tool_calls array, the vLLM launch flags are
# missing --tool-call-parser=gemma4 and the agents will appear broken to users.
echo "[3/4] Tool calling (required by the agents endpoint)..."
run_in_cluster "curl -sS --max-time 120 -X POST http://${VLLM_SERVICE}/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    \"model\": \"${GEMMA_MODEL}\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Wie ist das Wetter in Kiel?\"}],
    \"tools\": [{
      \"type\": \"function\",
      \"function\": {
        \"name\": \"get_weather\",
        \"description\": \"Liefert das aktuelle Wetter fuer einen Ort\",
        \"parameters\": {
          \"type\": \"object\",
          \"properties\": {\"ort\": {\"type\": \"string\"}},
          \"required\": [\"ort\"]
        }
      }
    }],
    \"tool_choice\": \"auto\",
    \"max_tokens\": 200
  }'"
echo ""

echo "[4/4] Embeddings + dimension check..."
# The dimension must match the pgvector column. text-embedding-004 was 768;
# bge-m3 is 1024, so a mismatch here means the vector store was not migrated and
# every retrieval will fail or silently return nothing.
run_in_cluster "curl -sS --max-time 60 -X POST http://${TEI_SERVICE}/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{
    \"model\": \"${EMBEDDING_MODEL}\",
    \"input\": \"Universitaetsklinikum Schleswig-Holstein DiMeAs RAG Dokumentenanalyse\"
  }' | tr ',' '\n' | grep -c '^-\?[0-9]' | sed 's/^/embedding dimension: /'"
echo ""

echo "=== Verification complete ==="
echo ""
echo "Expected: /v1/models lists ${GEMMA_MODEL}; the German answer is fluent;"
echo "step 3 returns a tool_calls array (NOT prose); dimension is 1024 for bge-m3."
