# Self-hosted embedding model (EmbeddingGemma via TEI)

Runs EmbeddingGemma in the cluster so the RAG embeddings can eventually move off
Vertex AI:

---

## Wiring the RAG API to it

`_RAG_SELF_HOSTED_EMBEDDINGS` is a separate switch from `_EMBEDDINGS_ENABLED`,
because serving the model is reversible and consuming it is not: the vector
dimension changes, and everything already indexed has to be re-embedded.

The five settings that make it work are **derived together** in
`cloudbuild.yaml`, not exposed individually. That is not tidiness — it is the
only way to make the dangerous combination unrepresentable.

### Why `RAG_CHECK_EMBEDDING_CTX_LENGTH=False` is mandatory

`langchain_openai.OpenAIEmbeddings` defaults to `check_embedding_ctx_length=True`,
which makes it tokenize client-side with **tiktoken** and send arrays of OpenAI
token ids instead of strings. TEI receives those integers and reads them as ids
in bge-m3's own vocabulary, which is a different vocabulary. Nothing errors. The
response is a well-formed 1024-dimensional vector that means nothing.

Measured against the running service, same input string both ways:

```
cos( check=True , check=False )  =  0.2551      # 1.0 would mean equivalent

Query: "Welche Antibiotikadosierung wurde verordnet?"
  check=False   sims=[0.436, 0.379, 0.312]  -> ranks the dosage document first
  check=True    sims=[0.291, 0.297, 0.317]  -> ranks "the coffee machine is broken" first
```

With `True`, all three scores collapse into noise and the ranking inverts. There
is no log line and no exception — a RAG built this way returns confident,
irrelevant answers. This is why provider, model id, base URL and this flag are
set as one derived set.

### Why the collection name has to change

`langchain_pg_embedding.embedding` is an **unconstrained** `vector` column, not
`vector(768)`. So 1024-dimensional rows insert alongside 768-dimensional ones
without complaint, and the failure surfaces later, on **read**:

```
ERROR: different vector dimensions 1024 and 768
```

The break is in the query path and it hits the *existing* documents. A distinct
`COLLECTION_NAME` keeps the old 768-dim rows in `testcollection`, where they are
simply never read again, instead of poisoning every query. Documents indexed
before the switch stay in the database but stop being retrievable, so they have
to be re-uploaded.

| | Vertex AI `text-embedding-004` | bge-m3 |
|---|---|---|
| Dimensions | 768 | 1024 |
| Collection | `testcollection` | `bge_m3_1024` |

### Measured throughput

At `embeddings_cpu = 4`, on the running deployment:

| Path | Latency | Bottleneck? |
|---|---|---|
| Query, 17 chars | 54 ms | No |
| Query, 98 chars | 142 ms | No |
| Document chunk, 1500 chars | ~1.37 s | **Yes** |

Retrieval is comfortably fast — this is the user-facing path. Ingestion is not:
a 100-chunk document takes over two minutes, and the pod uses 2889m of its 4000m
CPU while doing it, so `embeddings_cpu` is the lever that matters. This is also
why `EMBEDDINGS_CHUNK_SIZE` is derived as `32` rather than the upstream `200` —
200 chunks in one HTTP request would run for four minutes against a client
timeout.

### Why not the `huggingfacetei` provider

The RAG API has a provider named for exactly this case, and it does not work in
this image:

```
AttributeError: 'InferenceClient' object has no attribute 'post'
```

`langchain-huggingface 0.1.0` calls `InferenceClient.post()`, removed in
`huggingface_hub 0.33.4`. Both are pinned in the deployed `rag` image, so the
`openai` provider against TEI's OpenAI-compatible route is the working path, not
merely the preferred one.

---

## Model choice

The default is **`BAAI/bge-m3`**, verified running in `goreply/dev`. The reason is
not licensing or benchmarks — it is the serving backend.

**TEI's CPU image runs the ONNX Runtime backend and only falls back to Candle.**
That fallback is where things break, and it is not visible from a model card. What
this rules out, learned the hard way:

