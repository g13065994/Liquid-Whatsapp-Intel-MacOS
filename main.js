const { app, BrowserWindow, ipcMain, dialog, Notification, Menu, shell, systemPreferences, safeStorage, session, desktopCapturer } = require('electron')
const os = require('os')
const { autoUpdater } = require('electron-updater')
const path = require('path')
const { inspectIntegrity, shouldBlock } = require('./backend/integrity')
const https = require('https')
const fs = require('fs')
const WhatsAppCore = require('./backend/core')

app.setName('Liquid WhatsApp')

const DATA_DIR = path.join(app.getPath('userData'), 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })

const core = new WhatsAppCore(DATA_DIR)
let win = null
let backupTimer = null
let updateCheckTimer = null
let updateDownloadStarted = false
let webCallWin = null
let latestAvailableVersion = null

function forward(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send('ev:' + channel, data)
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 960,
    minHeight: 620,
    title: 'Liquid WhatsApp',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f241b',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      sandbox: true
    }
  })

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => { win = null })
}

function openWhatsAppWebCall(targetJid, isVideo = false) {
  const jid = String(targetJid || '')
  if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') {
    throw new Error('WhatsApp Web calling is available here for private chats only')
  }

  const rawNumber = jid.endsWith('@s.whatsapp.net') ? jid.slice(0, -'@s.whatsapp.net'.length) : jid
  const number = rawNumber.split(':')[0].replace(/\D/g, '')
  if (!number) throw new Error('Could not determine the contact phone number')

  const callUrl = new URL('https://web.whatsapp.com/send')
  callUrl.searchParams.set('phone', number)

  if (webCallWin && !webCallWin.isDestroyed()) {
    webCallWin.show()
    webCallWin.focus()
    webCallWin.loadURL(callUrl.toString())
    return { ok: true, mode: isVideo ? 'video' : 'audio', reused: true }
  }

  const webSession = session.fromPartition('persist:liquid-whatsapp-web')
  webSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    return permission === 'media' && requestingOrigin === 'https://web.whatsapp.com'
  })
  webSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const origin = (() => {
      try { return new URL(webContents.getURL()).origin } catch (_) { return '' }
    })()
    callback(permission === 'media' && origin === 'https://web.whatsapp.com')
  })
  webSession.setDisplayMediaRequestHandler((request, callback) => {
    if (request.securityOrigin !== 'https://web.whatsapp.com') return callback(null)
    desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
      .then(async (sources) => {
        if (!sources.length) return callback(null)
        const buttons = sources.map((source) => source.name || 'Untitled window')
        buttons.push('Cancel')
        const choice = await dialog.showMessageBox(webCallWin, {
          type: 'question',
          title: 'Share your screen',
          message: 'Choose what to share with your WhatsApp call.',
          buttons,
          defaultId: 0,
          cancelId: buttons.length - 1
        })
        const source = choice.response < sources.length ? sources[choice.response] : null
        callback(source ? { video: source } : null)
      })
      .catch(() => callback(null))
  })

  webCallWin = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    title: isVideo ? 'WhatsApp Web Video Call — Liquid WhatsApp' : 'WhatsApp Web Call — Liquid WhatsApp',
    backgroundColor: '#111b21',
    webPreferences: {
      session: webSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  })

  webCallWin.webContents.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
  )

  webCallWin.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url)
      if (parsed.origin === 'https://web.whatsapp.com') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 1180,
            height: 760,
            webPreferences: {
              session: webSession,
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true
            }
          }
        }
      }
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        setImmediate(() => shell.openExternal(parsed.toString()))
      }
    } catch (_) {}
    return { action: 'deny' }
  })

  const allowWebOrigin = (url) => {
    try {
      return new URL(url).origin === 'https://web.whatsapp.com'
    } catch (_) {
      return false
    }
  }

  webCallWin.webContents.on('will-navigate', (event, url) => {
    if (!allowWebOrigin(url)) {
      event.preventDefault()
      try {
        const parsed = new URL(url)
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
          shell.openExternal(parsed.toString())
        }
      } catch (_) {}
    }
  })

  webCallWin.webContents.on('will-redirect', (event, url) => {
    if (!allowWebOrigin(url)) event.preventDefault()
  })

  webCallWin.on('closed', () => { webCallWin = null })
  webCallWin.loadURL(callUrl.toString())
  webCallWin.show()

  return { ok: true, mode: isVideo ? 'video' : 'audio', reused: false }
}

