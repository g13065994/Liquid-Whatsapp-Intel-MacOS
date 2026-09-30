const assert = require('assert')
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
