const { EventEmitter } = require('events')
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)

let ffmpegPath = null
try { ffmpegPath = require('ffmpeg-static') } catch (_) {}

const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  Browsers,
  downloadMediaMessage
} = require('@innovatorssoft/baileys')
const pino = require('pino')
const LocalMessageStore = require('./local-store')

const logger = pino({ level: 'warn' })

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg; codecs=opus', '.pdf': 'application/pdf',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain', '.zip': 'application/zip'
}

const PRIVACY_METHODS = {
  lastseen: 'updateLastSeenPrivacy',
  online: 'updateOnlinePrivacy',
  read: 'updateReadReceiptsPrivacy',
  pic: 'updateProfilePicPrivacy',
  status: 'updateStatusPrivacy',
  groups: 'updateGroupsAddPrivacy'
}

const STATUS_MAP = { 1: 'PENDING', 2: 'SERVER_ACK', 3: 'DELIVERY_ACK', 4: 'READ' }

class WhatsAppCore extends EventEmitter {
  constructor(dataDir) {
    super()
    this.dataDir = dataDir
    this.sessionDir = path.join(dataDir, 'session')
    this.settingsFile = path.join(dataDir, 'settings.json')
    this.scheduleFile = path.join(dataDir, 'schedule.json')
    this.starredFile = path.join(dataDir, 'starred.json')
    this.callHistoryFile = path.join(dataDir, 'call-history.json')
    this.localMessagesFile = path.join(dataDir, 'messages.json')
    this.localDbFile = path.join(dataDir, 'messages.db.jsonl')
    this.localDb = new LocalMessageStore(this.localDbFile, this.localMessagesFile)
    this.chatMetaFile = path.join(dataDir, 'chat-meta.json')
    this.localMessages = this._readJson(this.localMessagesFile, {})
    this.outboxFile = path.join(dataDir, 'outbox.json')
    this.outbox = this._readJson(this.outboxFile, [])
    this.chatMeta = this._readJson(this.chatMetaFile, {})
    this.sock = null
    this.connection = 'idle'
    this.pendingPairingAt = null
    this.activeJid = null
    this.chats = new Map()
    this.contacts = new Map()
    this.presence = new Map()
    this.groupNames = new Map()
    this.messageStore = new Map()
    this.rawMessages = new Map()
    this.rawMessageLimit = 5000
    this.connectTimer = null
    this.tickBusy = false
    this.settings = this._readJson(this.settingsFile, {
      performanceMode: 'auto',
      autoReply: [],
      notifications: true,
      typingIndicator: true,
      privacy: {},
      ai: { provider: 'openai', model: '', key: '', keyEncrypted: '' },
      theme: 'system',
      soundNotifications: true,
      showPreviews: true,
      reduceMotion: false,
      backupEnabled: true,
      backupIntervalHours: 24,
      linkedSession: { linkedAt: null, lastActiveAt: null, phone: null }
    })
    this.schedules = this._readJson(this.scheduleFile, [])
    this.starred = this._readJson(this.starredFile, [])
    this.callHistory = this._readJson(this.callHistoryFile, [])
    this.activeCalls = new Map()
    this._hydrateLocalCache()
    this._timer = setInterval(() => this._tick().catch(() => {}), 5000)
  }

  dispose() {
    clearInterval(this._timer)
    clearTimeout(this._legacyPersistTimer)
    if (this.connectTimer) clearTimeout(this.connectTimer)
    for (const call of this.activeCalls.values()) { try { call.end('app_shutdown') } catch (_) {} }
    this.activeCalls.clear()
    try { this.sock?.ws?.close?.() } catch (_) {}
    this.sock = null
  }

  hasSession() {
    return fs.existsSync(path.join(this.sessionDir, 'creds.json'))
  }

  userInfo() {
    const u = this.sock && this.sock.user
    if (!u) return null
    return {
      id: u.id,
      name: u.name || 'Me',
      number: String(u.id || '').split(':')[0]
    }
  }

  async start() {
    if (this.connection === 'open' || this.connection === 'connecting') return
    await this._connect()
  }

  async _connect() {
    if (this.sock) return this.sock

    fs.mkdirSync(this.sessionDir, { recursive: true, mode: 0o700 })
    try { fs.chmodSync(this.sessionDir, 0o700) } catch (_) {}
    const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir)
    try {
      for (const name of fs.readdirSync(this.sessionDir)) {
        const file = path.join(this.sessionDir, name)
        if (fs.statSync(file).isFile()) fs.chmodSync(file, 0o600)
      }
    } catch (_) {}

    this.connection = 'connecting'
    this.emit('connection', { connection: 'connecting' })

