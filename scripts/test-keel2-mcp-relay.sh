#!/usr/bin/env bash
# keel2 mcp's relay (0.18.51): the MCP server ends when keel restarts; the relay starts it again, repeats the client's
# initialize, and answers the call that was waiting. A fake server (it ends after its 2nd tools/call, like a keel
# restart) and a fake docker (`docker inspect` says the container runs) stand in; no real keel or docker is used.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
awk "/^MCP_RELAY_PY='/{f=1;next} f&&/^'\$/{exit} f" "$here/keel2" > "$tmp/relay.py"
[ -s "$tmp/relay.py" ] || { echo "FAIL: no relay in keel2"; exit 1; }
grep -q 'exec python3 -c "$MCP_RELAY_PY"' "$here/keel2" || { echo "FAIL: keel2 mcp does not use the relay"; exit 1; }
mkdir -p "$tmp/bin"
cat > "$tmp/bin/docker" <<'D'
#!/usr/bin/env bash
[ "$1" = inspect ] && { echo true; exit 0; }
exit 1
D
cat > "$tmp/server.py" <<'S'
import json, sys, os
count_file = sys.argv[1]
starts = int(open(count_file).read() or 0) + 1 if os.path.exists(count_file) else 1
open(count_file, "w").write(str(starts))
calls = 0
for line in sys.stdin:
    m = json.loads(line)
    if m.get("method") == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": {"serverInfo": {"name": "fake", "start": starts}}}), flush=True)
    elif m.get("method") == "tools/call":
        calls += 1
        if starts == 1 and calls == 2:
            sys.exit(0)          # keel restarts before this call is answered
        print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": {"start": starts, "n": m["params"]["n"]}}), flush=True)
S
chmod +x "$tmp/bin/docker"
python3 - "$tmp" <<'P'
import json, subprocess, sys, time, os
tmp = sys.argv[1]
env = dict(os.environ, PATH=tmp + "/bin:" + os.environ["PATH"])
p = subprocess.Popen(["python3", tmp + "/relay.py", "keel-test", "python3", tmp + "/server.py", tmp + "/starts"],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env)
def send(m): p.stdin.write(json.dumps(m) + "\n"); p.stdin.flush()
def recv(): return json.loads(p.stdout.readline())
send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}})
assert recv()["result"]["serverInfo"]["start"] == 1
send({"jsonrpc": "2.0", "method": "notifications/initialized"})
send({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"n": 1}})
r = recv(); assert r["id"] == 2 and r["result"]["start"] == 1, r
send({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"n": 2}})   # the server ends here
r = recv(); assert r["id"] == 3 and r["result"] == {"start": 2, "n": 2}, r       # answered by the restarted server
send({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"n": 3}})
r = recv(); assert r["id"] == 4 and r["result"]["start"] == 2, r
assert open(tmp + "/starts").read() == "2"
p.stdin.close(); p.wait(timeout=10)
print("ok   a call during a keel restart is answered by the restarted server (initialize repeated)")
P
# keel stays down: the waiting call gets an error, not silence
cat > "$tmp/bin/docker" <<'D'
#!/usr/bin/env bash
[ "$1" = inspect ] && { echo false; exit 0; }
exit 1
D
rm -f "$tmp/starts"
python3 - "$tmp" <<'P'
import json, subprocess, sys, os
tmp = sys.argv[1]
env = dict(os.environ, PATH=tmp + "/bin:" + os.environ["PATH"], KEEL_MCP_RELAY_WAIT="3")
p = subprocess.Popen(["python3", tmp + "/relay.py", "keel-test", "python3", tmp + "/server.py", tmp + "/starts"],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env)
def send(m): p.stdin.write(json.dumps(m) + "\n"); p.stdin.flush()
def recv(): return json.loads(p.stdout.readline())
send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}); recv()
send({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"n": 1}}); recv()
send({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"n": 2}})   # the server ends; keel does not come back
r = recv(); assert r["id"] == 3 and r["error"]["code"] == -32000 and "restarting" in r["error"]["message"], r
p.stdin.close(); p.wait(timeout=10)
print("ok   keel stays down: the waiting call gets a clear error instead of no answer")
P
echo "all mcp relay checks passed"
