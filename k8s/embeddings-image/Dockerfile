# Text Embeddings Inference with the model weights baked in.
#
# The point is isolation, not convenience: when the weights are in the image, the
# kubelet fetches them from Artifact Registry and the Pod itself needs no egress
# at all. That is what lets a NetworkPolicy deny everything except DNS.
#
# The alternative -- staging weights in GCS and mounting them with gcsfuse --
# cannot achieve that, because the gcsfuse sidecar needs HTTPS to Cloud Storage
# and a NetworkPolicy applies to the whole Pod. A rule permitting 443 permits
# Vertex AI and huggingface.co along with it.
#
# Built rarely and by hand -- the app pipeline does not build this. See
# k8s/README-embeddings.md.
#
#   gcloud builds submit k8s/embeddings-image \
#     --project go-de-genai-studio --region europe-west3 \
#     --tag europe-west3-docker.pkg.dev/go-de-genai-studio/go-de-dev-go-genai-studio/embeddings-bge-m3:1
#
# The positional argument is the build context, and it is this directory rather
# than the repository root for two reasons: `gcloud builds submit --tag` has no
# flag for a Dockerfile name, so the file has to be called Dockerfile and sit in
# the context; and the repository root is 287 MB that would be uploaded for
# nothing. Here the context is 4 KB.
#
# Cloud Build workers are amd64, which also sidesteps building an arm64 image on
# an Apple Silicon machine that the nodes could not run.

ARG TEI_IMAGE=ghcr.io/huggingface/text-embeddings-inference:cpu-1.8.1

FROM python:3.12-slim AS weights
ARG MODEL_ID=BAAI/bge-m3
RUN pip install --no-cache-dir huggingface_hub
# snapshot_download rather than the CLI: the entry point was renamed from
# huggingface-cli to hf, and the library call is stable across both.
#
# Excluded on purpose: pytorch_model.bin (2.3 GB that TEI's ONNX backend never
# reads), the colbert and sparse heads (unused by dense embedding), and the
# repo's images. What remains is onnx/ plus the tokenizer and pooling configs.
RUN python -c "\
from huggingface_hub import snapshot_download; \
snapshot_download('${MODEL_ID}', local_dir='/weights', \
  ignore_patterns=['*.bin','*.pt','imgs/*','*.jpg','README.md','.gitattributes'])"
RUN du -sh /weights && find /weights -maxdepth 2 -type f | head -20

FROM ${TEI_IMAGE}
# MODEL_ID at runtime must point here, and HF_HUB_OFFLINE must be set, so a
# missing file fails loudly instead of silently reaching out to the hub.
COPY --from=weights /weights /models/bge-m3
