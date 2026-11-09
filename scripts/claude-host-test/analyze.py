"""Compact timeline of a headless Claude Code run: tool calls, hook decisions, hook feedback, final text."""
import json, sys

def timeline(events, width=260):
    out = []
    for e in events:
        t, st = e.get("type"), e.get("subtype")
        if t == "system" and st == "hook_response":
            o = (e.get("output") or "").strip().replace("\n", " ")
            out.append(f"  HOOK {e.get('hook_name'):22} exit={e.get('exit_code')} outcome={e.get('outcome')} {o[:width]}")
        elif t == "assistant":
            for b in e.get("message", {}).get("content", []):
                if b.get("type") == "tool_use":
                    inp = json.dumps(b.get("input"))
                    out.append(f"CALL {b.get('name')} {inp[:width]}")
                elif b.get("type") == "text" and b.get("text", "").strip():
                    out.append(f"SAY  {b['text'].strip()[:width]}")
        elif t == "user":
            c = e.get("message", {}).get("content")
            if isinstance(c, list):
                for b in c:
                    if b.get("type") == "tool_result":
                        body = b.get("content")
                        if isinstance(body, list):
                            body = " ".join(x.get("text", "") for x in body if isinstance(x, dict))
                        out.append(f"  RESULT{' (error)' if b.get('is_error') else ''}: {str(body).strip()[:width]!r}")
        elif t == "result":
            out.append(f"DONE subtype={st} turns={e.get('num_turns')} cost=${e.get('total_cost_usd'):.4f} denials={len(e.get('permission_denials') or [])} :: {str(e.get('result'))[:width]}")
    return out

if __name__ == "__main__":
    ev = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
    print("\n".join(timeline(ev)))
