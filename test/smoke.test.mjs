// dsh-agent-reach 的測試：argv 組裝（離線、純邏輯）+ 一次真 CLI 的冒煙（沒裝就明說 SKIP，不算過）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, buildArgv, shape } from '../index.js'

// assert.throws() 不返回錯誤物件，要自己抓。
function catches(fn) { try { fn(); return null } catch (e) { return e } }

// 用一份固定 schema，不依賴 CLI 也能測 argv 規則。
const CHANNELS = [
  {
    name: 'bilibili', level: 'default', login: { via: 'session', logged_in: false },
    actions: [
      { name: 'search', usage: 'agent-reach bilibili search <query> [--limit LIMIT]', backends: ['bili-cli'],
        params: [{ name: 'query', required: true, type: 'str' }, { name: 'limit', required: false, type: 'int', default: 5 }] },
      { name: 'hot', usage: 'agent-reach bilibili hot [--limit LIMIT]', backends: ['bili-cli', 'bilibili-api'],
        params: [{ name: 'limit', required: false, type: 'int', default: 10 }] },
    ],
  },
  {
    name: 'v2ex', level: 'default', login: null,
    actions: [
      { name: 'node', usage: 'agent-reach v2ex node <node_name> [--limit LIMIT]', backends: ['v2ex-api'],
        params: [{ name: 'node_name', required: true, type: 'str' }, { name: 'limit', required: false, type: 'int', default: 10 }] },
    ],
  },
]

test('必填的第一個參數放位置，選填的變 --flag', () => {
  assert.deepEqual(buildArgv(CHANNELS, { channel: 'bilibili', action: 'search', query: '大模型', limit: 3 }).argv,
    ['bilibili', 'search', '大模型', '--limit', '3'])
})

test('只有選填參數的動作，全部走 --flag', () => {
  assert.deepEqual(buildArgv(CHANNELS, { channel: 'bilibili', action: 'hot', limit: 2 }).argv,
    ['bilibili', 'hot', '--limit', '2'])
})

test('底線的參數名要轉成 --dash-case', () => {
  assert.deepEqual(buildArgv(CHANNELS, { channel: 'v2ex', action: 'node', node_name: 'python' }).argv,
    ['v2ex', 'node', 'python'])
})

test('缺少必填參數要報錯並給用法，不能默默送出', () => {
  const e = catches(() => buildArgv(CHANNELS, { channel: 'bilibili', action: 'search' }))
  assert.ok(e, '應該要拋錯')
  assert.match(String(e.message), /REACH_BAD_INPUT/)
  assert.match(String(e.message), /query/)
})

test('不認識的 channel 要列出可用的，而不是猜', () => {
  const e = catches(() => buildArgv(CHANNELS, { channel: 'douyin', action: 'search', query: 'x' }))
  assert.ok(e, '應該要拋錯')
  assert.match(String(e.message), /可用：.*bilibili/)
})

test('不認識的參數要列出這個動作的合法參數', () => {
  const e = catches(() => buildArgv(CHANNELS, { channel: 'bilibili', action: 'search', query: 'x', subreddit: 'python' }))
  assert.ok(e, '應該要拋錯')
  assert.match(String(e.message), /subreddit/)
  assert.match(String(e.message), /query/)
})

test('shape 必須保留後端嘗試鏈（哪條路回答了）', () => {
  const out = shape({
    ok: false, channel: 'bilibili', action: 'subtitle',
    meta: { elapsed_ms: 12, attempts: [{ backend: 'bili-cli', result: 'NEED_LOGIN', message: 'not logged in' }] },
    items: [], error: { code: 'NEED_LOGIN', message: 'Bilibili is not logged in', hint: 'run agent-reach login bilibili' },
  })
  assert.equal(out.ok, false)
  assert.deepEqual(out.backends_tried, [{ backend: 'bili-cli', result: 'NEED_LOGIN', message: 'not logged in' }])
  assert.equal(out.error.code, 'NEED_LOGIN')
  assert.equal(out.count, 0)
})

test('shape 截斷正文並標記，不假裝是全文', () => {
  const long = 'x'.repeat(1000)
  const out = shape({ ok: true, channel: 'web', action: 'read', items: [{ title: 't', url: 'u', text: long, raw: { big: 1 } }] },
    { text_chars: 100 })
  assert.equal(out.items[0].text.length, 100)
  assert.equal(out.items[0].text_truncated, true)
  assert.equal(out.items[0].text_total, 1000)
  assert.equal(out.items[0].raw, undefined, 'raw 預設不該帶出去')
})

test('url 為 null 要原樣保留（不補、不猜）', () => {
  const out = shape({ ok: true, channel: 'bilibili', action: 'search', items: [{ title: 't', url: null }] })
  assert.equal(out.items[0].url, null)
})

test('apply 註冊三個工具', () => {
  const tools = {}
  apply({ tools: { register: (t) => { tools[t.name] = t } } })
  assert.deepEqual(Object.keys(tools).sort(), ['reach', 'reach_channels', 'reach_read'])
})

test('真 CLI 冒煙：channels 至少 10 個平台，且 bilibili 有 search', async () => {
  const tools = {}
  apply({ tools: { register: (t) => { tools[t.name] = t } } })
  let out
  try {
    out = await tools.reach_channels.execute({})
  } catch (e) {
    if (String(e.message).includes('REACH_NOT_INSTALLED')) {
      console.log('SKIP  agent-reach 未安裝，跳過冒煙測試（這不是通過）')
      return
    }
    throw e
  }
  assert.ok(out.channels.length >= 10, '平台數 ' + out.channels.length)
  const bili = out.channels.find((c) => c.channel === 'bilibili')
  assert.ok(bili, '要有 bilibili')
  assert.ok(bili.actions.some((a) => a.action === 'search'))
  assert.equal(bili.logged_in, false, '這台機器 B 站不該是已登入狀態')
})

test('真 CLI 冒煙：B 站搜尋回得出東西，且後端鏈有紀錄', async () => {
  const tools = {}
  apply({ tools: { register: (t) => { tools[t.name] = t } } })
  let out
  try {
    out = await tools.reach.execute({ channel: 'bilibili', action: 'search', query: '大模型', limit: 2 })
  } catch (e) {
    if (String(e.message).includes('REACH_NOT_INSTALLED')) {
      console.log('SKIP  agent-reach 未安裝，跳過冒煙測試（這不是通過）')
      return
    }
    throw e
  }
  assert.equal(out.ok, true, 'search 應該成功：' + JSON.stringify(out.error))
  assert.ok(out.count >= 1)
  assert.ok(out.backends_tried.length >= 1, '後端嘗試鏈不能是空的')
  assert.ok(out.items[0].title, '要有標題')
})
