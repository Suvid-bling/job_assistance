"""Live check of the BOSS直聘 chat API flow in doc/boss_chatapi.md, sent with a Chrome TLS/HTTP2 fingerprint.

Checks two jobs:
  1. Scan all conversations and queue the ones where the HR sent the last real message
     and you have not replied.
  2. Load the latest N messages of each queued conversation as reply context.

Requests go through curl_cffi, which impersonates Chrome's TLS ClientHello (JA3/JA4) and
HTTP/2 settings, and sends the matching Chrome User-Agent / sec-ch-ua headers.

Read-only: it calls geekFilterByLabel, getGeekFriendList and historyMsg only. It never calls
session/geekEnter, friend/add or any send endpoint. Whether historyMsg alone marks messages as
read is unverified (see doc), so job 2 is limited to BOSS_MAX_CHATS conversations.

Usage (PowerShell):
  pip install curl_cffi
  $env:BOSS_WT2 = "<wt2 cookie value>"      # never commit it
  python test/test_boss_chat_api.py

Optional env: BOSS_N (messages per chat, default 10), BOSS_MAX_CHATS (default 3, 0 = all),
BOSS_FP_CHECK=1 (also print the fingerprint seen by tls.peet.ws).

Full untruncated messages are written to test/output/scan-<time>.md and .json
(git-ignored: they contain personal chat data).
"""
from __future__ import annotations

import json
import os
import random
import re
import time
import unittest

try:
    from curl_cffi import requests as cffi
except ImportError:  # pragma: no cover
    cffi = None

BASE = "https://www.zhipin.com"
IMPERSONATE = "chrome"  # newest Chrome profile shipped with curl_cffi
ENCRYPT_SYSTEM_ID = "8cee15b718bda27e0Hx6"
CHROME_JA4_RE = r"^t13d151[67]h2_8daaf6152771_"

# Text messages that BOSS attributes to the HR but are system events, not real HR messages.
SYSTEM_TEXT_RE = re.compile(
    r"附件简历|对方已同意|对方已查看|已发送给Boss|已发送给对方|请求交换|交换(微信|电话|简历)"
    r"|^\S+\.(pdf|docx?|png|jpe?g)$",
    re.IGNORECASE,
)


def is_real_text(msg: dict) -> bool:
    body = msg.get("body") or {}
    text = str(body.get("text") or "").strip()
    return body.get("type") == 1 and bool(text) and not SYSTEM_TEXT_RE.search(text)


def pause() -> None:
    time.sleep(random.uniform(1.5, 3.5))