function buildMenu() {
  const template = [
    { label: app.name, submenu: [
      { role: 'about' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { role: 'quit' }
    ]},
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
    ]},
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' }, { role: 'togglefullscreen' }
    ]},
    { label: 'Window', submenu: [
      { role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }
    ]}
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerHandle(channel, listener) {
  require('electron').ipcMain.handle(channel, (event, ...args) => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents) {
      throw new Error('Unauthorized IPC sender')
    }
    const frameUrl = event.senderFrame?.url || ''
    const expectedUrl = win.webContents.getURL()
    if (!frameUrl || frameUrl !== expectedUrl) {
      throw new Error('Unauthorized IPC frame')
    }
    return listener(event, ...args)
  })
}

function safeHandler(fn) {
  return async (...args) => {
    try {
      return await fn(...args)
    } catch (e) {
      const message = e?.message || String(e)
      console.error('[IPC]', message)
      throw new Error(message)
    }
  }
}

async function chooseFile(title, filters) {
  const res = await dialog.showOpenDialog(win, {
    title,
    properties: ['openFile'],
    filters
  })
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0]
}

function getAiSecret() {
  const encoded = core.getSettings().ai?.keyEncrypted || ''
  if (encoded) {
    try {
      return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
    } catch (_) {
      return ''
    }
  }
  // One-time migration path for versions that stored the key in plaintext.
  const legacy = core.getAiSecret()
  if (!legacy) return ''
  if (safeStorage.isEncryptionAvailable()) {
    try {
      const encrypted = safeStorage.encryptString(legacy).toString('base64')
      core.setAiEncryptedSecret(encrypted).catch(() => {})
      return legacy
    } catch (_) {}
  }
  return legacy
}

