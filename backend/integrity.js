const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const COMMAND_TIMEOUT_MS = 10000

function run(file, args) {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: COMMAND_TIMEOUT_MS
  })

  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    signal: result.signal,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error || null
  }
}

function outputText(result) {
  if (!result) return ''
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
}

function findAppBundlePath(...candidates) {
  const seen = new Set()

  for (const candidate of candidates.flat()) {
    if (!candidate) continue

    let current = path.resolve(String(candidate))

    for (let i = 0; i < 12; i++) {
      if (seen.has(current)) break
      seen.add(current)

      if (/\\.app$/i.test(path.basename(current))) {
        return current
      }

      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }

  return null
}

function getRuntimePathContext(bundlePath, appPath) {
  const paths = [
    bundlePath,
    appPath,
    process.execPath,
    process.resourcesPath
  ].filter(Boolean)

  const text = paths.join('\n')

  return {
    appTranslocated: /\\/AppTranslocation\\//i.test(text) || /\\/AppTranslocation\\//i.test(text.replace(/\\\\/g, '/')),
    underPrivateVarFolders: /\\/private\\/var\\/folders\\//i.test(text) || /\\/private\\/var\\/folders\\//i.test(text.replace(/\\\\/g, '/'))
  }
}

function isUnsignedSignature(details, message) {
  const text = `${details}\\n${message}`

  return /code object is not signed at all|bundle is unsigned|no code signature found/i.test(text)
}

function isTrustOnlyVerificationFailure(message) {
  return /CSSMERR_TP_|errSecCS.*(?:not trusted|certificate)|not trusted|unable to build certificate chain|unable to build chain|certificate.*(?:expired|revoked|invalid)|no suitable identity/i.test(message)
}

function isDefiniteMutationFailure(message) {
  return /a sealed resource is missing or invalid|code object is not signed at all|code signature.*(?:invalid|invalidated|corrupt|malformed)|invalid or corrupted code signature|bundle format.*(?:invalid|unrecognized|unsuitable)|resource seal.*(?:invalid|missing)|sealed resource.*(?:missing|invalid)/i.test(message)
}

function getCodeSignatureInfo(bundlePath) {
  const result = run('/usr/bin/codesign', ['-dv', '--verbose=4', bundlePath])
  const details = outputText(result)

  const identity = details.match(/^Authority=(.+)$/m)?.[1]?.trim() || null
  const teamIdentifierValue = details.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() || null
  const teamIdentifier = teamIdentifierValue && teamIdentifierValue !== 'not set'
    ? teamIdentifierValue
    : null

  return {
    readable: result.ok,
    details,
    identity,
    teamIdentifier,
    signed: result.ok || Boolean(
      /CodeDirectory v=/m.test(details) ||
      /Signature=adhoc/m.test(details) ||
      /^Authority=/m.test(details)
    ),
    adHoc: /(?:^|\\n)Signature=adhoc(?:\\n|$)/m.test(details),
    developerIdSigned: /^Authority=Developer ID Application:/m.test(details),
    hardenedRuntime: /flags=.*\\bruntime\\b/.test(details),
    error: result.error ? String(result.error.message || result.error) : null
  }
}

function verifyCodeSignature(bundlePath) {
  return run('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    bundlePath
  ])
}

function assessGatekeeper(bundlePath) {
  return run('/usr/sbin/spctl', [
    '--assess',
    '--type',
    'execute',
    '--verbose=2',
    bundlePath
  ])
}

function getAsarPath(bundlePath) {
  if (!bundlePath) return null

  const candidate = path.join(bundlePath, 'Contents', 'Resources', 'app.asar')
  return fs.existsSync(candidate) ? candidate : null
}