@unittest.skipIf(cffi is None, "curl_cffi not installed: pip install curl_cffi")
@unittest.skipUnless(os.environ.get("BOSS_WT2"), "set BOSS_WT2 to run the live BOSS check")
class BossChatApiLive(unittest.TestCase):
    session = None
    my_uid = None
    queue: list[dict] = []

    @classmethod
    def setUpClass(cls):
        s = cffi.Session(impersonate=IMPERSONATE)
        s.cookies.set("wt2", os.environ["BOSS_WT2"].strip(), domain=".zhipin.com", path="/")
        s.headers.update({
            "accept": "application/json, text/plain, */*",
            "accept-language": "zh-CN,zh;q=0.9",
            "referer": f"{BASE}/web/geek/chat",
            "x-requested-with": "XMLHttpRequest",
        })
        cls.session = s
        cls.n = int(os.environ.get("BOSS_N", "10"))
        cls.max_chats = int(os.environ.get("BOSS_MAX_CHATS", "3"))

    @classmethod
    def tearDownClass(cls):
        if REPORT["chats"]:
            write_report(cls.my_uid)

    # ---- helpers -------------------------------------------------------------
    def api(self, method: str, path: str, **kw) -> dict:
        r = self.session.request(method, BASE + path, timeout=20, **kw)
        self.assertEqual(r.status_code, 200, f"{path}: HTTP {r.status_code}")
        print(f"    {method} {path.split('?')[0]} -> HTTP {r.status_code} (curl http_version={r.http_version})")
        data = r.json()
        self.assertEqual(data.get("code"), 0, f"{path}: code={data.get('code')} message={data.get('message')}")
        return data.get("zpData") or {}

    # ---- 0. fingerprint + login ---------------------------------------------
    def test_0_fingerprint_and_login(self):
        if os.environ.get("BOSS_FP_CHECK") == "1":
            fp = self.session.get("https://tls.peet.ws/api/all", timeout=20).json()
            ja4 = fp.get("tls", {}).get("ja4", "")
            print(f"\n    fingerprint: http={fp.get('http_version')} ja4={ja4} "
                  f"akamai={fp.get('http2', {}).get('akamai_fingerprint_hash', '')}")
            print(f"    user-agent: {fp.get('user_agent')}")
            # Chrome: TLS 1.3, 15 ciphers, 16-17 extensions (varies by version), h2, Chrome cipher hash
            self.assertRegex(ja4, CHROME_JA4_RE, f"JA4 {ja4} does not look like desktop Chrome")
            self.assertEqual(fp.get("http_version"), "h2")

        user = self.api("GET", "/wapi/zpuser/wap/getUserInfo.json")
        type(self).my_uid = user.get("userId")
        self.assertTrue(self.my_uid, "getUserInfo returned no userId")
        print(f"    logged in as uid={self.my_uid} name={user.get('name')}")

    # ---- 1. scan + queue -----------------------------------------------------
    def test_1_scan_and_queue(self):
        if not self.my_uid:
            self.skipTest("login failed")
        pause()
        contacts = self.api("GET", f"/wapi/zprelation/friend/geekFilterByLabel?labelId=0"
                                   f"&encryptSystemId={ENCRYPT_SYSTEM_ID}")
        friend_ids = [f["friendId"] for f in contacts.get("friendList") or []]
        print(f"    contacts: {len(friend_ids)}")
        self.assertTrue(friend_ids, "no contacts returned")

        pause()
        result = self.api("POST", "/wapi/zprelation/friend/getGeekFriendList.json",
                          data={"friendIds": ",".join(map(str, friend_ids))}).get("result") or []
        self.assertTrue(result, "getGeekFriendList returned no conversations")

        queue = []
        for c in result:
            last = c.get("lastMessageInfo") or {}
            for key in ("uid", "encryptBossId", "securityId"):
                self.assertIn(key, c)
            hr_last = last.get("fromId") == c["uid"]
            print(f"    {'QUEUE' if hr_last else '     '} {c.get('name')} | {c.get('brandName')} | "
                  f"{'HR' if hr_last else 'ME'}: {str(c.get('lastMsg') or '')[:30]!r}")
            if hr_last:
                queue.append(c)
        type(self).queue = queue
        print(f"    stage-1 queue: {len(queue)} of {len(result)} conversations")

    # ---- 2. context ----------------------------------------------------------
    def test_2_load_context(self):
        if not self.queue:
            self.skipTest("queue is empty")
        chats = self.queue if self.max_chats <= 0 else self.queue[: self.max_chats]
        incomplete = []
        for c in chats:
            pause()
            z = self.api("GET", "/wapi/zpchat/geek/historyMsg", params={
                "bossId": c["encryptBossId"], "maxMsgId": 0, "c": self.n,
                "page": 1, "src": 0, "securityId": c["securityId"],
            })
            msgs = z.get("messages") or []
            self.assertIsInstance(msgs, list)
            real = [m for m in msgs if is_real_text(m)]
            verdict = bool(real) and real[-1]["from"]["uid"] != self.my_uid
            last_info = c.get("lastMessageInfo") or {}
            newest_mid = max((m.get("mid", 0) for m in msgs), default=0)
            # Completeness: history must contain the message the friend list reported as last.
            has_last = any(m.get("mid") == last_info.get("msgId") for m in msgs)
            if not has_last:
                incomplete.append(c.get("name"))
            REPORT["chats"].append({
                "name": c.get("name"), "company": c.get("brandName"), "title": c.get("title"),
                "list_last_msg_id": last_info.get("msgId"), "list_last_text": c.get("lastMsg"),
                "history_newest_mid": newest_mid, "history_contains_list_last": has_last,
                "has_more": z.get("hasMore"), "total_msgs": len(msgs), "real_msgs": len(real),
                "needs_reply": verdict,
                "messages": [{
                    "mid": m.get("mid"),
                    "time": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(m["time"] / 1000)),
                    "from": "ME" if m["from"]["uid"] == self.my_uid else "HR",
                    "body_type": (m.get("body") or {}).get("type"),
                    "real": is_real_text(m),
                    "text": (m.get("body") or {}).get("text")
                            or (m.get("body") or {}).get("headTitle") or "",
                } for m in msgs],
            })
            print(f"    {c.get('name')} | {c.get('brandName')}: {len(msgs)} msgs, {len(real)} real, "
                  f"contains last={has_last} -> {'NEEDS REPLY' if verdict else 'no reply needed'}")
        self.assertFalse(incomplete, f"history missing the friend-list last message for: {incomplete}")


REPORT: dict = {"chats": []}


def write_report(my_uid) -> None:
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
    os.makedirs(out, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    REPORT["generated"] = time.strftime("%Y-%m-%d %H:%M:%S")
    REPORT["my_uid"] = my_uid
    with open(os.path.join(out, f"scan-{stamp}.json"), "w", encoding="utf-8") as f:
        json.dump(REPORT, f, ensure_ascii=False, indent=2)
    lines = [f"# BOSS chat scan {REPORT['generated']}", ""]
    chats = REPORT["chats"]
    lines += [f"Queued and loaded: {len(chats)}. Needs reply: {sum(c['needs_reply'] for c in chats)}.", ""]
    for c in chats:
        lines += [f"## {'🔴 NEEDS REPLY' if c['needs_reply'] else '⚪ no reply needed'}: "
                  f"{c['name']} | {c['company']} | {c['title'] or ''}",
                  f"- messages: {c['total_msgs']} (real {c['real_msgs']}), hasMore={c['has_more']}",
                  f"- friend-list last msgId {c['list_last_msg_id']} found in history: "
                  f"{c['history_contains_list_last']}", ""]
        for m in c["messages"]:
            tag = "" if m["real"] else f" _(skipped: body.type {m['body_type']})_"
            text = (m["text"] or "").replace("\n", "\n> ")
            lines += [f"**{m['time']} {m['from']}**{tag}", f"> {text}" if text else "> (no text)", ""]
    with open(os.path.join(out, f"scan-{stamp}.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"\n    report: {out}\\scan-{stamp}.md / .json")


if __name__ == "__main__":
    unittest.main(verbosity=2)
