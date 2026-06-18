# -*- coding: utf-8 -*-
"""세션 트랜스크립트(.jsonl) → 읽기 쉬운 마크다운 채팅기록.
base64 이미지·시스템 주입 제거, 도구호출 요약, 추론(thinking) 일부만 발췌.
실행: python tools/export_chatlog.py   (또는 py -X utf8 tools/export_chatlog.py)
출력: docs/chat-logs/<날짜>_<세션8자>.md
"""
import json, glob, os

SRC = os.path.expanduser(
    r"~/.claude/projects/c--Users-user-Desktop-mini-motorcad-main")
OUT = "docs/chat-logs"
os.makedirs(OUT, exist_ok=True)


def trunc(s, n):
    s = s.replace("\r", " ")
    return s if len(s) <= n else s[:n] + " …"


def summ_result(rc):
    parts = []
    if isinstance(rc, list):
        for b in rc:
            if isinstance(b, dict):
                if b.get("type") == "image":
                    parts.append("[이미지]")
                elif b.get("type") == "text":
                    parts.append(b.get("text", ""))
            else:
                parts.append(str(b))
        s = " ".join(parts)
    else:
        s = str(rc)
    return trunc(s.replace("\n", " "), 300)


def convert(path):
    md, date = [], ""
    for ln in open(path, encoding="utf-8"):
        ln = ln.strip()
        if not ln:
            continue
        try:
            o = json.loads(ln)
        except Exception:
            continue
        if o.get("type") in ("queue-operation", "attachment", "summary", "system"):
            continue
        msg = o.get("message")
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        ts = str(o.get("timestamp", ""))[:19].replace("T", " ")
        if ts and not date:
            date = ts[:10]
        content = msg.get("content")
        if role == "user":
            texts, results = [], []
            if isinstance(content, str):
                texts.append(content)
            elif isinstance(content, list):
                for b in content:
                    if not isinstance(b, dict):
                        continue
                    if b.get("type") == "text":
                        texts.append(b.get("text", ""))
                    elif b.get("type") == "tool_result":
                        results.append(summ_result(b.get("content", "")))
            for tx in texts:
                tx = tx.strip()
                if (not tx or tx.startswith("<system-reminder")
                        or "SYSTEM NOTIFICATION" in tx or tx.startswith("Caveat:")):
                    continue
                md.append(f"\n---\n\n### 👤 사용자 · {ts}\n\n{tx}\n")
            for r in results:
                if r.strip():
                    md.append(f"<sub>↳ {r}</sub>\n")
        elif role == "assistant":
            buf = []
            if isinstance(content, list):
                for b in content:
                    if not isinstance(b, dict):
                        continue
                    bt = b.get("type")
                    if bt == "text" and b.get("text", "").strip():
                        buf.append(b["text"].strip())
                    elif bt == "thinking" and b.get("thinking", "").strip():
                        buf.append("> 💭 " + trunc(b["thinking"].strip().replace("\n", " "), 400))
                    elif bt == "tool_use":
                        nm = b.get("name", "")
                        inp = trunc(json.dumps(b.get("input", {}), ensure_ascii=False), 140)
                        buf.append(f"`🔧 {nm}` {inp}")
            if buf:
                md.append(f"\n### 🤖 Claude · {ts}\n\n" + "\n\n".join(buf) + "\n")
    return md, date


def main():
    for p in sorted(glob.glob(SRC + "/*.jsonl")):
        sid = os.path.basename(p)[:8]
        md, date = convert(p)
        if not md:
            continue
        fn = f"{OUT}/{date}_{sid}.md"
        hdr = (f"# 채팅기록 — {date} (세션 {sid})\n\n"
               "_mini-motorcad 작업 대화 로그. base64 이미지·시스템 메시지 제외, "
               "추론·도구결과는 요약. 원본 .jsonl 에서 tools/export_chatlog.py 로 재생성._\n")
        open(fn, "w", encoding="utf-8").write(hdr + "\n".join(md))
        print(f"{fn}  ({len(md)} 블록, {os.path.getsize(fn)//1024} KB)")


if __name__ == "__main__":
    main()