function inspectIntegrity(app) {
  const appPath = typeof app?.getAppPath === 'function' ? app.getAppPath() : null
  const bundlePath = findAppBundlePath(
    process.execPath,
    appPath,
    process.resourcesPath
  )
  const runtimePath = getRuntimePathContext(bundlePath, appPath)

  const base = {
    version: typeof app?.getVersion === 'function' ? app.getVersion() : null,
    packaged: Boolean(app?.isPackaged),
    platform: process.platform,
    arch: process.arch,
    appPath,
    bundlePath,
    resourcesPath: process.resourcesPath,
    asarPath: getAsarPath(bundlePath),
    runtimePath,
    status: 'unknown',
    signed: false,
    validSignature: false,
    developerIdSigned: false,
    gatekeeperAccepted: false,
    identity: null,
    teamIdentifier: null,
    hardenedRuntime: false,
    reason: null
  }

  if (process.platform !== 'darwin') {
    base.status = 'unsupported'
    base.reason = 'macOS code-signature verification is only available on macOS'
    return base
  }

  if (!base.packaged) {
    base.status = 'development'
    base.reason = 'Development builds are not evaluated as distributable releases'
    return base
  }

  if (!bundlePath) {
    base.status = 'unknown'
    base.reason = 'Could not locate the enclosing .app bundle from the Electron runtime path'
    return base
  }

  const signature = getCodeSignatureInfo(bundlePath)

  base.signed = signature.signed
  base.identity = signature.identity
  base.teamIdentifier = signature.teamIdentifier
  base.developerIdSigned = signature.developerIdSigned
  base.hardenedRuntime = signature.hardenedRuntime

  if (!signature.signed) {
    base.status = isUnsignedSignature(signature.details, signature.error)
      ? 'unsigned'
      : 'unknown'
    base.reason = base.status === 'unsigned'
      ? 'Application has no usable code signature'
      : (signature.error || 'Unable to inspect the application code signature')
    return base
  }

  const verify = verifyCodeSignature(bundlePath)
  const verifyMessage = outputText(verify)

  if (!verify.ok) {
    base.validSignature = false

    if (isTrustOnlyVerificationFailure(verifyMessage)) {
      base.status = 'signed-unverified'
      base.reason = verifyMessage || 'Code signature is present but macOS verification could not establish trust'
      return base
    }

    if (isDefiniteMutationFailure(verifyMessage)) {
      base.status = 'modified'
      base.reason = verifyMessage || 'Code signature verification detected a changed sealed resource or code object'
      return base
    }

    // Unknown verifier failures are kept separate from tamper detection.
    // This prevents a transient/security-service failure from becoming a
    // false "modified after signing" result.
    base.status = 'verification-error'
    base.reason = verifyMessage || 'macOS code-signature verification did not complete successfully'
    return base
  }

  base.validSignature = true

  if (signature.adHoc) {
    base.status = 'ad-hoc'
    base.reason = runtimePath.appTranslocated
      ? 'Valid ad-hoc signature; app is currently running from an App Translocation path'
      : 'Valid ad-hoc signature'
    return base
  }

  const gatekeeper = assessGatekeeper(bundlePath)
  base.gatekeeperAccepted = gatekeeper.ok

  if (signature.developerIdSigned && signature.hardenedRuntime && gatekeeper.ok) {
    base.status = 'official'
    base.reason = null
    return base
  }

  const missing = []
  if (!signature.developerIdSigned) missing.push('Developer ID Application signature')
  if (!signature.hardenedRuntime) missing.push('Hardened Runtime')
  if (!gatekeeper.ok) missing.push('Gatekeeper acceptance')

  base.status = 'signed-unverified'
  base.reason = `Signature is valid, but this build is not fully verified: ${missing.join(', ')}.`

  return base
}

function shouldBlock(integrity) {
  return integrity?.packaged === true &&
    integrity?.platform === 'darwin' &&
    integrity?.signed === true &&
    integrity?.validSignature === false &&
    integrity?.status === 'modified'
}

module.exports = {
  inspectIntegrity,
  shouldBlock,
  findAppBundlePath,
  isUnsignedSignature,
  isTrustOnlyVerificationFailure,
  isDefiniteMutationFailure
}
