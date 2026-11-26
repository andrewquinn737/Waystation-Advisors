#!/usr/bin/env python3
"""Load kb/<track>/*.md into ai_kb_docs (and optionally a personas JSON into ai_personas).
Usage: python3 load_kb.py [--test] [--personas file.json] [--only slug,slug]
--test uses dev_sb (TEST project). On the VM, SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are used."""
import argparse, json, os
import coachlib as cl
import retrain

KB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kb")
WEIGHT = {"calls_playbook": 3, "router": 2, "research": 0.5, "prompt": 1, "guide": 1, "deep": 1}


def kind_of(slug):
    if slug.startswith(("prompt_", "stage_rules_")): return "prompt"
    if slug.startswith("research_"): return "research"
    if slug.startswith("calls_playbook"): return "calls_playbook"
    if slug in ("router", "guide"): return slug
    return "deep"


def title_of(body, slug):
    first = next((l for l in body.splitlines() if l.startswith("#")), "")
    return first.lstrip("# ").strip()[:120] or slug.replace("_", " ")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--test", action="store_true"); ap.add_argument("--personas"); ap.add_argument("--only")
    a = ap.parse_args()
    if a.test:
        import dev_sb; sb = dev_sb.test_client()
    else:
        sb = cl.Sb(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    only = set(a.only.split(",")) if a.only else None
    n = 0
    for track in ("shared", "data", "ma"):
        d = os.path.join(KB, track)
        for f in sorted(os.listdir(d)):
            if not f.endswith(".md"): continue
            slug = f[:-3]
            if only and slug not in only: continue
            body = open(os.path.join(d, f)).read()
            k = kind_of(slug)
            v = retrain.save_doc(sb, track, slug, title_of(body, slug), body, k, WEIGHT[k])
            n += 1; print(f"{track}/{slug} v{v} ({k}, {len(body.split())} words)")
    if a.personas:
        rows = json.load(open(a.personas))
        retrain.upsert_personas(sb, rows)
        print("personas upserted:", len(rows))
    print("docs loaded:", n)


if __name__ == "__main__":
    main()