| Model | ONNX in repo | Outcome on `cpu-1.8.1` |
|---|---|---|
| **`BAAI/bge-m3`** | **yes** | **works** — ORT backend, verified |
| `intfloat/multilingual-e5-large` | yes | untested, same architecture family |
| `Qwen/Qwen3-Embedding-0.6B` | **no** | falls back to Candle, then dies: `Intel MKL ERROR: Parameter 8 was incorrect on entry to SGEMM` |
| `google/embeddinggemma-300m` | **no** | untested, but takes the same Candle path Qwen3 died on |

So the selection rule for this deployment is: **the model must ship
`onnx/model.onnx`.** Being ungated and permissively licensed is a bonus, not the
criterion.

That also disposes of an earlier concern: bge-m3 ships no `model.safetensors`,
which looks disqualifying until you notice the CPU backend does not want
safetensors in the first place.

| | Licence | Gated | Context | Dims | Pooling |
|---|---|---|---:|---:|---|
| `BAAI/bge-m3` | mit | no | 8192 | 1024 | `cls` |
| `intfloat/multilingual-e5-large` | mit | no | **512** | 1024 | `mean` |
| `google/embeddinggemma-300m` | gemma + PUP | **yes** | 2048 | 768 | auto |

bge-m3 also needs no query/document prefixes, which matters for step two — see
below. EmbeddingGemma would additionally need a licence acceptance by a person, a
read token in the namespace, and a legal look at its Prohibited Use Policy, which
restricts medical and healthcare use.

The choice is still open. Until the RAG API consumes these vectors, swapping the
model is `embeddings_model` plus a matching `embeddings_pooling`. Once it does,
every swap costs a re-index — so this is the cheap moment to compare candidates
on a real German clinical corpus, which no published benchmark speaks to.

### The setting that OOM-kills the pod

`MAX_BATCH_TOKENS` is the most memory-sensitive value here, and it is not
obvious. TEI warms up with a batch that large, and attention is quadratic in
sequence length: at 8192 tokens a single attention matrix of an XLM-R-large model
is roughly 4 GB. The pod was `OOMKilled` during warm-up before serving anything.

Verified working: `MAX_BATCH_TOKENS=2048` with **`8Gi`** — Ready in 102 s,
2612 Mi steady state, so there is ample headroom. At ~375 tokens per
1500-character chunk that is about five chunks per batch; TEI simply runs more
batches, which is why the ceiling costs throughput rather than correctness.

The two were originally raised together, which left the floor unknown and the
request at `16Gi`. Measured separately afterwards: the memory was never the
problem, `MAX_BATCH_TOKENS` was. Raise them together or neither.

## Enabling it

### Step one: build the image with the weights

```bash
gcloud builds submit k8s/embeddings-image \
  --project go-de-genai-studio --region europe-west3 \
  --tag europe-west3-docker.pkg.dev/go-de-genai-studio/go-de-dev-go-genai-studio/embeddings-bge-m3:1
```

The build context is that directory alone — 4 KB, not the repo. Bump the tag for
a new model; `:1` is not a moving target.

### Step two: the environment's `terragrunt.hcl`

```hcl
embeddings_enabled = true
embeddings_image   = "europe-west3-docker.pkg.dev/go-de-genai-studio/go-de-dev-go-genai-studio/embeddings-bge-m3:1"
embeddings_offline = true
embeddings_model   = "/models/bge-m3"   # in-image path, not a hub id
embeddings_pooling = "cls"
embeddings_cpu     = 4
embeddings_memory  = "8Gi"

# Only once the model above is verified. Forces a re-index.
rag_self_hosted_embeddings = true
rag_collection_name        = "bge_m3_1024"
```

`embeddings_image`, `embeddings_offline` and `embeddings_model` travel as a set:
the path only exists inside that image, and `embeddings_offline` is what switches
on the egress policy.

Then `make apply env=dev` and push to the trigger branch.

```bash
kubectl rollout status deployment/embeddings -n go-genai-studio-dev --timeout=15m
kubectl rollout status deployment/rag        -n go-genai-studio-dev --timeout=10m
```

Autopilot usually has to add a node for the request size, so allow a few
minutes. Ready in 102 s once scheduled — there is no download, which is the
point.

---

## Verifying

```bash
kubectl port-forward -n go-genai-studio-dev deployment/embeddings 8080:8080
```

What the model reports about itself — dimensions and max input length:

```bash
curl -s localhost:8080/info | python3 -m json.tool
```

