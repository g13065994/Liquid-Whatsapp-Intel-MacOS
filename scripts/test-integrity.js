const assert = require('assert')
const path = require('path')

const {
  findAppBundlePath,
  isUnsignedSignature,
  isTrustOnlyVerificationFailure,
  isDefiniteMutationFailure,
  shouldBlock
} = require('../backend/integrity')

const translocated = '/private/var/folders/ab/cd/T/AppTranslocation/12345678-AAAA-BBBB-CCCC-1234567890AB/d/Liquid WhatsApp.app/Contents/Resources/app.asar'
const expectedBundle = '/private/var/folders/ab/cd/T/AppTranslocation/12345678-AAAA-BBBB-CCCC-1234567890AB/d/Liquid WhatsApp.app'

assert.strictEqual(findAppBundlePath(translocated), expectedBundle)
assert.strictEqual(
  findAppBundlePath('/Applications/Liquid WhatsApp.app/Contents/MacOS/Liquid WhatsApp'),
  '/Applications/Liquid WhatsApp.app'
)

assert.strictEqual(
  isUnsignedSignature('', 'code object is not signed at all'),
  true
)

assert.strictEqual(
  isTrustOnlyVerificationFailure('CSSMERR_TP_NOT_TRUSTED'),
  true
)

assert.strictEqual(
  isDefiniteMutationFailure('a sealed resource is missing or invalid'),
  true
)

assert.strictEqual(
  shouldBlock({
    packaged: true,
    platform: 'darwin',
    signed: true,
    validSignature: false,
    status: 'modified'
  }),
  true
)

assert.strictEqual(
  shouldBlock({
    packaged: true,
    platform: 'darwin',
    signed: true,
    validSignature: false,
    status: 'signed-unverified'
  }),
  false
)

console.log('Integrity classification checks passed.')