function registerIpc() {
  registerHandle('app:init', () => ({
    hasSession: core.hasSession(),
    user: core.userInfo(),
    chats: core.chatList(),
    settings: core.getSettings(),
    schedules: core.getSchedules(),
    starred: core.getStarred()
  }))

  registerHandle('core:pair', safeHandler((_e, number) => core.pairWithPhone(number)))
  registerHandle('core:logout', safeHandler(() => core.logout()))
  registerHandle('chat:set-active', (_e, jid) => core.setActiveJid(jid))

  registerHandle('network:ping', safeHandler(async () => {
    const started = Date.now()
    await new Promise((resolve, reject) => {
      const req = https.get('https://web.whatsapp.com/favicon.ico', { timeout: 5000 }, (res) => {
        res.resume()
        res.once('end', resolve)
        res.once('error', reject)
      })
      req.once('timeout', () => req.destroy(new Error('Network ping timed out')))
      req.once('error', reject)
    })
    return { ms: Date.now() - started }
  }))

  registerHandle('call:action', safeHandler((_e, action, callId, targetJid, isVideo) => core.callAction(action, callId, targetJid, !!isVideo)))
  registerHandle('whatsapp-web:call', safeHandler((_e, targetJid, isVideo) => openWhatsAppWebCall(targetJid, !!isVideo)))

  registerHandle('chat:send-text', safeHandler((_e, jid, text, quoted) => core.sendText(jid, text, quoted)))

  registerHandle('chat:send-image', safeHandler(async (_e, jid, caption, quoted) => {
    const file = await chooseFile('Choose an image', [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'] }
    ])
    if (!file) return { ok: false, reason: 'canceled' }
    await core.sendImage(jid, file, caption || '', quoted)
    return { ok: true }
  }))

  registerHandle('chat:send-dropped-media', safeHandler((_e, jid, filePath, caption, quoted) => core.sendDroppedMedia(jid, filePath, caption || '', quoted)))

  registerHandle('chat:send-media', safeHandler(async (_e, jid, caption, quoted) => {
    const file = await chooseFile('Choose a file', [
      { name: 'Media and documents', extensions: [
        'jpg','jpeg','png','gif','webp','heic','mp4','mov','m4v',
        'mp3','m4a','ogg','opus','pdf','doc','docx','xls','xlsx','ppt','pptx','txt','zip'
      ]},
      { name: 'All files', extensions: ['*'] }
    ])
    if (!file) return { ok: false, reason: 'canceled' }
    await core.sendMedia(jid, file, caption || '', quoted)
    return { ok: true }
  }))

  registerHandle('chat:send-voice-note', safeHandler(async (_e, jid, dataUrl, durationMs, quoted) => {
    if (!jid || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:audio/')) throw new Error('Invalid voice note')
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
    if (!match) throw new Error('Invalid voice note data')
    const ext = match[1].includes('ogg') ? '.ogg' : '.webm'
    const dir = path.join(DATA_DIR, 'voice-notes')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `voice-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`)
    fs.writeFileSync(file, Buffer.from(match[2], 'base64'))
    try {
      await core.sendVoiceNote(jid, file, quoted)
      return { ok: true, durationMs: Number(durationMs) || 0 }
    } finally {
      try { fs.unlinkSync(file) } catch (_) {}
    }
  }))

  registerHandle('chat:typing', (_e, jid, on) => core.sendTyping(jid, on))
  registerHandle('chat:load', safeHandler((_e, jid) => core.loadMessages(jid, 80)))
  registerHandle('chat:search', safeHandler((_e, q, jid) => core.searchMessages(q, jid)))
  registerHandle('chat:meta', safeHandler((_e, jid, patch) => core.setChatMeta(jid, patch)))
  registerHandle('chat:archive', safeHandler((_e, jid, value) => core.archiveChat(jid, value)))
  registerHandle('chat:pin', safeHandler((_e, jid, value) => core.pinChat(jid, value)))
  registerHandle('chat:mute', safeHandler((_e, jid, value) => core.muteChat(jid, value)))
  registerHandle('group:action', safeHandler((_e, jid, action, participants) => core.groupAction(jid, action, participants)))
  registerHandle('group:subject', safeHandler((_e, jid, subject) => core.groupUpdateSubject(jid, subject)))
  registerHandle('group:leave', safeHandler((_e, jid) => core.groupLeave(jid)))
  registerHandle('chat:read', safeHandler((_e, jid, ids) => core.readMessages(jid, ids)))
  registerHandle('chat:edit', safeHandler((_e, jid, id, text) => core.editMessage(jid, id, text)))
  registerHandle('chat:delete', safeHandler((_e, jid, id) => core.deleteMessage(jid, id)))
  registerHandle('chat:react', safeHandler((_e, jid, msg, reaction) => core.reactMessage(jid, msg, reaction)))
  registerHandle('chat:forward', safeHandler((_e, msg, targetJid) => core.forwardMessage(msg.jid, msg, targetJid)))
  registerHandle('chat:poll', safeHandler((_e, jid, name, options, pollSettings) => core.sendPoll(jid, name, options, pollSettings)))
  registerHandle('chat:viewonce', safeHandler((_e, jid, text) => core.sendViewOnce(jid, text)))
  registerHandle('chat:broadcast', safeHandler((_e, jids, text) => core.sendBroadcast(jids, text)))
  registerHandle('chat:mention-all', safeHandler((_e, jid, text) => core.sendMentionAll(jid, text)))
  registerHandle('chat:disappear', safeHandler((_e, jid, sec) => core.setDisappearing(jid, sec)))
  registerHandle('chat:sticker', safeHandler(async (_e, jid) => {
    const file = await chooseFile('Choose a WebP sticker', [
      { name: 'WebP stickers', extensions: ['webp'] }
    ])
    if (!file) return { ok: false, reason: 'canceled' }
    await core.sendSticker(jid, file)
    return { ok: true }
  }))

  registerHandle('chat:star', safeHandler((_e, m) => core.toggleStarred(m)))
  registerHandle('chat:starred', () => core.getStarred())
  registerHandle('media:download', safeHandler((_e, dto) => core.downloadMedia(dto)))
  registerHandle('contacts:list', () => core.contactList())
  registerHandle('group:participants', safeHandler((_e, jid) => core.groupParticipants(jid)))

  registerHandle('status:post', safeHandler((_e, text) => core.postStatus(text)))
  registerHandle('status:post-image', safeHandler(async (_e, caption) => {
    const file = await chooseFile('Choose a status image', [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }
    ])
    if (!file) return { ok: false, reason: 'canceled' }
    await core.postStatusImage(file, caption || '')
    return { ok: true }
  }))

  registerHandle('privacy:set', safeHandler((_e, key, value) => core.setPrivacy(key, value)))
  registerHandle('settings:get', () => core.getSettings())
  registerHandle('settings:set', safeHandler((_e, patch) => core.setSettings(patch)))
  registerHandle('ai:set-key', safeHandler(async (_e, key) => {
    const value = String(key || '').trim()
    if (!value) return false
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('macOS secure storage is unavailable. API key was not saved.')
    }
    const encrypted = safeStorage.encryptString(value).toString('base64')
    await core.setAiEncryptedSecret(encrypted)
    return true
  }))

  registerHandle('ai:call', safeHandler(async (_e, messages) => {
    const key = getAiSecret()
    if (!key) throw new Error('Set your API key in Settings → AI first')
    const ai = core.getSettings().ai || {}
    const provider = ai.provider || 'openai'
    const model = ai.model || (provider === 'openai' ? 'gpt-4o-mini' : provider === 'anthropic' ? 'claude-3-5-sonnet' : 'gemini-1.5-flash')
    let url = ''
    let headers = { 'Content-Type': 'application/json' }
    let body = {}

    if (provider === 'openai') {
      url = 'https://api.openai.com/v1/chat/completions'
      headers.Authorization = 'Bearer ' + key
      body = { model, messages }
    } else if (provider === 'anthropic') {
      url = 'https://api.anthropic.com/v1/messages'
      headers['x-api-key'] = key
      headers['anthropic-version'] = '2023-06-01'
      body = { model, max_tokens: 1024, messages }
    } else if (provider === 'gemini') {
      url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`
      body = { contents: (messages || []).map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })) }
    } else {
      throw new Error('Unsupported AI provider')
    }

    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data?.error?.message || data?.message || `AI API error: ${response.status}`)
    const text = provider === 'openai'
      ? data.choices?.[0]?.message?.content
      : provider === 'anthropic'
        ? data.content?.[0]?.text
        : data.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) throw new Error('AI provider returned no text')
    return { text }
  }))

  registerHandle('ai:image', safeHandler(async (_e, prompt) => {
    const key = getAiSecret()
    const ai = core.getSettings().ai || {}
    if (ai.provider !== 'openai' || !key) {
      throw new Error('Image generation requires an OpenAI API key with the OpenAI provider selected')
    }
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ prompt: String(prompt || ''), n: 1, size: '512x512' })
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data?.error?.message || `Image API error (${response.status})`)
    return data.data?.[0]?.url || ''
  }))

  registerHandle('integrity:get', () => getIntegrityStatus())

  registerHandle('diagnostics:get', async () => {
    const totalMem = os.totalmem()
    const freeMem = os.freemem()
    let storage = null
    try {
      const stat = fs.statfsSync(app.getPath('userData'))
      storage = { free: Number(stat.bavail) * Number(stat.bsize), total: Number(stat.blocks) * Number(stat.bsize) }
    } catch (_) {}

    let gpu = null
    try {
      gpu = { featureStatus: app.getGPUFeatureStatus(), info: await app.getGPUInfo('basic') }
    } catch (_) {}

    const permissions = {}
    for (const type of ['microphone', 'camera']) {
      try { permissions[type] = systemPreferences.getMediaAccessStatus(type) } catch (_) { permissions[type] = 'unknown' }
    }

    const metrics = app.getAppMetrics()
    const cpu = metrics.reduce((sum, item) => sum + (Number(item.cpu?.percentCPUUsage) || 0), 0)
    const privateMemory = metrics.reduce((sum, item) => sum + (Number(item.memory?.private) || 0), 0)

    return {
      integrity: getIntegrityStatus(),
      app: {
        name: app.getName(), version: app.getVersion(), electron: process.versions.electron,
        chrome: process.versions.chrome, node: process.versions.node, packaged: app.isPackaged,
        platform: process.platform, arch: process.arch
      },
      system: {
        os: process.getSystemVersion(), release: os.release(), cpu: os.cpus()[0]?.model || 'Unknown',
        cores: os.cpus().length, memory: { total: totalMem, free: freeMem, used: Math.max(0, totalMem - freeMem) },
        storage, uptime: os.uptime()
      },
      process: { cpuPercent: cpu, privateMemory, processCount: metrics.length },
      permissions,
      gpu,
      connection: { hasSession: core.hasSession(), connected: core.connection === 'open' },
      performance: { mode: core.getSettings().performanceMode || 'auto' }
    }
  })

  registerHandle('session:info', () => core.getLinkedSession())
  registerHandle('local:info', () => core.localDatabaseInfo())
  registerHandle('local:clear-backups', safeHandler(() => core.clearBackups()))
  registerHandle('calls:history', () => core.getCallHistory())
  registerHandle('calls:clear-history', safeHandler(() => core.clearCallHistory()))
  registerHandle('calls:create-link', safeHandler((_e, type) => core.createCallLink(type)))
  registerHandle('local:export', safeHandler(async () => {
    const res = await dialog.showSaveDialog(win, {
      title: 'Export Liquid WhatsApp data',
      defaultPath: path.join(app.getPath('documents'), `Liquid-WhatsApp-backup-${new Date().toISOString().slice(0,10)}.json`),
      filters: [{ name: 'JSON backup', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePath) return { ok: false, reason: 'canceled' }
    fs.writeFileSync(res.filePath, JSON.stringify(core.exportLocalData(), null, 2), 'utf8')
    return { ok: true, path: res.filePath }
  }))
  registerHandle('autoreply:add', safeHandler((_e, rule) => core.addAutoReply(rule)))
  registerHandle('autoreply:remove', safeHandler((_e, id) => core.removeAutoReply(id)))
  registerHandle('schedule:list', () => core.getSchedules())
  registerHandle('schedule:add', safeHandler((_e, s) => core.addSchedule(s)))
  registerHandle('schedule:remove', safeHandler((_e, id) => core.removeSchedule(id)))

  registerHandle('update:check', safeHandler(() => checkForUpdates(true)))
  registerHandle('update:download', safeHandler(() => downloadUpdate()))
  registerHandle('update:install', safeHandler(() => installUpdate()))

  registerHandle('external:open', safeHandler((_e, url) => {
    const value = String(url || '').trim()
    let parsed
    try { parsed = new URL(value) } catch (_) { throw new Error('Invalid external URL') }
    if (!['https:', 'http:'].includes(parsed.protocol)) {
      throw new Error('Only http(s) links can be opened')
    }
    return shell.openExternal(parsed.toString())
  }))
}

function getIntegrityStatus() {
  const integrity = inspectIntegrity(app)
  if (integrity.status === 'official' && latestAvailableVersion && latestAvailableVersion !== app.getVersion()) {
    integrity.status = 'older'
    integrity.availableVersion = latestAvailableVersion
    integrity.reason = 'A newer signed release is available.'
  }
  return integrity
}

function setupAutoUpdater() {
  if (!app.isPackaged || process.platform !== 'darwin' || process.arch !== 'x64') return

  // Never download an update automatically: the user must approve the data usage.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.autoInstallEvent = 'manual'
  autoUpdater.allowPrerelease = false
  autoUpdater.fullChangelog = false

  // Keep differential downloads enabled. GitHub's release layout can otherwise
  // make the updater look for the previous blockmap under the latest release.
  // Point it at the release matching the currently installed version so the
  // updater can compare the old installer blocks and download only the blocks
  // it needs when a valid blockmap is available.
  autoUpdater.disableDifferentialDownload = false
  autoUpdater.previousBlockmapBaseUrlOverride =
    `https://github.com/g13065994/Liquid-Whatsapp-Intel-MacOS/releases/download/v${app.getVersion()}/`

  autoUpdater.on('checking-for-update', () => forward('update:checking', { version: app.getVersion() }))
  autoUpdater.on('update-available', (info) => {
    latestAvailableVersion = info.version || null
    updateDownloadStarted = false
    forward('update:available', {
      version: info.version,
      releaseName: info.releaseName || info.version,
      releaseNotes: info.releaseNotes || null
    })
  })
  autoUpdater.on('update-not-available', (info) => {
    forward('update:not-available', { version: info?.version || app.getVersion() })
  })
  autoUpdater.on('download-progress', (progress) => {
    forward('update:progress', {
      percent: Number(progress.percent) || 0,
      transferred: Number(progress.transferred) || 0,
      total: Number(progress.total) || 0,
      bytesPerSecond: Number(progress.bytesPerSecond) || 0
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    updateDownloadStarted = false
    forward('update:downloaded', {
      version: info.version,
      releaseName: info.releaseName || info.version
    })
  })
  autoUpdater.on('update-cancelled', () => {
    updateDownloadStarted = false
    forward('update:cancelled', {})
  })
  autoUpdater.on('error', (error) => {
    updateDownloadStarted = false
    console.warn('[updater]', error?.message || error)
    forward('update:error', { message: error?.message || String(error) })
  })
}

async function checkForUpdates(manual = false) {
  if (!app.isPackaged || process.platform !== 'darwin' || process.arch !== 'x64') {
    if (manual) forward('update:error', { message: 'Updates are available only for packaged Intel macOS builds.' })
    return null
  }
  return autoUpdater.checkForUpdates()
}

async function downloadUpdate() {
  if (updateDownloadStarted) return { ok: true, alreadyStarted: true }
  updateDownloadStarted = true
  await autoUpdater.downloadUpdate()
  return { ok: true }
}

function installUpdate() {
  if (!app.isPackaged) throw new Error('Updates are only available in the packaged app')
  autoUpdater.quitAndInstall(false, true)
  return { ok: true }
}

core.on('connection', (u) => forward('connection', u))
core.on('chats', (c) => {
  forward('chats', c)
  if (app.dock) {
    const n = c.reduce((a, x) => a + (x.unread || 0), 0)
    app.dock.setBadge(n ? (n > 99 ? '99+' : String(n)) : '')
  }
})
core.on('messages', (p) => forward('messages', p))
core.on('presence', (p) => forward('presence', p))
core.on('settings', (s) => forward('settings', s))
core.on('schedules', (s) => forward('schedules', s))
core.on('call:incoming', (callData) => forward('call:ring', callData))
core.on('calls', (history) => forward('calls', history))
core.on('call:state', (state) => forward('call:state', state))
core.on('call:error', (error) => forward('call:error', error))
core.on('call:audio', (audio) => forward('call:audio', audio))
core.on('call:video', (video) => forward('call:video', video))

core.on('notify', (items) => {
  if (core.getSettings().notifications === false || !Notification.isSupported()) return
  for (const it of items) {
    const n = new Notification({
      title: it.name || 'Message',
      body: core.getSettings().showPreviews === false ? 'New message' : (it.text || 'New message'),
      silent: !core.getSettings().soundNotifications,
      soundName: 'default'
    })
    n.on('click', () => {
      if (!win || win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      win.webContents.send('ev:open-chat', it.jid)
    })
    n.show()
  }
})

app.whenReady().then(() => {
  const integrity = getIntegrityStatus()

  if (shouldBlock(integrity)) {
    dialog.showErrorBox(
      'Liquid WhatsApp integrity check failed',
      'This copy of Liquid WhatsApp appears to have been modified after it was signed. For your security, the app will close. Install the release again from the official GitHub Releases page.'
    )
    app.quit()
    return
  }

  buildMenu()
  registerIpc()
  createWindow()
  setupAutoUpdater()
  // Do not create an anonymous WhatsApp socket on the login screen.
  // The pairing flow creates its own socket only after the user submits a number.
  if (core.hasSession()) {
    core.start().catch((e) => console.error('[core] start failed:', e.message))
  }

  // Update checks are intentionally silent when nothing is available.
  // The first check waits until startup settles, then repeats every 6 hours.
  if (app.isPackaged && process.platform === 'darwin' && process.arch === 'x64') {
    setTimeout(() => checkForUpdates(false).catch((e) => console.warn('[updater]', e.message)), 10000)
    updateCheckTimer = setInterval(() => {
      checkForUpdates(false).catch((e) => console.warn('[updater]', e.message))
    }, 6 * 60 * 60 * 1000)
  }
  // Backups are intentionally lazy. The old implementation serialized the
  // entire local message database synchronously 5 seconds after startup,
  // which could freeze an older Intel Mac.
  backupTimer = setInterval(async () => {
    const settings = core.getSettings()
    if (settings.backupEnabled === false) return
    try {
      const dir = path.join(DATA_DIR, 'backups')
      await fs.promises.mkdir(dir, { recursive: true })
      const file = path.join(dir, 'latest.json')
      const intervalMs = Math.max(1, Number(settings.backupIntervalHours) || 24) * 60 * 60 * 1000
      const stale = !fs.existsSync(file) || (Date.now() - fs.statSync(file).mtimeMs > intervalMs)
      if (stale) {
        const payload = JSON.stringify(core.exportLocalData())
        await fs.promises.writeFile(file, payload, 'utf8')
      }
    } catch (e) { console.warn('[backup]', e.message) }
  }, 60 * 60 * 1000)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on('before-quit', () => {
  if (backupTimer) clearInterval(backupTimer)
  if (updateCheckTimer) clearInterval(updateCheckTimer)
  try { core.dispose() } catch (_) {}
})
