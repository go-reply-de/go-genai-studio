# Self-hosted embedding model (EmbeddingGemma via TEI)

Runs EmbeddingGemma in the cluster so the RAG embeddings can eventually move off
Vertex AI. This is **step one of two**, and the split is deliberate:

| | |
|---|---|
| **This change** | The model runs and answers. Cheap, reversible, nothing depends on it. |
| **Next change** | The RAG API is repointed at it. Forces a re-index and makes existing documents unreachable. |

Keeping them apart means the model can be verified against real clinical text
before anything irreversible happens.

Currently enabled in `goreply/dev` only (project `go-de-genai-studio`). Everything else is untouched.

---

## Why it is not wired in yet

`EMBEDDINGS_PROVIDER` still says `vertexai`, and this change does not touch
`env.yaml` or `rag.yaml` at all. Repointing the RAG API means:

- A new `COLLECTION_NAME`. EmbeddingGemma and `text-embedding-004` both produce
  **768-dimensional** vectors, so pgvector would accept the mix without
  complaint and return meaningless similarity scores for every document embedded
  under the old model. A distinct collection is what prevents that.
- Consequently, documents embedded before the switch stop being retrievable and
  have to be re-uploaded.

Neither is a reason not to do it — they are reasons to do it as its own change,
with the model already proven.

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

Verified working: `MAX_BATCH_TOKENS=2048` with `16Gi`. At ~375 tokens per
1500-character chunk that is about five chunks per batch; TEI simply runs more
batches. Raise it only together with memory.

Both were changed together to get it running, so the actual floor is unknown —
`8Gi` with 2048 tokens may well be enough and would halve the pod. Worth one
experiment while nothing depends on the service.

## Enabling it

In the environment's `terragrunt.hcl`:

```hcl
embeddings_enabled = true
embeddings_model   = "BAAI/bge-m3"
embeddings_pooling = "cls"
embeddings_cpu     = 4
embeddings_memory  = "16Gi"
```

Then `make apply env=dev` and push to the trigger branch.

```bash
kubectl rollout status deployment/embeddings -n go-genai-studio-dev --timeout=15m
```

First start downloads ~2.3 GB of ONNX weights and Autopilot usually has to add a node for the request size, so allow ten minutes or so.

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
curl -s localhost:8080/v1/embeddings -H 'Content-Type: application/json' -d '{"model":"BAAI/bge-m3","input":["Belastungs-EKG unauffaellig","Ruhe-EKG ohne pathologischen Befund","Patient wuenscht Entlassung"]}' | python3 -c "import json,sys; d=json.load(sys.stdin); print('vectors:', len(d['data']), 'dims:', len(d['data'][0]['embedding']))"
```

For bge-m3 the answer is 1024 dimensions. Verified in `goreply/dev`: two clinically related sentences scored 0.75 against each other and 0.34 / 0.41 against an unrelated one. A useful sanity check beyond that: the
first two sentences should be markedly more similar to each other than either is
to the third.

---

## Query and document prefixes, relevant to step two

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

This is a secondary reason the default is bge-m3 rather than EmbeddingGemma; the backend constraint above is the primary one. If
the RAG API is later patched to use TEI's native `/embed` route with
`prompt_name` per call — a change in `go-reply-de/rag_api`, not here — the
picture changes and EmbeddingGemma becomes worth re-measuring.

## What changes for a cluster without egress

One thing, and it is contained: this pod pulls from huggingface.co at startup.
There is deliberately no `HF_HUB_OFFLINE` set. Moving to an environment without
egress means staging the weights into a bucket, gcsfuse-mounting them read-only,
pointing `embeddings_model` at the local path, and mirroring the TEI image into
Artifact Registry. The manifest is otherwise unchanged.

---

## Tuning

| Knob | Default | When to change |
|---|---|---|
| `embeddings_cpu` | `4` | Document ingestion throughput. Queries are single short texts and are never the bottleneck |
| `embeddings_memory` | `8Gi` | Rarely. The model is ~1.3 GB in float32 |
| `MAX_CLIENT_BATCH_SIZE` | `256` | Raise if a consumer sends larger batches. TEI's own default of 32 is below what batching clients send, which is why it is set here |
| `AUTO_TRUNCATE` | `true` | Leave on. Without it, any chunk beyond 2048 tokens is rejected instead of trimmed |
