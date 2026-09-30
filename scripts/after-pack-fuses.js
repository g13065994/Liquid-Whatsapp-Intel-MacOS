const path = require('path')
const fs = require('fs')
const {
  flipFuses,
  FuseVersion,
  FuseV1Options
} = require('@electron/fuses')

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appName = context.packager.appInfo.productFilename
  const executable = path.join(
    context.appOutDir,
    appName + '.app',
    'Contents',
    'MacOS',
    appName
  )

  if (!fs.existsSync(executable)) {
    throw new Error('[Liquid WhatsApp] Electron executable not found for fuse hardening: ' + executable)
  }

  await flipFuses(executable, {
    version: FuseVersion.V1,
    strictlyRequireAllFuses: false,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false
  })
}