    this.sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      logger,
      browser: Browsers.macOS('Liquid WhatsApp'),
      printQRInTerminal: false,
      mobile: false,
      markOnlineOnConnect: false,
      // Full-history sync is extremely expensive on older Intel Macs.\n      // Messages can still be loaded from the local store and WhatsApp will\n      // deliver new/updated messages normally.\n      syncFullHistory: false,
      getMessage: async () => undefined
    })

    this.sock.ev.on('creds.update', saveCreds)
    this.sock.ev.on('connection.update', (u) => this._onConnection(u))
    this.sock.ev.on('chats.set', (c) => this._onChatsUpsert(c))
    this.sock.ev.on('chats.upsert', (c) => this._onChatsUpsert(c))
    this.sock.ev.on('chats.update', (c) => this._onChatsUpdate(c))
    this.sock.ev.on('contacts.set', (c) => this._onContacts(c))
    this.sock.ev.on('contacts.upsert', (c) => this._onContacts(c))
    this.sock.ev.on('messages.upsert', (u) => this._onMessages(u))
    this.sock.ev.on('messages.update', (u) => this._onMessagesUpdate(u))
    this.sock.ev.on('presence.update', (u) => this._onPresence(u))
    this.sock.ev.on('messaging-history.set', ({ chats, contacts, messages }) => {
      if (contacts) this._onContacts(contacts)
      if (chats) this._onChatsUpsert(chats)
      if (messages?.length) this._onMessages({ messages, type: 'append' })
    })

    // The VoIP-enabled Baileys fork emits the normal WhatsApp call signaling
    // events. Real media calls are handled by its WhatsApp Web VoIP/WASM layer.
    this.sock.ev.on('call', (events) => {
      for (const call of events || []) {
        this.recordCall({
          id: call.id,
          jid: call.from,
          type: call.isVideo ? 'video' : 'voice',
          direction: call.from === this.userInfo()?.jid ? 'outgoing' : 'incoming',
          status: call.status,
          group: !!call.isGroup,
          groupJid: call.groupJid || null,
          timestamp: call.timestamp || call.date || Date.now()
        })
        if (call.status === 'offer') {
          this.emit('call:incoming', {
            id: call.id,
            from: call.from,
            isVideo: !!call.isVideo,
            isGroup: !!call.isGroup,
            groupJid: call.groupJid || null,
            timestamp: call.timestamp || call.date || Date.now()
          })
        }
      }
    })

    return this.sock
  }

  _onConnection({ connection, lastDisconnect, qr }) {
    this.connection = connection || 'idle'

    if (connection === 'open') {
      const user = this.userInfo()
      const existing = this.settings.linkedSession || {}
      const linkedAt = existing.linkedAt || this.pendingPairingAt || null
      const lastActiveAt = new Date().toISOString()
      this.pendingPairingAt = null
      this.setSettings({
        linkedSession: {
          linkedAt,
          lastActiveAt,
          phone: user?.number || existing.phone || null
        }
      }).catch(() => {})
      this.emit('connection', { connection: 'open', user })
      this._hydrate().catch(() => {})
      this._flushOutbox().catch(() => {})
      this.sock.sendPresenceUpdate('available').catch(() => {})
      return
    }

    if (connection === 'close') {
      const existing = this.settings.linkedSession || {}
      this.settings.linkedSession = { ...existing, lastActiveAt: new Date().toISOString() }
      this.setSettings({ linkedSession: this.settings.linkedSession }).catch(() => {})
      const status = lastDisconnect?.error?.output?.statusCode ?? null
      const loggedOut = status === DisconnectReason.loggedOut
      this.emit('connection', { connection: 'close', loggedOut })
      this.sock = null

      if (loggedOut) {
        this._wipeSession()
      } else {
        this.connection = 'idle'
        if (this.connectTimer) clearTimeout(this.connectTimer)
        this.connectTimer = setTimeout(() => {
          this.connectTimer = null
          this.start().catch((e) => logger.warn('reconnect failed: %s', e.message))
        }, 4000)
      }
      return
    }

    this.emit('connection', { connection, hasQr: !!qr })
  }

  _hydrateLocalCache() {
    // Rebuild the chat list from the persistent message store before WhatsApp connects.
    // This makes the app usable offline without requesting any network history.
    for (const [jid, bucket] of this.localDb.index) {
      let latest = null
      for (const message of bucket.values()) {
        if (!latest || Number(message.timestamp || 0) > Number(latest.timestamp || 0)) latest = message
      }
      const meta = this.chatMeta[jid] || {}
      this.chats.set(jid, {
        id: jid,
        unreadCount: 0,
        conversationTimestamp: Number(latest?.timestamp || 0),
        lastMessage: latest || null,
        mute: meta.muted ? -1 : 0,
        pin: !!meta.pinned
      })
    }
  }

  async _hydrate() {
    const s = this.sock
    if (!s) return

    try {
      const chats = Array.isArray(s.chats)
        ? s.chats
        : (s.chats && typeof s.chats.all === 'function' ? await s.chats.all() : [])
      if (chats.length) this._onChatsUpsert(chats)

      const ct = s.contacts
      let contacts = []
      if (Array.isArray(ct)) contacts = ct
      else if (ct && typeof ct.all === 'function') contacts = await ct.all()
      else if (ct && typeof ct === 'object') contacts = Object.values(ct)
      if (contacts.length) this._onContacts(contacts)

      this.emit('chats', this.chatList())
    } catch (e) {
      logger.warn('hydrate failed: %s', e.message)
    }
  }

  async pairWithPhone(numberRaw) {
    const number = String(numberRaw || '').replace(/[^\d]/g, '')
    if (number.length < 8 || number.length > 15) {
      throw new Error('Enter a valid international phone number with country code')
    }

    if (this.connection === 'open' || this.sock?.user) {
      throw new Error('This WhatsApp account is already connected')
    }

    // A failed pairing attempt can leave a stale socket behind. Recreate it
    // instead of requesting a new code through a dead connection.
    if (this.sock && this.connection !== 'connecting') {
      try { this.sock.ws?.close?.() } catch (_) {}
      this.sock = null
    }

    await this._connect()
    this.pendingPairingAt = new Date().toISOString()
    await this._waitForWs()
    // Give the WebSocket handshake a short settling window before asking
    // WhatsApp for a new companion pairing code. This avoids early 428/515
    // failures seen during fresh device registration.
    await new Promise((resolve) => setTimeout(resolve, 1500))

    if (!this.sock) throw new Error('WhatsApp socket is unavailable')
    if (this.sock.authState?.creds?.registered) {
      throw new Error('This WhatsApp session is already registered')
    }

    return this.sock.requestPairingCode(number)
  }

  _waitForWs(timeout = 30000) {
    return new Promise((resolve, reject) => {
      const sock = this.sock
      if (!sock) return reject(new Error('WhatsApp socket is unavailable'))

      if (sock.ws?.readyState === 1) return resolve()

      const started = Date.now()
      const check = () => {
        if (!this.sock) return reject(new Error('WhatsApp connection closed'))
        if (this.sock.ws?.readyState === 1) return resolve()
        if (Date.now() - started >= timeout) {
          return reject(new Error('Could not reach WhatsApp servers. Check your network and retry.'))
        }
        setTimeout(check, 150)
      }
      check()
    })
  }

  async logout() {
    try { if (this.sock) await this.sock.logout() } catch (_) {}
    this.sock = null
    this.connection = 'idle'
    this._wipeSession()
  }

  _wipeSession() {
    try { fs.rmSync(this.sessionDir, { recursive: true, force: true }) } catch (_) {}
    this.chats.clear()
    this.contacts.clear()
    this.presence.clear()
    this.messageStore.clear()
    this.rawMessages.clear()
    this.emit('connection', { connection: 'idle', loggedOut: true })
    this.emit('chats', [])
  }

  _onChatsUpsert(chats) {
    for (const c of chats || []) {
      if (c?.id) this.chats.set(c.id, c)
    }
    this.emit('chats', this.chatList())
  }

  _onChatsUpdate(updates) {
    for (const u of updates || []) {
      if (!u?.id) continue
      const prev = this.chats.get(u.id) || { id: u.id }
      this.chats.set(u.id, { ...prev, ...u })
    }
    this.emit('chats', this.chatList())
  }

  _onContacts(contacts) {
    for (const c of contacts || []) {
      const id = c?.jid || c?.id
      if (id) this.contacts.set(id, c)
    }
    this.emit('chats', this.chatList())
  }

  async _onMessages({ messages, type }) {
    if (!Array.isArray(messages) || !['notify', 'append'].includes(type)) return
    const list = messages.map((m) => this._msgDto(m)).filter((m) => m.id && m.jid)
    if (!list.length) return

    for (const raw of messages) {
      const key = raw?.key || {}
      if (key.remoteJid && key.id) this._rememberRawMessage(key.remoteJid, key.id, raw)
    }

    for (const dto of list) {
      const arr = this.messageStore.get(dto.jid) || []
      const existing = arr.findIndex((m) => m.id === dto.id)
      if (existing >= 0) arr[existing] = dto
      else arr.push(dto)
      arr.sort((a, b) => a.timestamp - b.timestamp)
      if (arr.length > 500) arr.splice(0, arr.length - 500)
      this.messageStore.set(dto.jid, arr)
    }

    // Emit each JID separately. The previous implementation emitted only the
    // first message's JID even when WhatsApp delivered a mixed batch.
    const byJid = new Map()
    for (const dto of list) {
      if (!byJid.has(dto.jid)) byJid.set(dto.jid, [])
      byJid.get(dto.jid).push(dto)
    }
    for (const [jid, messagesForChat] of byJid) {
      this._persistLocalMessages(jid)
      this.emit('messages', { jid, messages: messagesForChat })
    }

    this._bumpChats(messages)
    this._runAutoReply(messages).catch(() => {})
    this._notify(list)
  }

  _onMessagesUpdate(updates) {
    const byJid = new Map()
    for (const u of updates || []) {
      const jid = u?.key?.remoteJid
      if (!jid || !u.status) continue
      if (!byJid.has(jid)) byJid.set(jid, [])
      byJid.get(jid).push({
        id: u.key.id,
        status: STATUS_MAP[u.status] || 'PENDING'
      })
    }
    for (const [jid, statusUpdates] of byJid) {
      const arr = this.messageStore.get(jid) || []
      for (const u of statusUpdates) { const m = arr.find(x => x.id === u.id); if (m) m.status = u.status }
      this._persistLocalMessages(jid)
      this.emit('messages', { jid, statusUpdates })
    }
  }

  _bumpChats(messages) {
    let changed = false
    for (const m of messages || []) {
      const jid = m?.key?.remoteJid
      if (!jid) continue
      const chat = this.chats.get(jid) || { id: jid, unreadCount: 0 }
      chat.conversationTimestamp = Number(m.messageTimestamp || 0)
      if (!m.key?.fromMe && jid !== this.activeJid) {
        chat.unreadCount = Number(chat.unreadCount || 0) + 1
      }
      if (!chat.lastMessage) chat.lastMessage = m
      else {
        const oldTs = Number(chat.lastMessage.messageTimestamp || 0)
        if (Number(m.messageTimestamp || 0) >= oldTs) chat.lastMessage = m
      }
      this.chats.set(jid, chat)
      changed = true
    }
    if (changed) this.emit('chats', this.chatList())
  }

  _onPresence({ id, presences }) {
    const map = presences instanceof Map ? Object.fromEntries(presences) : presences
    for (const [jid, p] of Object.entries(map || {})) {
      const state = p?.lastKnownPresence
      this.presence.set(
        jid,
        state === 'composing' ? 'typing'
          : state === 'recording' ? 'recording'
          : state === 'available' ? 'online' : 'offline'
      )
    }
    this.emit('presence', { jid: id, state: this.presence.get(id) })
  }

  _notify(list) {
    if (!this.settings.notifications) return
    const incoming = list.filter((m) =>
      !m.fromMe && m.kind !== 'system' && m.jid !== this.activeJid
    )
    if (incoming.length) {
      this.emit('notify', incoming.map((m) => ({
        jid: m.jid,
        name: this._nameFor(m.jid),
        text: m.text || m.caption || m.kind
      })))
    }
  }

  async _runAutoReply(messages) {
    const rules = (this.settings.autoReply || [])
      .filter((r) => r.enabled !== false && r.keyword && r.response)
    for (const m of messages || []) {
      if (m.key?.fromMe) continue
      const jid = m.key?.remoteJid
      const text = this._textOf(m)
      if (!jid || !text) continue
      const rule = rules.find((r) =>
        text.toLowerCase().includes(String(r.keyword).toLowerCase())
      )
      if (rule) {
        setTimeout(() => this.sendText(jid, rule.response).catch(() => {}), 1200)
      }
    }
  }

  setActiveJid(jid) {
    this.activeJid = jid || null
    if (jid && !jid.endsWith('@g.us') && jid !== 'status@broadcast' && this.sock?.presenceSubscribe) {
      this.sock.presenceSubscribe(jid).catch(() => {})
    }
    if (jid) {
      const chat = this.chats.get(jid)
      if (chat) {
        chat.unreadCount = 0
        this.emit('chats', this.chatList())
      }
    }
  }

  async sendText(jid, text, quoted) {
    const value = String(text || '').trim()
    if (!jid || !value) throw new Error('Message cannot be empty')
    if (!this.sock || this.connection !== 'open') {
      this.outbox.push({ id: crypto.randomUUID(), type: 'text', jid, text: value, quoted: null, createdAt: Date.now() })
      this._saveOutbox()
      this.emit('outbox', { count: this.outbox.length })
      return { queued: true }
    }
    const quotedRaw = quoted?.id && quoted?.jid ? this._getRawMessage(quoted.jid, quoted.id) : null
    const options = quotedRaw ? { quoted: quotedRaw } : {}
    await this.sock.sendMessage(jid, { text: value }, options)
  }

  async sendImage(jid, filePath, caption = '', quoted) {
    this._requireOpen()
    const ext = path.extname(filePath).toLowerCase()
    await this.sock.sendMessage(jid, {
      image: fs.readFileSync(filePath),
      mimetype: MIME[ext] || 'image/jpeg',
      caption: caption || undefined
    }, (() => {
      const quotedRaw = quoted?.id && quoted?.jid ? this._getRawMessage(quoted.jid, quoted.id) : null
      return quotedRaw ? { quoted: quotedRaw } : {}
    })())
  }

  _readUserMediaFile(filePath, { dropped = false } = {}) {
    if (!filePath || typeof filePath !== 'string') throw new Error('No file selected')
    const resolved = path.resolve(filePath)
    if (dropped) {
      const home = path.resolve(os.homedir())
      const allowedRoots = ['Desktop', 'Documents', 'Downloads', 'Movies', 'Music', 'Pictures']
        .map((name) => path.join(home, name))
      const allowed = allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep))
      if (!allowed) throw new Error('Dropped files must come from a standard user media folder')
    }
    const stat = fs.statSync(resolved)
    if (!stat.isFile()) throw new Error('Selected path is not a regular file')
    if (stat.size > 100 * 1024 * 1024) throw new Error('Media file is too large (maximum 100 MB)')
    const ext = path.extname(resolved).toLowerCase()
    const mime = MIME[ext]
    if (!mime) throw new Error('Unsupported media file type')
    return { path: resolved, ext, mime, data: fs.readFileSync(resolved) }
  }

  async sendMedia(jid, filePath, caption = '', quoted) {
    this._requireOpen()
    const media = this._readUserMediaFile(filePath)
    const { path: resolved, ext, mime, data } = media
    let payload

    if (mime.startsWith('image/')) {
      payload = { image: data, mimetype: mime, caption: caption || undefined }
    } else if (mime.startsWith('video/')) {
      payload = { video: data, mimetype: mime, caption: caption || undefined }
    } else if (mime.startsWith('audio/')) {
      payload = { audio: data, mimetype: mime, ptt: false }
    } else {
      payload = {
        document: data,
        mimetype: mime,
        fileName: path.basename(resolved),
        caption: caption || undefined
      }
    }
const quotedRaw = quoted?.id && quoted?.jid ? this._getRawMessage(quoted.jid, quoted.id) : null
    await this.sock.sendMessage(jid, payload, quotedRaw ? { quoted: quotedRaw } : {})
  }

  async sendDroppedMedia(jid, filePath, caption = '', quoted) {
    this._requireOpen()
    const media = this._readUserMediaFile(filePath, { dropped: true })
    const { path: resolved, ext, mime, data } = media
    let payload
    if (mime.startsWith('image/')) {
      payload = { image: data, mimetype: mime, caption: caption || undefined }
    } else if (mime.startsWith('video/')) {
      payload = { video: data, mimetype: mime, caption: caption || undefined }
    } else if (mime.startsWith('audio/')) {
      payload = { audio: data, mimetype: mime, ptt: false }
    } else {
      payload = {
        document: data,
        mimetype: mime,
        fileName: path.basename(resolved),
        caption: caption || undefined
      }
    }
const quotedRaw = quoted?.id && quoted?.jid ? this._getRawMessage(quoted.jid, quoted.id) : null
    await this.sock.sendMessage(jid, payload, quotedRaw ? { quoted: quotedRaw } : {})
  }

  async sendVoiceNote(jid, filePath, quoted) {
    this._requireOpen()
    if (!filePath) throw new Error('No voice note recorded')
    if (!ffmpegPath) throw new Error('FFmpeg is not installed. Run npm install before sending voice notes.')

    const output = `${filePath}.ogg`
    try {
      // Normalize browser recordings to the OGG/Opus format WhatsApp voice notes expect.
      await execFileAsync(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', filePath,
        '-vn',
        '-c:a', 'libopus',
        '-b:a', '32k',
        '-vbr', 'on',
        '-application', 'voip',
        '-map_metadata', '-1',
        output
      ])

      const data = fs.readFileSync(output)
      await this.sock.sendMessage(jid, {
        audio: data,
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true
      }, (() => { const quotedRaw = quoted?.id && quoted?.jid ? this._getRawMessage(quoted.jid, quoted.id) : null; return quotedRaw ? { quoted: quotedRaw } : {} })())
    } catch (err) {
      const detail = err?.stderr?.trim() || err?.message || 'FFmpeg conversion failed'
      throw new Error(`Voice note conversion failed: ${detail}`)
    } finally {
      try { fs.unlinkSync(output) } catch (_) {}
    }
  }

  async sendTyping(jid, on) {
    if (!this.settings.typingIndicator || !this.sock || this.connection !== 'open') return
    await this.sock.sendPresenceUpdate(on ? 'composing' : 'paused', jid).catch(() => {})
  }

  async loadMessages(jid, limit = 80) {
    const take = Math.max(1, Number(limit) || 80)
    const local = this.localDb.list(jid, Math.max(take, 500))
    const live = this.messageStore.get(jid) || []
    const merged = new Map()
    for (const message of local) if (message?.id) merged.set(message.id, message)
    for (const message of live) if (message?.id) merged.set(message.id, message)
    const list = [...merged.values()].sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
    if (list.length) this.messageStore.set(jid, list.slice(-500))
    return list.slice(-take)
  }

  async searchMessages(query, jid = null) {
    const q = String(query || '').trim().toLowerCase()
    if (!q) return []
    const out = this.localDb.search(q, jid)
    return out.map(m => ({ ...m, name: this._nameFor(m.jid) })).slice(0, 200)
  }

  async setChatMeta(jid, patch) {
    if (!jid) throw new Error('Chat is required')
    this.chatMeta[jid] = { ...(this.chatMeta[jid] || {}), ...(patch || {}) }
    fs.writeFileSync(this.chatMetaFile, JSON.stringify(this.chatMeta, null, 2))
    const chat = this.chats.get(jid) || { id: jid }
    if ('muted' in this.chatMeta[jid]) chat.mute = this.chatMeta[jid].muted ? -1 : 0
    if ('pinned' in this.chatMeta[jid]) chat.pin = !!this.chatMeta[jid].pinned
    this.chats.set(jid, chat)
    this.emit('chats', this.chatList())
    return this.chatMeta[jid]
  }

  async archiveChat(jid, archived = true) {
    this._requireOpen()
    try { await this.sock.chatModify({ archive: archived }, jid) } catch (_) {}
    return this.setChatMeta(jid, { archived })
  }

  async pinChat(jid, pinned = true) {
    this._requireOpen()
    try { await this.sock.chatModify({ pin: pinned }, jid) } catch (_) {}
    return this.setChatMeta(jid, { pinned })
  }

  async muteChat(jid, muted = true) {
    this._requireOpen()
    try { await this.sock.chatModify({ mute: muted ? { duration: 0 } : null }, jid) } catch (_) {}
    return this.setChatMeta(jid, { muted })
  }

  async groupAction(jid, action, participants = []) {
    this._requireOpen()
    if (!jid?.endsWith('@g.us')) throw new Error('This is not a group')
    const ids = (participants || []).filter(Boolean)
    if (action === 'metadata') return this.groupParticipants(jid)
    if (!ids.length) throw new Error('Select at least one participant')
    if (!['add','remove','promote','demote'].includes(action)) throw new Error('Unsupported group action')
    await this.sock.groupParticipantsUpdate(jid, ids, action)
    return this.groupParticipants(jid)
  }

  async groupUpdateSubject(jid, subject) {
    this._requireOpen();
    if (!subject?.trim()) throw new Error('Group name cannot be empty')
    await this.sock.groupUpdateSubject(jid, subject.trim())
    this.groupNames.set(jid, subject.trim())
    return this.groupParticipants(jid)
  }

  async groupLeave(jid) {
    this._requireOpen(); await this.sock.groupLeave(jid); return true
  }

  _persistLocalMessages(jid) {
    const arr = (this.messageStore.get(jid) || []).map(m => ({ ...m, raw: undefined }))
    this.localMessages[jid] = arr
    this.localDb.upsertMany(jid, arr)

    // The legacy JSON file is only for migration/backwards compatibility.
    // Never rewrite the entire message database synchronously for every event.
    clearTimeout(this._legacyPersistTimer)
    this._legacyPersistTimer = setTimeout(() => {
      try {
        fs.writeFileSync(this.localMessagesFile, JSON.stringify(this.localMessages))
      } catch (_) {}
    }, 1500)
  }

  _saveOutbox() {
    fs.writeFileSync(this.outboxFile, JSON.stringify(this.outbox, null, 2))
  }

  async _flushOutbox() {
    if (!this.outbox.length || !this.sock || this.connection !== 'open') return
    const pending = [...this.outbox]
    this.outbox = []
    this._saveOutbox()
    for (const item of pending) {
      try {
        if (item.type === 'text') await this.sendText(item.jid, item.text, item.quoted)
      } catch (_) {
        this.outbox.push(item)
      }
    }
    this._saveOutbox()
    this.emit('outbox', { count: this.outbox.length })
  }

  localDatabaseInfo() {
    const size = (file) => { try { return fs.statSync(file).size } catch (_) { return 0 } }
    const dirSize = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isFile() ? size(path.join(dir, e.name)) : 0), 0) } catch (_) { return 0 } }
    const bytes = {
      messagesDb: size(this.localDbFile), legacyMessages: size(this.localMessagesFile), settings: size(this.settingsFile),
      callHistory: size(this.callHistoryFile), backups: dirSize(path.join(this.dataDir, 'backups')), voiceNotes: dirSize(path.join(this.dataDir, 'voice-notes'))
    }
    bytes.total = Object.values(bytes).reduce((a, b) => a + b, 0)
    return { schema: 2, chats: this.localDb.index.size, messages: this.localDb.all().length, outbox: this.outbox.length, callHistory: this.callHistory.length, bytes }
  }

  exportLocalData() {
    return {
      schema: 2,
      exportedAt: new Date().toISOString(),
      settings: (() => { const copy = { ...(this.settings || {}), ai: { ...(this.settings?.ai || {}) } }; delete copy.ai.key; delete copy.ai.keyEncrypted; return copy })(),
      chatMeta: this.chatMeta,
      starred: this.starred,
      callHistory: this.callHistory,
      schedules: this.schedules,
      outbox: this.outbox,
      messages: this.localDb.exportData().messages
    }
  }

  async readMessages(jid, ids) {
    if (this.sock && this.connection === 'open' && ids?.length) {
      await this.sock.readMessages(ids.map((id) => ({ remoteJid: jid, id })))
    }
    const chat = this.chats.get(jid)
    if (chat) {
      chat.unreadCount = 0
      this.emit('chats', this.chatList())
    }
  }

  async downloadMedia(msgDto) {
    this._requireOpen()
    const raw = msgDto?.jid && msgDto?.id ? this._getRawMessage(msgDto.jid, msgDto.id) : null
    if (!raw) throw new Error('Media source is unavailable')
    const buf = await downloadMediaMessage(raw, 'buffer', {}, { logger })
    const mime = msgDto.mime || 'application/octet-stream'
    return { mime, dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
  }

  async editMessage(jid, msgId, newText) {
    this._requireOpen()
    const value = String(newText || '').trim()
    if (!value) throw new Error('Message cannot be empty')
    await this.sock.sendMessage(jid, {
      text: value,
      edit: { remoteJid: jid, id: msgId, fromMe: true }
    })
  }

  async deleteMessage(jid, msgId) {
    this._requireOpen()
    await this.sock.sendMessage(jid, {
      delete: { remoteJid: jid, id: msgId, fromMe: true }
    })
  }

  async reactMessage(jid, msgDto, reaction) {
    this._requireOpen()
    const raw = msgDto?.jid && msgDto?.id ? this._getRawMessage(msgDto.jid, msgDto.id) : null
    if (!raw?.key) throw new Error('Message key is unavailable')
    await this.sock.sendMessage(jid, {
      react: { text: reaction || '', key: raw.key }
    })
  }

  async forwardMessage(jid, msgDto, targetJid) {
    this._requireOpen()
    const raw = msgDto?.jid && msgDto?.id ? this._getRawMessage(msgDto.jid, msgDto.id) : null
    if (!raw || !targetJid) throw new Error('Message cannot be forwarded')
    await this.sock.sendMessage(targetJid, { forward: raw })
  }

  async sendPoll(jid, name, options, settings = {}) {
    this._requireOpen()
    const values = (options || []).map(String).map((s) => s.trim()).filter(Boolean).slice(0, 12)
    if (!name || values.length < 2) throw new Error('A poll needs a title and at least two options')
    const selectableCount = Math.max(1, Math.min(values.length, Number(settings.selectableCount) || 1))
    const poll = {
      name: String(name).trim(),
      values,
      selectableCount,
      messageSecret: crypto.randomBytes(32)
    }
    await this.sock.sendMessage(jid, { poll })
  }

  async sendViewOnce(jid, text) {
    this._requireOpen()
    await this.sock.sendMessage(jid, { text: String(text), viewOnce: true })
  }

  async sendBroadcast(jids, text) {
    this._requireOpen()
    for (const jid of jids || []) {
      if (jid) await this.sock.sendMessage(jid, { text: String(text) })
    }
  }

  async sendMentionAll(jid, text) {
    this._requireOpen()
    const ids = await this.groupParticipants(jid)
    await this.sock.sendMessage(jid, { text: String(text), mentions: ids })
  }

  async sendSticker(jid, filePath) {
    this._requireOpen()
    const data = fs.readFileSync(filePath)
    const ext = path.extname(filePath).toLowerCase()
    // Baileys does not reliably convert arbitrary raster images into WebP.
    // Send a real sticker only when the selected file is already WebP.
    if (ext !== '.webp') throw new Error('Choose a .webp sticker file. Image-to-sticker conversion is not bundled.')
    await this.sock.sendMessage(jid, { sticker: data })
  }

  async setDisappearing(jid, seconds) {
    this._requireOpen()
    await this.sock.sendMessage(jid, { disappearingMessagesInChat: Number(seconds) })
  }

  async postStatus(text) {
    this._requireOpen()
    await this.sock.sendMessage('status@broadcast', { text: String(text) })
  }

  async postStatusImage(filePath, caption = '') {
    this._requireOpen()
    const ext = path.extname(filePath).toLowerCase()
    await this.sock.sendMessage('status@broadcast', {
      image: fs.readFileSync(filePath),
      mimetype: MIME[ext] || 'image/jpeg',
      caption: caption || undefined
    })
  }

  async groupParticipants(jid) {
    this._requireOpen()
    const meta = await this.sock.groupMetadata(jid)
    if (meta?.subject) this.groupNames.set(jid, meta.subject)
    return (meta?.participants || []).map((p) => p.id)
  }

  async setPrivacy(key, value) {
    this._requireOpen()
    const method = PRIVACY_METHODS[key]
    if (!method || typeof this.sock[method] !== 'function') {
      throw new Error(`Privacy setting is not supported by this WhatsApp session: ${key}`)
    }
    await this.sock[method](value)
    this.settings.privacy = { ...(this.settings.privacy || {}), [key]: value }
    await this.setSettings({ privacy: this.settings.privacy })
  }

  _wireActiveCall(call, targetJid, isVideo, direction = 'outgoing') {
    if (!call?.callId) return
    this.activeCalls.set(call.callId, call)
    const type = isVideo ? 'video' : 'voice'
    const emitState = (status) => {
      this.emit('call:state', {
        id: call.callId,
        jid: targetJid,
        type,
        direction,
        status,
        timestamp: Date.now()
      })
    }
    call.on('ringing', () => { emitState('ringing'); this.recordCall({ id: call.callId, jid: targetJid, type, direction, status: 'ringing', timestamp: Date.now() }) })
    call.on('accepted', () => { emitState('accepted') })
    call.on('connected', () => {
      emitState('connected')
      this.recordCall({ id: call.callId, jid: targetJid, type, direction, status: 'connected', timestamp: Date.now() })
    })
    call.on('audio', (pcm) => {
      if (pcm?.buffer) this.emit('call:audio', { id: call.callId, sampleRate: 16000, channels: 1, pcm })
    })
    call.on('video', (frame) => {
      if (frame?.frameBuffer) this.emit('call:video', {
        id: call.callId,
        width: Number(frame.width || 0),
        height: Number(frame.height || 0),
        format: Number(frame.format || 1),
        orientation: Number(frame.orientation || 0),
        frameBuffer: frame.frameBuffer
      })
    })
    call.on('error', (error) => {
      emitState('error')
      this.emit('call:error', { id: call.callId, jid: targetJid, message: error?.message || String(error) })
    })
    call.on('ended', (reason) => {
      emitState('ended')
      this.recordCall({ id: call.callId, jid: targetJid, type, direction, status: reason || 'ended', timestamp: Date.now() })
      this.activeCalls.delete(call.callId)
    })
    emitState('initiating')
  }

  async callAction(action, callId, targetJid, isVideo = false) {
    if (!this.sock || !targetJid) throw new Error('WhatsApp is not connected')
    const type = isVideo ? 'video' : 'voice'

    if (action === 'reject') {
      if (callId && typeof this.sock.rejectCall === 'function') {
        await this.sock.rejectCall(callId, targetJid).catch((e) => logger.warn('call reject failed: %s', e.message))
      }
      this.recordCall({ id: callId || `local_${Date.now()}`, jid: targetJid, type, direction: 'incoming', status: 'reject', timestamp: Date.now() })
      return { ok: true }
    }

    if (action === 'hangup') {
      if (callId && typeof this.sock.endCall === 'function') {
        await this.sock.endCall(callId).catch(() => {})
      } else if (callId && this.activeCalls.has(callId)) {
        this.activeCalls.get(callId).end('hangup')
      }
      this.recordCall({ id: callId || `local_${Date.now()}`, jid: targetJid, type, direction: 'outgoing', status: 'terminate', timestamp: Date.now() })
      return { ok: true }
    }

    if (action === 'start') {
      if (typeof this.sock.initiateCall !== 'function') {
        throw new Error('The installed WhatsApp VoIP stack does not expose initiateCall')
      }

      // The Innovators Soft Baileys fork bridges Baileys signaling to the
      // WhatsApp Web VoIP WASM/RTP stack. The capture patch installed by
      // postinstall adds live macOS AVFoundation microphone/camera sources.
      const options = {
        isVideo: !!isVideo,
        audioSource: 'microphone:0',
        durationMs: 0,
        repeatAudio: true,
        preRingingTimeoutMs: 30000
      }
      if (isVideo) {
        options.videoSource = 'camera:0'
        options.videoWidth = 640
        options.videoHeight = 480
        options.videoFps = 15
        options.isHorizontal = false
      }

      const call = await this.sock.initiateCall(targetJid, options)
      const id = call?.callId || call?.id || callId || `out_${Date.now()}`
      this._wireActiveCall(call, targetJid, isVideo, 'outgoing')
      this.recordCall({ id, jid: targetJid, type, direction: 'outgoing', status: 'offer', timestamp: Date.now() })
      return { id, callId: id, ok: true }
    }

    if (action === 'accept') {
      if (typeof this.sock.preacceptCall === 'function') {
        await this.sock.preacceptCall(callId, targetJid, !!isVideo)
      }
      if (typeof this.sock.acceptCall !== 'function') {
        throw new Error('This WhatsApp VoIP build cannot accept calls')
      }
      await this.sock.acceptCall(callId, targetJid, !!isVideo)
      this.recordCall({ id: callId || `local_${Date.now()}`, jid: targetJid, type, direction: 'incoming', status: 'accept', timestamp: Date.now() })
      this.emit('call:state', { id: callId, jid: targetJid, type, direction: 'incoming', status: 'accepted', timestamp: Date.now() })
      return { ok: true }
    }

    throw new Error(`Unsupported call action: ${action}`)
  }
  async rejectCall(callId, targetJid) {
    return this.callAction('reject', callId, targetJid, false)
  }

  recordCall(entry) {
    const item = {
      id: String(entry?.id || `call_${Date.now()}`),
      jid: entry?.jid || entry?.from || '',
      type: entry?.type || (entry?.isVideo ? 'video' : 'voice'),
      direction: entry?.direction || 'incoming',
      status: entry?.status || 'unknown',
      group: !!entry?.group,
      groupJid: entry?.groupJid || null,
      timestamp: Number(entry?.timestamp || Date.now())
    }
    this.callHistory = [item, ...this.callHistory.filter((x) => x.id !== item.id)].slice(0, 200)
    try { fs.writeFileSync(this.callHistoryFile, JSON.stringify(this.callHistory, null, 2)) } catch (_) {}
    this.emit('calls', this.callHistory)
    return item
  }

  getCallHistory() { return this.callHistory }

  async clearCallHistory() {
    this.callHistory = []
    await fs.promises.writeFile(this.callHistoryFile, '[]', 'utf8')
    this.emit('calls', this.callHistory)
    return true
  }

  async createCallLink(type = 'audio') {
    if (!this.sock || typeof this.sock.createCallLink !== 'function') {
      throw new Error('WhatsApp call links are not available on this session')
    }
    const link = await this.sock.createCallLink(type === 'video' ? 'video' : 'audio')
    return String(link)
  }

  chatList() {
    return [...this.chats.values()]
      .map((c) => ({
        id: c.id,
        name: this._nameFor(c.id),
        unread: Number(c.unreadCount || c.unread || 0),
        muted: !!c.mute || !!this.chatMeta[c.id]?.muted,
        pinned: !!c.pin || !!this.chatMeta[c.id]?.pinned,
        archived: !!this.chatMeta[c.id]?.archived,
        lastMessage: c.lastMessage
          ? (c.lastMessage.jid ? c.lastMessage : this._msgDto(c.lastMessage))
          : null,
        timestamp: Number(c.conversationTimestamp || 0)
      }))
      .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.timestamp - a.timestamp))
  }

  contactList() {
    return [...this.contacts.values()].map((c) => ({
      id: c.jid || c.id,
      name: c.name || c.notify || c.verifiedName || this._jidToName(c.jid || c.id),
      number: c.phoneNumber || String(c.jid || c.id).split('@')[0]
    }))
  }

  _nameFor(jid) {
    if (!jid) return 'Unknown'
    if (jid.endsWith('@g.us')) return this.groupNames.get(jid) || 'Group'
    const c = this.contacts.get(jid)
    return c?.name || c?.notify || c?.verifiedName || this._jidToName(jid)
  }

  _jidToName(jid) {
    const num = String(jid || '').split('@')[0]
    return num.length >= 4 ? `+${num.slice(0, -4)} ${num.slice(-4)}` : num || 'Unknown'
  }

  _textOf(m) {
    const c = m?.message
    if (!c) return ''
    return c.conversation ||
      c.extendedTextMessage?.text ||
      c.imageMessage?.caption ||
      c.videoMessage?.caption ||
      c.documentMessage?.caption || ''
  }

  _messageCacheKey(jid, id) {
    return String(jid || '') + ':' + String(id || '')
  }

  _rememberRawMessage(jid, id, raw) {
    if (!jid || !id || !raw) return
    this.rawMessages.set(this._messageCacheKey(jid, id), raw)
    while (this.rawMessages.size > this.rawMessageLimit) {
      const first = this.rawMessages.keys().next().value
      if (first === undefined) break
      this.rawMessages.delete(first)
    }
  }

  _getRawMessage(jid, id) {
    return this.rawMessages.get(this._messageCacheKey(jid, id)) || null
  }

  _msgDto(m) {
    const key = m?.key || {}
    const c = m?.message || {}
    let text = ''
    let kind = 'text'
    let mime = ''
    let caption = ''

    if (c.conversation) {
      text = c.conversation
    } else if (c.extendedTextMessage) {
      text = c.extendedTextMessage.text || ''
    } else if (c.imageMessage) {
      kind = 'image'; mime = c.imageMessage.mimetype || 'image/jpeg'; caption = c.imageMessage.caption || ''
    } else if (c.videoMessage) {
      kind = 'video'; mime = c.videoMessage.mimetype || 'video/mp4'; caption = c.videoMessage.caption || ''
    } else if (c.audioMessage) {
      kind = 'audio'; mime = c.audioMessage.mimetype || 'audio/ogg'
    } else if (c.stickerMessage) {
      kind = 'sticker'; mime = c.stickerMessage.mimetype || 'image/webp'
    } else if (c.documentMessage) {
      kind = 'document'; mime = c.documentMessage.mimetype || 'application/octet-stream'; text = c.documentMessage.fileName || 'Document'
    } else if (c.contactMessage || c.contactsArrayMessage) {
      kind = 'contact'; text = c.contactMessage?.displayName || 'Contact'
    } else if (c.locationMessage || c.liveLocationMessage) {
      kind = 'location'; text = '📍 Location'
    } else if (c.reactionMessage) {
      kind = 'reaction'; text = c.reactionMessage.text || ''
    } else if (c.pollCreationMessage || c.pollCreationMessageV3) {
      kind = 'poll'; text = c.pollCreationMessage?.name || c.pollCreationMessageV3?.name || 'Poll'
    } else if (c.protocolMessage) {
      kind = 'system'; text = 'Message deleted'
    } else if (c.buttonsMessage || c.listMessage || c.templateMessage || c.interactiveMessage) {
      kind = 'interactive'; text = 'Interactive message'
    } else {
      kind = 'unknown'; text = ''
    }

    return {
      id: key.id,
      jid: key.remoteJid,
      fromMe: !!key.fromMe,
      timestamp: m.messageTimestamp ? Number(m.messageTimestamp) * 1000 : Date.now(),
      text, kind, mime, caption,
      pushName: m.pushName || '',
      status: key.fromMe ? (m.status || 'PENDING') : undefined,
      quoted: c.extendedTextMessage?.contextInfo?.quotedMessage
        ? {
            id: c.extendedTextMessage.contextInfo.stanzaId || '',
            jid: key.remoteJid || '',
            participant: c.extendedTextMessage.contextInfo.participant || '',
            text: c.extendedTextMessage.contextInfo.quotedMessage.conversation || c.extendedTextMessage.contextInfo.quotedMessage.extendedTextMessage?.text || ''
          }
        : null
    }
  }

  _readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (_) { return fallback }
  }

  getLinkedSession() {
    const meta = this.settings.linkedSession || {}
    const user = this.userInfo()
    return {
      connection: this.connection,
      hasSession: this.hasSession(),
      savedLocally: this.hasSession(),
      phone: user?.number || meta.phone || null,
      name: user?.name || null,
      linkedAt: meta.linkedAt || null,
      lastActiveAt: meta.lastActiveAt || null
    }
  }

  getSettings() {
    const settings = { ...this.settings }
    settings.ai = { ...(this.settings.ai || {}) }
    delete settings.ai.key
    settings.ai.keyStored = !!(this.settings.ai?.keyEncrypted || this.settings.ai?.key)
    return settings
  }
  getStarred() { return this.starred }
  getSchedules() { return this.schedules }

  async clearBackups() {
    const dir = path.join(this.dataDir, 'backups')
    try { await fs.promises.rm(dir, { recursive: true, force: true }) } catch (_) {}
    return true
  }

  async setSettings(patch) {
    const next = { ...(patch || {}) }
    if (next.ai) {
      next.ai = { ...(this.settings.ai || {}), ...next.ai }
      // Renderer settings updates must never write a plaintext API key.
      if (Object.prototype.hasOwnProperty.call(next.ai, 'key')) delete next.ai.key
    }
    this.settings = { ...this.settings, ...next }
    await fs.promises.writeFile(this.settingsFile, JSON.stringify(this.settings, null, 2), 'utf8')
    this.emit('settings', this.getSettings())
    return this.getSettings()
  }

  getAiSecret() {
    return String(this.settings.ai?.key || '')
  }

  async setAiEncryptedSecret(value) {
    const ai = { ...(this.settings.ai || {}) }
    delete ai.key
    ai.keyEncrypted = String(value || '')
    this.settings.ai = ai
    await fs.promises.writeFile(this.settingsFile, JSON.stringify(this.settings, null, 2), 'utf8')
    this.emit('settings', this.getSettings())
    return true
  }

  async addAutoReply(rule) {
    const rules = this.settings.autoReply || []
    const item = { id: Date.now().toString(36), enabled: true, ...rule }
    rules.push(item)
    await this.setSettings({ autoReply: rules })
    return item
  }

  async removeAutoReply(id) {
    await this.setSettings({
      autoReply: (this.settings.autoReply || []).filter((r) => r.id !== id)
    })
  }

  async toggleStarred(msgDto) {
    const idx = this.starred.findIndex((s) => s.id === msgDto.id && s.jid === msgDto.jid)
    if (idx >= 0) this.starred.splice(idx, 1)
    else this.starred.unshift({
      id: msgDto.id, jid: msgDto.jid, text: msgDto.text,
      kind: msgDto.kind, ts: msgDto.timestamp, name: this._nameFor(msgDto.jid)
    })
    fs.writeFileSync(this.starredFile, JSON.stringify(this.starred, null, 2))
    return this.starred
  }

  async addSchedule(s) {
    const item = { id: Date.now().toString(36), done: false, ...s }
    this.schedules.push(item)
    this._saveSchedules()
    this.emit('schedules', this.schedules)
    return item
  }

  async removeSchedule(id) {
    this.schedules = this.schedules.filter((s) => s.id !== id)
    this._saveSchedules()
    this.emit('schedules', this.schedules)
  }

  _saveSchedules() {
    fs.writeFileSync(this.scheduleFile, JSON.stringify(this.schedules, null, 2))
  }

  async _tick() {
    if (this.tickBusy || this.connection !== 'open' || !this.schedules.length) return
    this.tickBusy = true
    try {
      const now = Date.now()
      for (const s of this.schedules) {
        if (s.done || !s.jid || !s.text) continue
        if (new Date(s.at).getTime() <= now) {
          try {
            await this.sendText(s.jid, s.text)
            s.done = true
          } catch (_) {}
          this._saveSchedules()
          this.emit('schedules', this.schedules)
        }
      }
    } finally {
      this.tickBusy = false
    }
  }

  _requireOpen() {
    if (!this.sock || this.connection !== 'open') {
      throw new Error('Not connected — pair your phone first')
    }
  }
}

module.exports = WhatsAppCore
