const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const integrity = require('../backend/integrity')

assert.strictEqual(
  integrity.findAppBundlePath('/private/var/folders/a/b/T/AppTranslocation/UUID/d/Liquid WhatsApp.app/Contents/Resources/app.asar'),
  '/private/var/folders/a/b/T/AppTranslocation/UUID/d/Liquid WhatsApp.app'
)

assert.strictEqual(
  integrity.detectRuntimePath('/private/var/folders/a/b/T/AppTranslocation/UUID/d/Liquid WhatsApp.app/Contents/Resources/app.asar').appTranslocation,
  true
)

assert.strictEqual(
  integrity.detectRuntimePath('/private/var/folders/a/b/T/Liquid WhatsApp.app/Contents/Resources/app.asar').privateVarFolders,
  true
)

assert.strictEqual(integrity.equalHex('a'.repeat(64), 'a'.repeat(64)), true)
assert.strictEqual(integrity.equalHex('a'.repeat(64), 'b'.repeat(64)), false)

assert.strictEqual(
  integrity.shouldBlock({
    packaged: true,
    platform: 'darwin',
    payload: { status: 'breached' }
  }),
  true
)

for (const status of ['valid', 'unanchored', 'missing', 'unknown', 'development']) {
  assert.strictEqual(
    integrity.shouldBlock({
      packaged: true,
      platform: 'darwin',
      payload: { status }
    }),
    false
  )
}

assert.strictEqual(
  integrity.shouldBlock({
    packaged: true,
    platform: 'darwin',
    payload: { status: 'valid' },
    signature: { status: 'ad-hoc-translocated' }
  }),
  false
)

console.log('Integrity regression checks passed.')


const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liquid-asar-'))
try {
  const header = Buffer.from(JSON.stringify({ files: { 'main.js': { size: 3, offset: '0' } } }), 'utf8')
  const prefix = Buffer.alloc(16)
  prefix.writeUInt32LE(8 + header.length, 4)
  prefix.writeUInt32LE(header.length, 12)
  const asarPath = path.join(tempDir, 'app.asar')
  fs.writeFileSync(asarPath, Buffer.concat([prefix, header, Buffer.from('abc')]))

  const parsed = integrity.parseAsarHeader(asarPath)
  const expected = crypto.createHash('sha256').update(header).digest('hex')
  const anchor = integrity.validateHeaderAnchor(parsed.headerBuffer, expected)

  assert.strictEqual(anchor.matches, true)
  assert.strictEqual(anchor.actualHash, expected)
  assert.strictEqual(parsed.dataOffset, 8 + 8 + header.length)
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true })
}
