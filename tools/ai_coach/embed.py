"""Meaning-based matching for the turn bank: a small local sentence-embedding model (fastembed, BAAI/bge-small-en-v1.5,
CPU, no API). Bank vectors are computed once per bank and cached on disk next to the bank; a query is one encode.
If fastembed is not installed the bank falls back to TF-IDF only (paths.Bank), so nothing breaks."""
import hashlib, os

MODEL = os.environ.get("AI_COACH_EMBED_MODEL", "BAAI/bge-small-en-v1.5")
CACHE = os.environ.get("AI_COACH_BANK_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "bank"))
_m = None


def available():
    if os.environ.get("AI_COACH_EMBED", "1") == "0": return False
    try:
        import fastembed, numpy  # noqa: F401
        return True
    except ImportError:
        return False


def model():
    global _m
    if _m is None:
        from fastembed import TextEmbedding
        _m = TextEmbedding(MODEL)
    return _m


def encode(texts):
    import numpy as np
    v = np.array(list(model().embed([t or "" for t in texts])), dtype="float32")
    v /= (np.linalg.norm(v, axis=1, keepdims=True) + 1e-9)
    return v


def bank_matrix(track, texts):
    """Vectors for the bank's caller lines, cached by a hash of the lines."""
    import numpy as np
    h = hashlib.sha1(("\n".join(texts) + MODEL).encode()).hexdigest()[:12]
    p = os.path.join(CACHE, f"emb_{track}_{h}.npy")
    if os.path.exists(p): return np.load(p)
    m = encode(texts)
    os.makedirs(CACHE, exist_ok=True)
    np.save(p, m)
    return m
