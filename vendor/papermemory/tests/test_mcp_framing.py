import io
import json

from papermemory import mcp_server


def test_ndjson_initialize_roundtrip(monkeypatch):
    req = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}
    stdin = io.BytesIO((json.dumps(req) + "\n").encode("utf-8"))
    stdout = io.BytesIO()
    monkeypatch.setattr(mcp_server.sys, "stdin", type("S", (), {"buffer": stdin})())
    monkeypatch.setattr(mcp_server.sys, "stdout", type("S", (), {"buffer": stdout})())
    mcp_server._framing = "content-length"
    msg = mcp_server._read_message()
    assert msg["method"] == "initialize"
    assert mcp_server._framing == "ndjson"
    mcp_server._write_message({"jsonrpc": "2.0", "id": 1, "result": {"ok": True}})
    line = stdout.getvalue().decode("utf-8")
    assert line.startswith("{")
    assert "Content-Length" not in line
    assert json.loads(line)["result"]["ok"] is True


def test_content_length_still_roundtrips(monkeypatch):
    body = json.dumps({"jsonrpc": "2.0", "id": 2, "method": "ping"}).encode("utf-8")
    framed = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii") + body
    stdin = io.BytesIO(framed)
    stdout = io.BytesIO()
    monkeypatch.setattr(mcp_server.sys, "stdin", type("S", (), {"buffer": stdin})())
    monkeypatch.setattr(mcp_server.sys, "stdout", type("S", (), {"buffer": stdout})())
    mcp_server._framing = "content-length"
    msg = mcp_server._read_message()
    assert msg["method"] == "ping"
    assert mcp_server._framing == "content-length"
    mcp_server._write_message({"jsonrpc": "2.0", "id": 2, "result": {}})
    raw = stdout.getvalue()
    assert raw.startswith(b"Content-Length:")
