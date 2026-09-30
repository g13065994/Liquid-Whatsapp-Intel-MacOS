const { spawnSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const COMMAND_TIMEOUT_MS = 10000
const ASAR_HEADER_PREFIX_SIZE = 16

function run(file, args) {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 1024 * 1024
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
  return result ? [result.stdout, result.stderr].filter(Boolean).join('\n').trim() : ''
}

function findAppBundlePath(...candidates) {
  const seen = new Set()
  for (const candidate of candidates.flat()) {
    if (!candidate) continue
    let current = path.resolve(String(candidate))
    for (let i = 0; i < 16; i++) {
      if (seen.has(current)) break
      seen.add(current)
      if (/\.app$/i.test(path.basename(current))) return current
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  return null
}

function detectReadOnlyPath(candidate) {
  if (!candidate) return false
  try {
    fs.accessSync(path.resolve(String(candidate)), fs.constants.W_OK)
    return false
  } catch (_) {
    return true
  }
}

function detectRuntimePath(...candidatePaths) {
  const normalized = candidatePaths
    .filter(Boolean)
    .map((value) => path.resolve(String(value)).replace(/\\/g, '/'))
  const joined = normalized.join('\n')
  const appTranslocation = /\/AppTranslocation\//i.test(joined)
  const privateVarFolders = /\/private\/var\/folders\/[^/]+\/[^/]+\/T(?:\/|$)/i.test(joined) ||
    /\/var\/folders\/[^/]+\/[^/]+\/T(?:\/|$)/i.test(joined)

  return {
    appTranslocation,
    privateVarFolders,
    readOnlySystemTemp: privateVarFolders && detectReadOnlyPath(candidatePaths.find(Boolean)),
    path: normalized[0] || null
  }
}

function getCodeSignatureInfo(bundlePath) {
  const result = run('/usr/bin/codesign', ['-dv', '--verbose=4', bundlePath])
  const details = outputText(result)
  const identity = details.match(/^Authority=(.+)$/m)?.[1]?.trim() || null
  const teamIdentifierValue = details.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() || null

  return {
    inspectable: result.ok || Boolean(details),
    signed: result.ok || /CodeDirectory v=|Signature=adhoc|^Authority=/m.test(details),
    adHoc: /(?:^|\n)Signature=adhoc(?:\n|$)/m.test(details),
    developerIdSigned: /^Authority=Developer ID Application:/m.test(details),
    hardenedRuntime: /flags=.*\bruntime\b/.test(details),
    identity,
    teamIdentifier: teamIdentifierValue && teamIdentifierValue !== 'not set'
      ? teamIdentifierValue
      : null,
    error: result.error ? String(result.error.message || result.error) : null
  }
}

function assessGatekeeper(bundlePath) {
  const result = run('/usr/sbin/spctl', [
    '--assess', '--type', 'execute', '--verbose=2', bundlePath
  ])
  return { accepted: result.ok, output: outputText(result) }
}

function parseAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r')
  try {
    const stat = fs.fstatSync(fd)
    if (stat.size < ASAR_HEADER_PREFIX_SIZE) {
      throw new Error('ASAR file is too small to contain a valid header')
    }

    const prefix = Buffer.alloc(ASAR_HEADER_PREFIX_SIZE)
    fs.readSync(fd, prefix, 0, prefix.length, 0)

    const pickleTotalSize = prefix.readUInt32LE(4)
    const headerStringLength = prefix.readUInt32LE(12)
    const headerStart = ASAR_HEADER_PREFIX_SIZE
    const headerEnd = headerStart + headerStringLength
    const dataOffset = 8 + pickleTotalSize

    if (!pickleTotalSize || !headerStringLength ||
        !Number.isSafeInteger(headerEnd) || !Number.isSafeInteger(dataOffset) ||
        headerEnd > stat.size || dataOffset > stat.size || headerEnd > dataOffset) {
      throw new Error('ASAR header boundaries are invalid')
    }

    const headerBuffer = Buffer.alloc(headerStringLength)
    fs.readSync(fd, headerBuffer, 0, headerBuffer.length, headerStart)
    const headerString = headerBuffer.toString('utf8')

    let header
    try {
      header = JSON.parse(headerString)
    } catch (error) {
      throw new Error('ASAR header JSON is invalid: ' + error.message)
    }

    if (!header || typeof header !== 'object' || !header.files || typeof header.files !== 'object') {
      throw new Error('ASAR header does not contain a valid files tree')
    }

    return { header, headerBuffer, headerString, headerStart, headerEnd, dataOffset, fileSize: stat.size }
  } finally {
    fs.closeSync(fd)
  }
}

function readEmbeddedAsarIntegrity(bundlePath) {
  const plistPath = path.join(bundlePath, 'Contents', 'Info.plist')
  if (!fs.existsSync(plistPath)) {
    return { present: false, reason: 'Info.plist is missing' }
  }

  const result = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', plistPath])
  if (!result.ok) {
    return { present: false, reason: outputText(result) || 'Unable to read Info.plist' }
  }

  try {
    const document = JSON.parse(result.stdout)
    const entry = document?.ElectronAsarIntegrity?.['Resources/app.asar']
    if (!entry || typeof entry !== 'object') {
      return { present: false, reason: 'ElectronAsarIntegrity does not contain Resources/app.asar' }
    }

    const algorithm = String(entry.algorithm || '').toUpperCase()
    const hash = String(entry.hash || '').toLowerCase()
    if (algorithm !== 'SHA256' || !/^[0-9a-f]{64}$/.test(hash)) {
      return {
        present: true,
        valid: false,
        reason: 'ElectronAsarIntegrity contains an unsupported or malformed SHA256 record'
      }
    }

    return { present: true, valid: true, algorithm, hash }
  } catch (error) {
    return { present: false, reason: 'Unable to parse Info.plist JSON: ' + error.message }
  }
}

function equalHex(expected, actual) {
  const left = Buffer.from(String(expected || '').toLowerCase(), 'hex')
  const right = Buffer.from(String(actual || '').toLowerCase(), 'hex')
  if (left.length !== 32 || right.length !== 32) return false
  return crypto.timingSafeEqual(left, right)
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function validateHeaderAnchor(headerBuffer, expectedHash) {
  const actualHash = sha256(headerBuffer)
  return {
    actualHash,
    expectedHash: String(expectedHash || '').toLowerCase() || null,
    matches: Boolean(expectedHash) && equalHex(expectedHash, actualHash)
  }
}

function validateAsarPayload(asarPath, bundlePath) {
  const base = {
    status: 'unknown',
    archiveExists: false,
    headerValid: false,
    embeddedAnchorPresent: false,
    embeddedAnchorValid: false,
    embeddedHeaderHashMatches: false,
    headerHash: null,
    expectedHeaderHash: null,
    reason: null
  }

  if (!asarPath || !fs.existsSync(asarPath)) {
    base.status = 'missing'
    base.reason = 'Resources/app.asar is missing'
    return base
  }

  base.archiveExists = true

  let parsed
  try {
    parsed = parseAsarHeader(asarPath)
    base.headerValid = true
  } catch (error) {
    base.status = 'breached'
    base.reason = error.message
    return base
  }

  const headerAnchor = validateHeaderAnchor(parsed.headerBuffer, null)
  base.headerHash = headerAnchor.actualHash

  const embedded = readEmbeddedAsarIntegrity(bundlePath)
  base.embeddedAnchorPresent = embedded.present
  base.embeddedAnchorValid = embedded.valid !== false
  base.expectedHeaderHash = embedded.hash || null

  if (embedded.present && embedded.valid === false) {
    base.status = 'breached'
    base.reason = embedded.reason
    return base
  }

  if (!embedded.present) {
    base.status = 'unanchored'
    base.reason = embedded.reason || 'No external ASAR integrity anchor is available'
    return base
  }

  const headerAnchor = validateHeaderAnchor(parsed.headerBuffer, embedded.hash)
  base.embeddedHeaderHashMatches = headerAnchor.matches

  if (!base.embeddedHeaderHashMatches) {
    base.status = 'breached'
    base.reason = 'The app.asar header hash does not match the embedded ElectronAsarIntegrity anchor'
    return base
  }

  base.status = 'valid'
  return base
}

function inspectIntegrity(app) {
  const appPath = typeof app?.getAppPath === 'function' ? app.getAppPath() : null
  const bundlePath = findAppBundlePath(process.execPath, appPath, process.resourcesPath)
  const runtimePath = detectRuntimePath(
    appPath, process.execPath, process.resourcesPath, bundlePath
  )
  const asarPath = bundlePath
    ? path.join(bundlePath, 'Contents', 'Resources', 'app.asar')
    : null

  const signature = bundlePath && process.platform === 'darwin'
    ? getCodeSignatureInfo(bundlePath)
    : null
  const gatekeeper = bundlePath && process.platform === 'darwin'
    ? assessGatekeeper(bundlePath)
    : null

  const payload = process.platform === 'darwin' && app?.isPackaged && bundlePath
    ? validateAsarPayload(asarPath, bundlePath)
    : {
        status: app?.isPackaged ? 'unsupported' : 'development',
        archiveExists: Boolean(asarPath && fs.existsSync(asarPath)),
        headerValid: false,
        embeddedAnchorPresent: false,
        embeddedAnchorValid: false,
        embeddedHeaderHashMatches: false,
        headerHash: null,
        expectedHeaderHash: null,
        reason: app?.isPackaged
          ? 'ASAR payload validation is only enabled for packaged macOS builds'
          : 'Development builds are not evaluated as distributable releases'
      }

  let signatureStatus = 'unavailable'
  if (signature) {
    if (signature.adHoc) {
      signatureStatus = runtimePath.appTranslocation || runtimePath.readOnlySystemTemp
        ? 'ad-hoc-translocated'
        : 'ad-hoc'
    } else if (signature.developerIdSigned && signature.hardenedRuntime && gatekeeper?.accepted) {
      signatureStatus = 'official'
    } else if (signature.signed) {
      signatureStatus = 'signed-unverified'
    } else {
      signatureStatus = 'unsigned'
    }
  }

  return {
    version: typeof app?.getVersion === 'function' ? app.getVersion() : null,
    packaged: Boolean(app?.isPackaged),
    platform: process.platform,
    arch: process.arch,
    appPath,
    bundlePath,
    resourcesPath: process.resourcesPath,
    asarPath,
    status: payload.status,
    reason: payload.reason,
    payload,
    runtimePath,
    signature: {
      status: signatureStatus,
      signed: Boolean(signature?.signed),
      adHoc: Boolean(signature?.adHoc),
      developerIdSigned: Boolean(signature?.developerIdSigned),
      hardenedRuntime: Boolean(signature?.hardenedRuntime),
      identity: signature?.identity || null,
      teamIdentifier: signature?.teamIdentifier || null,
      gatekeeperAccepted: Boolean(gatekeeper?.accepted),
      gatekeeperOutput: gatekeeper?.output || null
    }
  }
}

function shouldBlock(integrity) {
  return integrity?.packaged === true &&
    integrity?.platform === 'darwin' &&
    integrity?.payload?.status === 'breached'
}

module.exports = {
  inspectIntegrity,
  shouldBlock,
  findAppBundlePath,
  detectRuntimePath,
  parseAsarHeader,
  readEmbeddedAsarIntegrity,
  validateAsarPayload,
  validateHeaderAnchor,
  equalHex,
  sha256
}
