const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const WhatsAppCore = require('../backend/core')

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liquid-cache-'))
  const core = new WhatsAppCore(dir)

  try {
    const jid = '12345@s.whatsapp.net'
    const messages = Array.from({ length: 101 }, (_, index) => ({
      key: {
        id: 'm-' + index,
        remoteJid: jid,
        fromMe: false
      },
      messageTimestamp: index + 1,
      message: {
        conversation: 'message ' + index
      }
    }))

    await core._onMessages({ messages, type: 'append' })

    const activeWindow = core.messageStore.get(jid)
    assert.strictEqual(activeWindow.length, 100)
    assert.strictEqual(activeWindow[0].id, 'm-1')
    assert.strictEqual(activeWindow[99].id, 'm-100')

    const rawWindow = core.rawMessages.get(jid)
    assert.strictEqual(rawWindow.size, 100)
    assert.strictEqual(rawWindow.has('m-0'), false)
    assert.strictEqual(rawWindow.has('m-100'), true)

    const persisted = core.localDb.list(jid, 200)
    assert.strictEqual(persisted.length, 101)
    assert.strictEqual(persisted[0].id, 'm-0')
    assert.strictEqual(persisted[100].id, 'm-100')
  } finally {
    core.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }

  console.log('Sliding message cache regression checks passed.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
