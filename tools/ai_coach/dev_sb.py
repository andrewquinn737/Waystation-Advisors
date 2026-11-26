"""Local-only: an Sb client for the TEST project (service role key via the Management API). Never points at LIVE."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "testenv"))
import sb as testenv
import coachlib as cl


def test_client():
    keys = testenv.test_api("/api-keys?reveal=true")
    key = next(k["api_key"] for k in keys if k.get("name") == "service_role")
    return cl.Sb(f"https://{testenv.TEST_REF}.supabase.co", key)


def claude_token():
    for line in open(os.path.expanduser("~/Projects/First Project/pipeline/.env")):
        if line.startswith("CLAUDE_CODE_OAUTH_TOKEN="): return line.split("=", 1)[1].strip().strip('"')
