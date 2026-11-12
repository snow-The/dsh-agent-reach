# dsh-agent-reach

把 [Agent Reach](https://github.com/Panniantong/Agent-Reach) 接成 DSH 原生工具。
上游是一個**只讀**的多平台觸達 CLI（MIT）：B站、小紅書、X、Reddit、YouTube、GitHub、V2EX、雪球、
LinkedIn、Boss 直聘、小宇宙，外加 Exa/Jina 的網頁搜尋與讀取。

## 為什麼要有這一層

不讓 agent 直接跑 shell，有三個理由，每一個都是實測出來的：

1. **體積**：CLI 一次輸出的 JSON 很大（`agent-reach channels` 一份就 15 KB，帶正文的結果到 30 KB）。
   這層把它壓成 `{title,url,author,published_at,text}`，正文預設截到 600 字並標 `text_truncated`，
   `raw` 預設不帶。呼叫端要全文就傳 `text_chars`。
2. **參數會拼錯**：CLI 的參數是 schema 定的（必填的放位置，其餘 `--flag`）。這層從
   `agent-reach channels` 反推 argv——呼叫端寫 `{channel:'bilibili', action:'search', query:'大模型', limit:3}`，
   就變成 `bilibili search 大模型 --limit 3`。**參數名寫錯時回一份合法清單，不猜。**
3. **誠實性**：上游每個結果都帶 `meta.attempts`（每條後端各自 `ok` / `NEED_LOGIN` / `UPSTREAM_BROKEN`…）。
   那是「哪條路真的回答了」的唯一證據，所以 `backends_tried` **永遠原樣回報**，不壓成一個 boolean。

## 工具

| 工具 | 用途 |
|---|---|
| `reach_channels` | 有哪些平台、每個動作吃什麼參數、後端順序。**不確定就先跑這個。** |
| `reach` | `{channel, action, ...參數}` 呼叫任一動作（search / read / hot / subtitle / quote …） |
| `reach_read` | 給網址，自動照網域選平台讀正文（網頁走 Jina，失敗換 Exa） |

## 錯誤碼（照 hint 做，不要換帳號或硬試）

`NEED_SETUP`（缺依賴/密鑰）、`NEED_LOGIN`、`UPSTREAM_BROKEN`、`TIMEOUT`、`RATE_LIMITED`、
`PLATFORM_BLOCKED`、`BUSY`、`NOT_FOUND`、`BAD_INPUT`。

**`NEED_LOGIN` 不等於沒有內容。** 上游在這件事上特別小心，例如 B站字幕：未登入 → `NEED_LOGIN`；
已登入但上游回 `subtitle_unavailable` → `UPSTREAM_BROKEN`，且訊息明說「這不證明該影片沒有字幕」。
不要把它們混成「沒有」。

## 安裝

```bash
uv tool install https://github.com/Panniantong/Agent-Reach/releases/latest/download/agent-reach.zip
agent-reach add bilibili        # 裝該渠道的私有工具（bili-cli）
```

⚠️ **PyPI 上叫 `agent-reach` 的包不是本專案**，只能從上面的 GitHub 位址裝。

這台機器的狀態（2026-11-07）：1.6.1 / uv、`bilibili` 已加（bili-cli 0.6.2）、
B站 search+hot+read 實測可用；`subtitle` 需要使用者本人 `agent-reach login bilibili` 掃碼。
`web search` 走 Exa、`web read` 走 Jina，兩者實測可用。

## 邊界

- **只讀**：不發帖、不評論、不點讚、不私信。這一層不繞過上游紅線。
- 上游會為需要登入的平台開一個**專用**瀏覽器，第一次使用時可能從你的 Chrome 複製該站登入
  （只複製那一個站，不動原瀏覽器、不讀密碼庫）。建議用小號。
- 環境變數 `DSH_AGENT_REACH_EXE` 可指定 exe 路徑；預設找 `~/.local/bin/agent-reach.exe`。

## 測試

```bash
node --test test/*.test.mjs
```

12 個測試：argv 組裝（含三個必須拋錯的負面案例）、`shape` 的截斷與證據鏈保留、
以及**兩個打真 CLI 的冒煙測試**（CLI 不存在時會明說 SKIP，不算通過）。