An embedding over the OpenAI route, which is what a consumer would use:

```bash
curl -s localhost:8080/v1/embeddings -H 'Content-Type: application/json' -d '{"model":"/models/bge-m3","input":["Belastungs-EKG unauffaellig","Ruhe-EKG ohne pathologischen Befund","Patient wuenscht Entlassung"]}' | python3 -c "import json,sys; d=json.load(sys.stdin); print('vectors:', len(d['data']), 'dims:', len(d['data'][0]['embedding']))"
```

For bge-m3 the answer is 1024 dimensions. Verified in `goreply/dev`: two clinically related sentences scored 0.75 against each other and 0.34 / 0.41 against an unrelated one. A useful sanity check beyond that: the
first two sentences should be markedly more similar to each other than either is
to the third.

---

## Query and document prefixes

Some embedding models are trained to treat a question and a document
differently. The RAG API drives both through one client and one URL, and TEI's
`/v1/embeddings` route has no per-request `prompt_name`, so it cannot express the
distinction.

| Model | Effect |
|---|---|
| BGE-M3 | Needs no prefixes at all — nothing to lose |
| Qwen3-Embedding | An instruction for queries is optional, but the model does not run on this backend anyway |
| EmbeddingGemma | Prefixes are **not** optional: `task: search result \| query: ` versus `title: none \| text: `. Using it through one endpoint means deliberately not using what it was trained with |
| E5 | Requires `query:` / `passage:` |

This is a secondary reason the default is bge-m3 rather than EmbeddingGemma; the
backend constraint above is the primary one, and it is why bge-m3 needing no
prefixes at all is worth more here than a model that would need them. If
the RAG API is later patched to use TEI's native `/embed` route with
`prompt_name` per call — a change in `go-reply-de/rag_api`, not here — the
picture changes and EmbeddingGemma becomes worth re-measuring.

## Isolation

`embeddings_offline = true` is the dev default, and it is what the sovereign
deployment will need unchanged. Three things together:

1. **Weights in the image.** `k8s/embeddings-image/Dockerfile` fetches them at
   build time; the kubelet pulls from Artifact Registry. The Pod itself never
   needs to reach the internet, which is what makes the egress policy possible
   rather than merely aspirational.
2. **`HF_HUB_OFFLINE=1`** and `MODEL_ID` as an in-image path, so no lookup is
   even attempted.
3. **`networkpolicy-embeddings.yaml`**, applied only when
   `_EMBEDDINGS_OFFLINE = 1` — against a Pod that still pulls from the hub it
   would break the next restart.

Verified from inside the Pod, before and after:

| Target | Before | After |
|---|---|---|
| `aiplatform.googleapis.com` | 404 (reachable) | blocked |
| `huggingface.co` | 200 | blocked |
| `storage.googleapis.com` | 400 (reachable) | blocked |
| `pkg.dev` | — | blocked |
| DNS `rag-dev-service` | resolves | resolves |

### The policy needs an `ipBlock`, not a `namespaceSelector`

The textbook rule — allow port 53 to namespace `kube-system` — **silently kills
all DNS** on this cluster. It runs NodeLocal DNSCache with Cloud DNS, so
`resolv.conf` points at `169.254.20.10`: a link-local address on the node, not a
Pod. No `namespaceSelector` can ever match it. The Pod stays `Running` and
nothing resolves.

The policy therefore allows `169.254.20.10/32` explicitly, and keeps the
`kube-system` rule as a fallback for clusters without NodeLocal DNSCache.

`policyTypes` is `Egress` only. Ingress stays open so the RAG API can reach the
service without a second policy change.

---

## Tuning

| Knob | Default | When to change |
|---|---|---|
| `embeddings_cpu` | `4` | Document ingestion throughput. Queries are single short texts and are never the bottleneck |
| `embeddings_memory` | `8Gi` | Rarely. The model is ~1.3 GB in float32 |
| `MAX_CLIENT_BATCH_SIZE` | `256` | Raise if a consumer sends larger batches. TEI's own default of 32 is below what batching clients send, which is why it is set here |
| `AUTO_TRUNCATE` | `true` | Leave on. Without it, any chunk beyond 2048 tokens is rejected instead of trimmed |
