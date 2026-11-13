# BOSS直聘 Chat API: scanning for new HR messages and loading context

This document describes the BOSS直聘 web API calls a job seeker (geek) account can use to:

1. Scan all conversations and queue the ones where the HR sent the last real message and you have not replied.
2. Load the latest N messages of each queued conversation as context for drafting a reply.

Source: mitmproxy capture of a real logged-in Chrome session on `www.zhipin.com/web/geek/chat`, taken on 2026-11-13. Every field below was seen in the captured responses unless it is listed under [Unverified](#unverified).

---

## 0. Authentication and common headers

All requests go to `https://www.zhipin.com` and authenticate with cookies. The login cookie is `wt2`:

```
Set-Cookie: wt2=<value>; Domain=.zhipin.com; Expires=<about 8 days after login>; Path=/; HttpOnly
```

Treat `wt2` like a password, since it grants full access to the account. Do not log it, put it in the renderer, or write it to disk unencrypted.

The browser sent these headers on every chat API call:

| Header | Value |
|---|---|
| `cookie` | `wt2=…` plus other site cookies (for example `__zp_stoken__`) |
| `referer` | `https://www.zhipin.com/web/geek/chat` |
| `origin` | `https://www.zhipin.com` (on POST requests) |
| `x-requested-with` | `XMLHttpRequest` |
| `accept` | `application/json, text/plain, */*` |
| `accept-language` | `zh-CN,zh;q=0.9` |
| `zp_token` | Set by page JavaScript after `POST /wapi/zppassport/set/zpToken`. Whether the API works without it is unverified. |
| `user-agent`, `sec-ch-ua*` | A desktop Chrome UA |

Every response has the shape `{"code": 0, "message": "Success", "zpData": {...}}`. Seen error code: `code: 7, "当前登录状态已失效"` (session expired; ask for a new `wt2`).

Login check: `GET /wapi/zpuser/wap/getUserInfo.json` returns `code 0` with user data when logged in, and `code 7` otherwise. Use it to validate a pasted `wt2` and to read your own uid (`myUid`).

---

## 1. Scan: find conversations that need a reply

### 1A. List contacts

```
GET /wapi/zprelation/friend/geekFilterByLabel?labelId=0&encryptSystemId=8cee15b718bda27e0Hx6
```

- `labelId=0` returns all contacts from the last 30 days (`foldText: "以上是30天内联系人"`). `labelId=-1` returned an empty list.
- `encryptSystemId` was the same on every captured call. Whether it is fixed per account or global is unverified.

Response `zpData`:

| Field | Meaning |
|---|---|
| `friendList[]` | Contacts (30 in the capture) |
| `friendList[].friendId` | HR numeric uid. Input for 1B. |
| `friendList[].encryptFriendId` | Encrypted HR id (same value as `encryptBossId` in 1B) |
| `friendList[].name`, `brandName`, `jobName`, `bossTitle`, `jobCity` | Display data |
| `friendList[].updateTime` | Last activity, in milliseconds |
| `filterBossIdList`, `filterEncryptIdList` | Filtered contacts |

### 1B. Get the last message of every conversation

```
POST /wapi/zprelation/friend/getGeekFriendList.json
Content-Type: application/x-www-form-urlencoded

friendIds=687377043,777573174,728964405,...
```

`friendIds` is the comma-separated `friendId` list from 1A, in the same order. The browser sent all 30 in one request. It also sends a single id when one conversation changes.

Response `zpData.result[]`, one per conversation:

| Field | Meaning |
|---|---|
| `uid` | HR numeric uid |
| `encryptBossId` | **`bossId` for step 2** |
| `securityId` | **`securityId` for step 2.** It changes between fetches, so always use the latest one. |
| `name`, `brandName`, `title`, `avatar` | Display data |
| `encryptJobId`, `jobId` | Job the conversation is about |
| `lastMsg` | Preview text of the last message (can be empty) |
| `lastMessageInfo.msgId` | Id of the last message |
| `lastMessageInfo.fromId` | **Sender of the last message**: equals `uid` for the HR, `myUid` for you |
| `lastMessageInfo.toId` | Receiver |
| `lastMessageInfo.showText` | Same as `lastMsg` |
| `lastMessageInfo.msgTime` / `lastTS` | Time of the last message, in milliseconds |
| `lastMessageInfo.status` | Not a reliable read flag (see [Read state](#read-state)) |
| `unreadMsgCount` | **Always 0 in the capture. Do not use it.** |

### 1C. Queue rule (stage 1, cheap)

A conversation is a **candidate** when:

```
lastMessageInfo.fromId == uid        // HR sent the last message
AND lastMessageInfo.msgId != lastHandledMsgId[uid]   // new since the last scan
```

Keep `lastHandledMsgId` per conversation so a conversation is queued once per new message. Push every candidate onto the queue. Step 2 then confirms each one.

In the capture, 19 of 30 conversations were candidates. Some of those were system texts that BOSS attributes to the HR, so stage 1 alone has false positives:

- `您的附件简历 …已发送给Boss…`
- `对方已同意，您的附件简历已发送给对方`
- `对方已查看了您的附件简历`
- A resume filename such as `xxx.pdf`
- An empty `lastMsg` (for example after a card or dialog message)

The friend list does not seem to count the 竞争者PK card as the last message. In conversations where the PK card came after your greeting, `fromId` still pointed to you.

---

## 2. Load context: latest N messages of a queued conversation

```
GET /wapi/zpchat/geek/historyMsg?bossId={encryptBossId}&maxMsgId=0&c={N}&page=1&src=0&securityId={securityId}
```

| Param | Meaning |
|---|---|
| `bossId` | `encryptBossId` from 1B |
| `securityId` | `securityId` from 1B (URL-encode it) |
| `c` | Page size, so N. The web page uses `20`. |
| `maxMsgId` | `0` means start from the newest message |
| `page` | `1` |
| `src` | `0` |

Response `zpData`:

| Field | Meaning |
|---|---|
| `messages[]` | Messages, **oldest first** |
| `hasMore` | More history exists |
| `minMsgId` | Smallest `mid` in this page |
| `type` | `1` in every capture |

Each message:

| Field | Meaning |
|---|---|
| `mid` | Message id (compare with `lastMessageInfo.msgId`) |
| `time` | Time, in milliseconds |
| `from.uid`, `from.name` | Sender. Equals `myUid` for you. |
| `to.uid` | Receiver |
| `type` | Outer type (1, 3 and 4 seen) |
| `body.type` | Content type, see below |
| `body.text` | Text when `body.type == 1` |
| `bizType` | Business subtype |
| `status` | `2` on every message after the chat was opened |

`body.type` values seen:

| `body.type` | Content | Real chat message? |
|---|---|---|
| `1` | Text in `body.text` (includes system texts such as `对方已查看了您的附件简历`) | Yes, after filtering system texts |
| `8` | Job card (`body.headTitle`: `您正在与Boss…直接沟通如下职位`, details in `body.jobDesc`) | No, but useful job context |
| `16` | 竞争者PK card. Attributed to the HR and often arrives right after your greeting. | No |
| `4` | Action (for example resume exchange request/accept) | No |
| `7` | Dialog | No |
| `12` | Hyperlink / notice | No |

Image, voice, and other types did not appear in the capture.

### 2A. Confirm rule (stage 2)

1. Keep messages with `body.type == 1`.
2. Drop known system texts (the list in 1C, matched by pattern).
3. Take the last remaining message. If `from.uid != myUid`, the conversation **needs a reply**. Otherwise drop it from the queue (you already replied, or the HR only produced system events).
4. Use the last N filtered messages as LLM context, labelled `HR` / `ME`. The `body.type == 8` job card gives the job title, salary, city and company.

Example from the capture (李女士 / 上海万宝盛华信息科技):

```
09:34:33 ME  您好，熟练python后端,有企业agent开发和项目落地，有机会进一步沟通吗
09:34:33 HR  [bodyType 16: 竞争者PK card]          → skip
09:35:59 HR  [hi] 你好啊，可以聊一聊~
09:36:02 HR  [bodyType 7: dialog]                  → skip
09:50:09 ME  [bodyType 4: exchange accept]         → skip
09:50:16 HR  对方已查看了您的附件简历               → skip (system text)
09:50:52 HR  目前是在职吗？                         → last real message from HR → needs reply
```

---

## 3. Full scan flow

```
every <interval> minutes (minutes, not seconds):
  1A  GET  geekFilterByLabel?labelId=0          → friendIds
  1B  POST getGeekFriendList.json (friendIds)   → lastMessageInfo per conversation
  1C  candidates = fromId == uid AND msgId changed
      if no candidates: stop (2 requests in total)
  for each candidate in queue:
  2   GET  historyMsg?bossId&securityId&c=N     → messages
  2A  last real text message from HR? → needs reply → draft with LLM context
      record lastHandledMsgId[uid] = lastMessageInfo.msgId
```

Request cost per scan: 2 requests when nothing changed, plus 1 `historyMsg` per new candidate.

---

## Read state

- No call I observed returns a reliable unread flag. `unreadMsgCount` was always 0, and `lastMessageInfo.status` was 0 both before and after the chat was opened.
- The friend list (1B) returns the last message of a conversation **without opening it**. 李女士's reply showed up in 1B at 09:38, before the chat was opened at 09:50.
- When the browser opens a chat, it calls more than `historyMsg`:
  - `GET  /wapi/zpchat/geek/getBossData`
  - `POST /wapi/zpchat/session/geekEnter` (body: `jobSource=0&k810=0&securityId=…`)
  - The chat page also connects to the websocket at `ws6.zhipin.com/chatws` (configured through `GET /wapi/zpchat/config/ws`)
- **Unverified:** whether calling only `historyMsg`, without `geekEnter` or the websocket, marks messages as read or tells the HR they were read. To test: when a new HR message arrives, call only `historyMsg` for that chat, then check in the BOSS app whether it still shows as unread.

---

## Unverified

- Whether requests work without the `zp_token` header.
- Whether `encryptSystemId=8cee15b718bda27e0Hx6` is fixed.
- Paging older history. It is probably `maxMsgId={minMsgId}`, but every captured conversation had `hasMore=false`.
- Contacts older than 30 days (the `foldText` boundary).
- Image, voice and other `body.type` values.
- Whether `historyMsg` alone triggers a read receipt (see [Read state](#read-state)).

## Other endpoints seen on the chat page (not needed for the scan)

`/wapi/zpmsg/history/pull`, `/wapi/zpchat/message/refresh`, `/wapi/zpchat/notify/setting/get`, `/wapi/zpchat/config/get`, `/wapi/zpchat/exchange/testAccept`, `/wapi/zpchat/exchange/accept`, `/wapi/zpgeek/friend/add.json` (starts a new chat from a job; never call it from a scanner).

---

## Implementation (消息预警)

This flow is implemented in the desktop app as the read-only **消息预警** page (route key `autochat`):

| Piece | File |
|---|---|
| Main-process API: `wt2` vault (`safeStorage`), in-memory Chromium session, the 4 read-only calls | `desktop-app/electron/bossChatApi.cjs` |
| Two-stage detection rules (pure functions) | `desktop-app/src/lib/bossclaw/chatAlert.ts` |
| One scan cycle (scan → history → LLM draft → cards) | `desktop-app/src/lib/bossclaw/alertCycle.ts` |
| Timer, persistence, tray count | `desktop-app/src/store/useMessageAlertStore.ts` |
| Tray flashing | `desktop-app/electron/alertFlash.cjs` |
| Page | `desktop-app/src/pages/MessageAlert.tsx` |

Verified in a real Electron main process (Chromium 148, non-persistent partition): `getUserInfo` → `geekFilterByLabel` → `getGeekFriendList.json` succeed with only the `wt2` cookie; the same session reports HTTP/2, JA4 `t13d1516h2_8daaf6152771_…`, Akamai `52d84b11…`. `historyMsg` is called only for conversations whose last message id changed, at most 10 per cycle with a 1.5–3.5 s gap.

Offline tests: `npm run test:message-alert` (in `desktop-app/`). Live check against a real account: `python test/test_boss_chat_api.py`.
