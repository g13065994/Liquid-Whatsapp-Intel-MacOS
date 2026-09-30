const $ = (id) => document.getElementById(id)

let pairingInProgress = false

function applyPerformanceProfile() {
  const cores = Number(navigator.hardwareConcurrency || 4)
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const mode = Store.settings?.performanceMode || 'auto'
  const lowPower = mode === 'low' || (mode === 'auto' && (cores <= 4 || reduced))
  document.body.classList.toggle('liquid-performance', lowPower)
  document.body.classList.toggle('reduce-motion', reduced || mode === 'low')
}

async function init() {
  try {
    api.subscribe()
    const boot = await api.init()
    wireEvents()
    wireStaticUI()
    applyTheme(boot.settings?.theme || 'system')
    window.liquidGlass?.apply(boot.settings?.glassStyle || 'tinted')
    applyPerformanceProfile()
    if (boot.hasSession) enterApp()
    else showLogin()
  } catch (e) {
    const status = $('login-status')
    if (status) {
      status.className = 'status-line err'
      status.textContent = e?.message || 'Liquid WhatsApp could not start. Open View → Toggle Developer Tools for details.'
    }
    console.error('[renderer] boot failed', e)
    showLogin()
    if (status) {
      status.className = 'status-line err'
      status.textContent = e?.message || 'Liquid WhatsApp could not start. Open View → Toggle Developer Tools for details.'
    }
  }
}

function showLogin() {
  pairingInProgress = false
  $('login-view').classList.remove('hidden')
  $('app-view').classList.add('hidden')
  $('login-btn').disabled = false
  $('pair-code').classList.add('hidden')
  $('pair-code-value').textContent = '—'
  $('login-status').className = 'status-line'
  $('login-status').textContent = ''
}

function enterApp() {
  $('login-view').classList.add('hidden')
  $('app-view').classList.remove('hidden')
  renderMe()
  renderChatList()
}

function renderMe() {
  const u = Store.user
  if (u) {
    $('me-name').textContent = u.name || u.number || 'Me'
    $('me-avatar').textContent = ui.initials(u.name || u.number)
  }
  const c = $('conn-status')
  c.className = 'conn ' + (Store.conn === 'open' ? 'online' : Store.conn === 'close' || Store.conn === 'idle' ? 'offline' : '')
  const offline = Store.conn !== 'open'
  const localText = offline && Store.chats.length ? ' Offline · local history' : ' Offline'
  c.innerHTML = '<span class="dot"></span> ' + (Store.conn === 'open' ? ' Online' : Store.conn === 'connecting' ? ' Connecting…' : Store.conn === 'close' ? ' Reconnecting…' : localText)
}

// Variables to capture active phone network call signaling states
let activeCallId = null
let activeCallJid = null
let activeCallVideo = false
let activeCallDirection = 'incoming'
let callAudioContext = null
let callAudioNextTime = 0
let callVideoFrameBusy = false
let quotedMessage = null
let pingTimer = null
let pingRequestInFlight = false
const friendPresenceSeenAt = new Map()

function wireEvents() {
  api.on('connection', (u) => {
    if (u.connection === 'open') { pairingInProgress = false }
    if (u.connection === 'open' && !Store.user && u.user) { Store.user = u.user }
    if (pairingInProgress && u.connection === 'close' && !u.loggedOut) {
      pairingInProgress = false
      if ($('app-view').classList.contains('hidden')) {
        $('login-status').className = 'status-line err'
        $('login-status').textContent = 'WhatsApp disconnected before linking. Please try again.'
        $('login-btn').disabled = false
      }
    }
    if (u.connection === 'open' && $('app-view').classList.contains('hidden')) enterApp()
    if (u.loggedOut) { Store.reset(); showLogin(); renderMe(); return }
    renderMe()
  })
  api.on('chats', () => scheduleChatRender())
  api.on('messages', ({ jid }) => {
    if (jid === Store.activeJid) scheduleMessageRender()
    else if (!document.hidden) {
      const unread = Store.messagesOf(jid).filter((m) => !m.fromMe && m.id).map((m) => m.id)
      if (unread.length) window.liquid.read(jid, unread)
    }
    scheduleChatRender()
  })
  api.on('presence', ({ jid, state }) => {
    if (jid) friendPresenceSeenAt.set(jid, Date.now())
    if (jid === Store.activeJid) {
      renderPresence()
      renderFriendSignal()
    }
  })
  api.on('settings', (s) => {
    applyTheme(s?.theme || 'system')
    window.liquidGlass?.apply(s?.glassStyle || 'tinted')
    applyPerformanceProfile()
  })
  api.on('calls', (history) => { Store.callHistory = history || [] })
  api.on('call-state', (state) => {
    activeCallId = state?.id || activeCallId
    activeCallJid = state?.jid || activeCallJid
    activeCallVideo = state?.type === 'video'
    activeCallDirection = state?.direction || activeCallDirection
  })
  api.on('call-error', (error) => ui.toast(error?.message || 'WhatsApp call failed'))
  api.on('call-video', (frame) => renderRemoteCallVideo(frame))
  api.on('call-audio', (packet) => {
    const pcm = packet?.pcm instanceof Float32Array
      ? packet.pcm
      : (packet?.pcm?.buffer instanceof ArrayBuffer ? new Float32Array(packet.pcm.buffer) : null)
    if (!pcm?.length) return
    try {
      if (!callAudioContext) callAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: packet.sampleRate || 16000 })
      if (callAudioContext.state === 'suspended') callAudioContext.resume().catch(() => {})
      const buffer = callAudioContext.createBuffer(1, pcm.length, packet.sampleRate || 16000)
      buffer.copyToChannel(pcm, 0)
      const source = callAudioContext.createBufferSource()
      source.buffer = buffer
      source.connect(callAudioContext.destination)
      const now = callAudioContext.currentTime
      callAudioNextTime = Math.max(callAudioNextTime, now + 0.01)
      source.start(callAudioNextTime)
      callAudioNextTime += buffer.duration
    } catch (_) {}
  })
  api.on('open-chat', (jid) => openChat(jid))
  api.on('outbox', ({ count }) => {
    $('outbox-status').textContent = count ? `${count} message${count === 1 ? '' : 's'} queued` : 'Session saved on this Mac'
  })

}

let voiceRecorder = null
let voiceChunks = []
let voiceStartedAt = 0
let voiceTimer = null
let voiceStream = null
let voiceAnalyser = null
let voiceLevelFrame = null

function formatVoiceTime(ms) {
  const sec = Math.floor(ms / 1000)
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
}

function stopVoiceLevel() {
  if (voiceLevelFrame) cancelAnimationFrame(voiceLevelFrame)
  voiceLevelFrame = null
  const fill = $('voice-level-fill')
  if (fill) fill.style.width = '8%'
}

function cleanupVoiceStream() {
  if (voiceStream) voiceStream.getTracks().forEach(t => t.stop())
  voiceStream = null
  voiceAnalyser = null
  stopVoiceLevel()
}

function drawVoiceLevel() {
  if (!voiceAnalyser) return
  const data = new Uint8Array(voiceAnalyser.fftSize)
  const tick = () => {
    if (!voiceAnalyser) return
    voiceAnalyser.getByteTimeDomainData(data)
    let sum = 0
    for (const v of data) { const n = (v - 128) / 128; sum += n * n }
    const rms = Math.sqrt(sum / data.length)
    const fill = $('voice-level-fill')
    if (fill) fill.style.width = `${Math.min(100, 8 + rms * 220)}%`
    voiceLevelFrame = requestAnimationFrame(tick)
  }
  tick()
}

async function startVoiceNote() {
  if (!Store.activeJid || voiceRecorder) return
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    ui.toast('Voice recording is not supported by this macOS/Electron build')
    return
  }
  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
    voiceRecorder = new MediaRecorder(voiceStream, { mimeType: mime })
    voiceChunks = []
    voiceStartedAt = Date.now()
    voiceRecorder.ondataavailable = e => { if (e.data.size) voiceChunks.push(e.data) }
    voiceRecorder.onstop = () => {}
    const AudioCtx = window.AudioContext || window.webkitAudioContext
    if (AudioCtx) {
      const ctx = new AudioCtx()
      const source = ctx.createMediaStreamSource(voiceStream)
      voiceAnalyser = ctx.createAnalyser(); voiceAnalyser.fftSize = 256
      source.connect(voiceAnalyser)
      drawVoiceLevel()
    }
    $('voice-recorder').classList.remove('hidden')
    $('composer-input').classList.add('hidden')
    $('btn-send').classList.add('hidden')
    $('btn-voice').classList.add('recording')
    voiceTimer = setInterval(() => { $('voice-timer').textContent = formatVoiceTime(Date.now() - voiceStartedAt) }, 250)
    voiceRecorder.start(200)
  } catch (e) {
    cleanupVoiceStream()
    ui.toast(e.name === 'NotAllowedError' ? 'Microphone access was denied' : (e.message || 'Could not start recording'))
  }
}

function resetVoiceUI() {
  if (voiceTimer) clearInterval(voiceTimer)
  voiceTimer = null
  $('voice-timer').textContent = '0:00'
  $('voice-recorder').classList.add('hidden')
  $('composer-input').classList.remove('hidden')
  $('btn-send').classList.remove('hidden')
  $('btn-voice').classList.remove('recording')
}

async function cancelVoiceNote() {
  if (voiceRecorder) { voiceRecorder.ondataavailable = null; voiceRecorder.stop(); voiceRecorder = null }
  cleanupVoiceStream(); resetVoiceUI(); voiceChunks = []
}

async function finishVoiceNote(send = true) {
  if (!voiceRecorder) return
  const recorder = voiceRecorder
  const duration = Date.now() - voiceStartedAt
  const stopped = new Promise(resolve => { recorder.addEventListener('stop', resolve, { once: true }) })
  recorder.stop()
  await stopped
  voiceRecorder = null
  cleanupVoiceStream(); resetVoiceUI()
  const chunks = voiceChunks; voiceChunks = []
  if (!send || !chunks.length || duration < 300 || !Store.activeJid) return
  try {
    const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
    const reader = new FileReader()
    const dataUrl = await new Promise((resolve, reject) => { reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob) })
    await window.liquid.sendVoiceNote(Store.activeJid, dataUrl, duration, quotedMessage)
    clearQuote()
  } catch (e) { ui.toast(e.message || 'Voice message failed to send') }
}

function renderRemoteCallVideo(frame) {
  const canvas = $('callRemoteVideo')
  if (!canvas || callVideoFrameBusy || !frame) return
  const width = Number(frame.width || 0)
  const height = Number(frame.height || 0)
  if (!width || !height) return
  const raw = frame.frameBuffer instanceof Uint8Array
    ? frame.frameBuffer
    : (frame.frameBuffer instanceof ArrayBuffer ? new Uint8Array(frame.frameBuffer) : null)
  if (!raw || raw.length < Math.floor(width * height * 1.5)) return
  callVideoFrameBusy = true
  try {
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { alpha: false })
    const image = ctx.createImageData(width, height)
    const ySize = width * height
    const uvWidth = width >> 1
    const uvHeight = height >> 1
    const uOffset = ySize
    const vOffset = ySize + uvWidth * uvHeight
    let p = 0
    for (let y = 0; y < height; y++) {
      const uvRow = (y >> 1) * uvWidth
      for (let x = 0; x < width; x++) {
        const Y = raw[y * width + x]
        const U = raw[uOffset + uvRow + (x >> 1)] - 128
        const V = raw[vOffset + uvRow + (x >> 1)] - 128
        const r = Math.max(0, Math.min(255, Y + 1.402 * V))
        const g = Math.max(0, Math.min(255, Y - 0.344136 * U - 0.714136 * V))
        const b = Math.max(0, Math.min(255, Y + 1.772 * U))
        image.data[p++] = r
        image.data[p++] = g
        image.data[p++] = b
        image.data[p++] = 255
      }
    }
    ctx.putImageData(image, 0, 0)
    canvas.classList.remove('hidden')
  } catch (_) {
    canvas.classList.add('hidden')
  } finally {
    callVideoFrameBusy = false
  }
}

function wireStaticUI() {
  api.on('update-available', async (info) => {
    const version = info?.version || 'new'
    const status = $('update-status')
    if (status) status.textContent = `Version ${version} is available. Download it when you're ready.`
    const choice = window.confirm(`Liquid WhatsApp ${version} is available. Download the update now? The updater uses differential downloads when supported, so it can avoid re-downloading unchanged blocks.`)
    if (!choice) return
    try {
      await window.liquid.downloadUpdate()
      if (status) status.textContent = `Downloading Liquid WhatsApp ${version}…`
    } catch (e) {
      ui.toast(e?.message || 'Could not start the update download')
    }
  })
  api.on('update-progress', (p) => {
    const status = $('update-status')
    if (!status) return
    const pct = Math.max(0, Math.min(100, Number(p?.percent) || 0))
    status.textContent = `Downloading update… ${pct.toFixed(0)}%`
  })
  api.on('update-downloaded', async (info) => {
    const version = info?.version || 'new'
    const status = $('update-status')
    if (status) status.textContent = `Update ${version} is ready to install.`
    const choice = window.confirm(`Liquid WhatsApp ${version} is downloaded and ready. Install it now and restart the app?`)
    if (!choice) return
    try { await window.liquid.installUpdate() } catch (e) { ui.toast(e?.message || 'Could not install the update') }
  })
  api.on('update-error', (e) => {
    const status = $('update-status')
    if (status) status.textContent = 'Update check/download failed. You can try again later.'
  })
  api.on('update-cancelled', () => {
    const status = $('update-status')
    if (status) status.textContent = 'Update download cancelled.'
  })
  api.on('update-not-available', (info) => {
    const status = $('update-status')
    const version = info?.version || 'current'
    if (status) status.textContent = `Liquid WhatsApp is up to date (v${version})`
  })
  $('btn-voice').addEventListener('click', () => voiceRecorder ? finishVoiceNote(true) : startVoiceNote())
  $('voice-cancel').addEventListener('click', cancelVoiceNote)
  $('voice-send').addEventListener('click', () => finishVoiceNote(true))
  document.addEventListener('click', (e) => {
    const link = e.target.closest('.external-link')
    if (!link) return
    e.preventDefault()
    const url = link.dataset.url
    if (url) window.liquid.openExternal(url)
  })
  $('check-updates')?.addEventListener('click', async () => {
    const status = $('update-status')
    if (status) status.textContent = 'Checking GitHub Releases…'
    try {
      await window.liquid.checkForUpdates()
    } catch (e) {
      if (status) status.textContent = 'Could not check for updates.'
      ui.toast(e?.message || 'Could not check for updates')
    }
  })
  $('login-btn').addEventListener('click', doPair)
  $('login-number').addEventListener('keydown', (e) => { if (e.key === 'Enter') doPair() })
  $('copy-pair-code').addEventListener('click', async () => {
    const code = $('pair-code-value').textContent.replace(/-/g, '').trim()
    if (!code || code === '—') return
    try {
      window.liquid.copyText(code)
      ui.toast('Pairing code copied')
    } catch (_) {
      ui.toast('Could not copy the pairing code')
    }
  })

  $('btn-new-chat').addEventListener('click', () => openNewChat())
  $('btn-new-chat-empty').addEventListener('click', () => openNewChat())
  $('btn-status').addEventListener('click', openStatusModal)
  $('btn-starred').addEventListener('click', openStarredModal)
  $('btn-settings').addEventListener('click', openSettingsModal)
  $('btn-calls').addEventListener('click', openCallsModal)
  $('btn-profile').addEventListener('click', openProfileModal)
  $('btn-chat-search').addEventListener('click', openMessageSearchModal)
  $('btn-gallery').addEventListener('click', openGalleryModal)
  $('btn-logout').addEventListener('click', async () => {
    ui.prompt('Log out', 'Type LOGOUT to confirm', '', (v) => {
      if (v.toUpperCase() === 'LOGOUT') window.liquid.logout()
    })
  })
  $('search').addEventListener('input', (e) => { Store.search = e.target.value; renderChatList() })
  document.querySelectorAll('#filter-tabs .tab').forEach((t) => {
    t.addEventListener('click', () => {
      document.querySelectorAll('#filter-tabs .tab').forEach((x) => x.classList.remove('active'))
      t.classList.add('active')
      Store.filter = t.dataset.filter
      renderChatList()
    })
  })

  $('btn-media').addEventListener('click', async () => {
    await window.liquid.sendMedia(Store.activeJid, '', quotedMessage)
    clearQuote()
  })
  $('quote-cancel').addEventListener('click', clearQuote)
  $('btn-poll').addEventListener('click', openPollModal)
  $('btn-viewonce').addEventListener('click', openViewOnceModal)
  $('btn-disappear').addEventListener('click', openDisappearModal)
  $('btn-ai').addEventListener('click', openAiModal)
  $('btn-mention-all').addEventListener('click', () => {
    ui.prompt('Message to @all', 'Type message', '', (t) => window.liquid.mentionAll(Store.activeJid, t))
  })
  $('btn-send').addEventListener('click', sendMessage)
  $('composer-input').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && voiceRecorder) { e.preventDefault(); cancelVoiceNote(); return }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
  })
  const composer = $('composer')
  const dropHint = $('drop-hint')
  ;['dragenter','dragover'].forEach(ev => composer.addEventListener(ev, (e) => { e.preventDefault(); dropHint.classList.remove('hidden') }))
  ;['dragleave','drop'].forEach(ev => composer.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'dragleave' && e.relatedTarget && composer.contains(e.relatedTarget)) return; dropHint.classList.add('hidden') }))
  composer.addEventListener('drop', async (e) => {
    if (!Store.activeJid || !e.dataTransfer.files.length) return
    for (const file of e.dataTransfer.files) { await window.liquid.sendDroppedMedia(Store.activeJid, file.path, '', quotedMessage).catch(err => ui.toast(err.message || 'Upload failed')) }
    clearQuote()
  })
  $('composer-input').addEventListener('input', () => {
    clearTimeout(Store.typingTimers.get(Store.activeJid))
    window.liquid.typing(Store.activeJid, true)
    Store.typingTimers.set(Store.activeJid, setTimeout(() => window.liquid.typing(Store.activeJid, false), 2000))
  })

  // Open the real WhatsApp Web calling stack in a dedicated persistent window.
  // WhatsApp Web performs the actual call/media handling; Liquid WhatsApp does not
  // attempt to fabricate or reimplement WhatsApp's encrypted call transport.
  $('headerVoiceCallBtn').addEventListener('click', async () => {
    if (!Store.activeJid || Store.activeJid.endsWith('@g.us')) return
    try {
      await window.liquid.openWhatsAppWebCall(Store.activeJid, false)
      ui.toast('WhatsApp Web opened for this chat. Use its call button to start the call.')
    } catch (e) {
      ui.toast(e.message || 'Could not open WhatsApp Web calling')
    }
  })
  $('headerVideoCallBtn').addEventListener('click', async () => {
    if (!Store.activeJid || Store.activeJid.endsWith('@g.us')) return
    try {
      await window.liquid.openWhatsAppWebCall(Store.activeJid, true)
      ui.toast('WhatsApp Web opened for this chat. Use its video button to start the call.')
    } catch (e) {
      ui.toast(e.message || 'Could not open WhatsApp Web calling')
    }
  })

  document.addEventListener('keydown', (e) => {
    const cmd = e.metaKey || e.ctrlKey
    if (cmd && e.key.toLowerCase() === 'k') { e.preventDefault(); $('search').focus(); $('search').select() }
    if (cmd && e.key.toLowerCase() === 'f' && Store.activeJid) { e.preventDefault(); openMessageSearchModal() }
    if (e.key === 'Escape') {
      if (!$('modal-overlay').classList.contains('hidden')) ui.closeModal()
      else if (!$('viewer').classList.contains('hidden')) $('viewer').classList.add('hidden')
      else if (quotedMessage) clearQuote()
    }
  })

  $('modal-close').addEventListener('click', ui.closeModal)
  $('modal-overlay').addEventListener('click', (e) => { if (e.target === $('modal-overlay')) ui.closeModal() })
  $('viewer-close').addEventListener('click', () => $('viewer').classList.add('hidden'))
  document.querySelector('.viewer-backdrop').addEventListener('click', () => $('viewer').classList.add('hidden'))
  document.addEventListener('click', ui.hideCtx)
}

function applyTheme(theme) {
  const value = theme || 'system'
  const dark = value === 'dark' || (value === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = value
  document.body.classList.toggle('dark', !!dark)
  document.body.classList.toggle('light', !dark)
}

function filteredChats() {
  const q = Store.search.toLowerCase()
  let list = Store.chats
  if (Store.filter === 'unread') list = list.filter((c) => c.unread > 0)
  if (Store.filter === 'groups') list = list.filter((c) => c.id.endsWith('@g.us'))
  if (Store.filter === 'archived') list = list.filter((c) => c.archived)
  else list = list.filter((c) => !c.archived)
  if (q) list = list.filter((c) => c.name.toLowerCase().includes(q) || (c.lastMessage && c.lastMessage.text && c.lastMessage.text.toLowerCase().includes(q)))
  return list
}

let chatRenderFrame = 0
let messageRenderFrame = 0

function scheduleChatRender() {
  if (chatRenderFrame) return
  chatRenderFrame = requestAnimationFrame(() => {
    chatRenderFrame = 0
    renderChatList()
  })
}

function scheduleMessageRender() {
  if (messageRenderFrame) return
  messageRenderFrame = requestAnimationFrame(() => {
    messageRenderFrame = 0
    renderMessages()
  })
}

function renderChatList() {
  const nav = $('chat-list')
  nav.innerHTML = ''
  const list = filteredChats()
  if (!list.length) {
    nav.appendChild(ui.el('div', { class: 'hint', style: 'text-align:center;padding:24px 0', text: Store.search ? 'No chats match' : 'No chats yet — start a new chat' }))
    return
  }
  for (const c of list) {
    const node = ui.chatItem(c, (jid) => openChat(jid))
    node.addEventListener('contextmenu', (e) => { e.preventDefault(); ui.ctxMenu(e.clientX, e.clientY, [
      {label: c.pinned ? 'Unpin chat' : 'Pin chat', action: () => window.liquid.pinChat(c.id, !c.pinned)},
      {label: c.muted ? 'Unmute chat' : 'Mute chat', action: () => window.liquid.muteChat(c.id, !c.muted)},
      {label: c.archived ? 'Unarchive chat' : 'Archive chat', action: () => window.liquid.archiveChat(c.id, !c.archived)}
    ]) })
    nav.appendChild(node)
  }
}

function openChat(jid) {
  clearQuote()
  stopChatPing()
  Store.activeJid = jid
  window.liquid.setActive(jid)
  $('empty-state').classList.add('hidden')
  $('chat-panel').classList.remove('hidden')
  const chat = Store.chats.find((c) => c.id === jid)
  const name = chat ? chat.name : jid.split('@')[0]
  $('chat-name').textContent = name
  $('chat-avatar').className = 'avatar ' + ui.avatarClass(name)
  $('chat-avatar').textContent = ui.initials(name)
  $('btn-mention-all').classList.toggle('hidden', !jid.endsWith('@g.us'))
  renderPresence()
  updateChatPing()
  renderFriendSignal()
  renderMessages()
  startChatPing()
  window.liquid.loadChat(jid).then((msgs) => {
    Store.messages.set(jid, msgs)
    scheduleMessageRender()
    scheduleChatRender()
  }).catch(() => {})
}

function friendSignalLevel(jid) {
  if (!isPrivateChat(jid)) return 0
  const state = Store.presence.get(jid)
  if (!['online', 'typing', 'recording'].includes(state)) return 0
  const seen = friendPresenceSeenAt.get(jid) || 0
  const age = seen ? Date.now() - seen : Infinity
  if (age <= 10000) return 4
  if (age <= 20000) return 3
  if (age <= 40000) return 2
  return 1
}

function renderFriendSignal() {
  const jid = Store.activeJid
  const el = $('chat-friend-signal')
  if (!el || !isPrivateChat(jid)) {
    if (el) {
      el.classList.add('hidden')
      el.innerHTML = ''
    }
    return
  }

  const state = Store.presence.get(jid)
  const level = friendSignalLevel(jid)
  el.innerHTML = ''
  for (let i = 1; i <= 4; i++) {
    const bar = document.createElement('span')
    bar.className = 'ping-bar' + (i <= level ? ' active' : '')
    el.appendChild(bar)
  }

  const text = document.createElement('span')
  text.className = 'ping-ms'
  text.textContent = level ? ' Friend' : ' Friend —'
  el.appendChild(text)

  if (level) {
    const age = Math.max(0, Date.now() - (friendPresenceSeenAt.get(jid) || Date.now()))
    el.title = 'Friend connection signal: ' + (age <= 10000 ? 'fresh' : age <= 20000 ? 'recent' : age <= 40000 ? 'stale' : 'very stale')
  } else {
    el.title = state === 'offline'
      ? 'Friend appears offline or their presence is unavailable'
      : 'Friend connection signal unavailable'
  }
  el.setAttribute('aria-label', el.title)
  el.classList.remove('hidden')
}

function stopChatPing() {
  if (pingTimer) clearInterval(pingTimer)
  pingTimer = null
  pingRequestInFlight = false
  const el = $('chat-ping')
  if (el) {
    el.classList.add('hidden')
    el.innerHTML = ''
  }
}

function isPrivateChat(jid) {
  return !!jid && !jid.endsWith('@g.us') && jid !== 'status@broadcast'
}

function pingSignalLevel(ms) {
  if (!Number.isFinite(ms)) return 0
  if (ms <= 80) return 4
  if (ms <= 150) return 3
  if (ms <= 250) return 2
  return 1
}

async function updateChatPing() {
  const jid = Store.activeJid
  const el = $('chat-ping')
  if (!el || !isPrivateChat(jid)) {
    if (el) {
      el.classList.add('hidden')
      el.innerHTML = ''
    }
    return
  }
  if (pingRequestInFlight) return
  pingRequestInFlight = true
  try {
    const result = await window.liquid.networkPing()
    if (Store.activeJid !== jid || !isPrivateChat(jid)) return
    const ms = Number(result && result.ms)
    const level = pingSignalLevel(ms)
    el.innerHTML = ''
    for (let i = 1; i <= 4; i++) {
      const bar = document.createElement('span')
      bar.className = 'ping-bar' + (i <= level ? ' active' : '')
      el.appendChild(bar)
    }
    const label = Number.isFinite(ms) ? ' ' + Math.round(ms) + ' ms' : ' —'
    el.title = Number.isFinite(ms) ? 'Network ping: ' + Math.round(ms) + ' ms' : 'Network ping unavailable'
    el.setAttribute('aria-label', el.title)
    const text = document.createElement('span')
    text.className = 'ping-ms'
    text.textContent = label
    el.appendChild(text)
    el.classList.remove('hidden')
  } catch (_) {
    if (Store.activeJid === jid && isPrivateChat(jid)) {
      el.innerHTML = ''
      for (let i = 1; i <= 4; i++) {
        const bar = document.createElement('span')
        bar.className = 'ping-bar'
        el.appendChild(bar)
      }
      el.title = 'Network ping unavailable'
      el.setAttribute('aria-label', el.title)
      const text = document.createElement('span')
      text.className = 'ping-ms'
      text.textContent = ' —'
      el.appendChild(text)
      el.classList.remove('hidden')
    }
  } finally {
    pingRequestInFlight = false
  }
}

function startChatPing() {
  stopChatPing()
  if (!isPrivateChat(Store.activeJid)) return
  updateChatPing()
  renderFriendSignal()
  pingTimer = setInterval(() => {
    updateChatPing()
    renderFriendSignal()
  }, 5000)
}

function renderPresence() {
  const st = Store.presence.get(Store.activeJid)
  const el = $('chat-presence')
  el.textContent = st === 'typing' ? 'typing…' : st === 'recording' ? 'recording…' : st === 'online' ? 'online' : 'offline'
  el.className = 'presence' + (st && st !== 'offline' ? ' online' : '')
}

function renderMessages() {
  const wrap = $('messages')
  wrap.innerHTML = ''
  const msgs = Store.messagesOf(Store.activeJid)
  let lastDay = null
  for (const m of msgs) {
    const d = ui.day(m.timestamp)
    if (d !== lastDay) { wrap.appendChild(ui.dayDivider(d)); lastDay = d }
    wrap.appendChild(ui.bubble(m, onMsgCtx, openViewer))
  }
  const sw = $('messages-wrap')
  sw.scrollTop = sw.scrollHeight
}

function setQuote(m) {
  quotedMessage = m
  $('quote-preview').classList.remove('hidden')
  $('quote-preview-text').textContent = (m.text || m.caption || m.kind || 'Message').slice(0, 180)
  $('composer-input').focus()
}

function clearQuote() {
  quotedMessage = null
  const q = $('quote-preview')
  if (q) q.classList.add('hidden')
}

function onMsgCtx(e, m) {
  const items = [
    { label: 'Reply', action: () => setQuote(m) }
  ]
  if (m.kind === 'text') {
    items.push({ label: 'Copy text', action: () => window.liquid.copyText(m.text) })
  }
  if (m.kind !== 'system' && m.raw) {
    items.push({ label: 'React ❤️', action: () => window.liquid.react(m.jid, m, '❤️') })
    items.push({ label: 'React 👍', action: () => window.liquid.react(m.jid, m, '👍') })
    items.push({ label: 'Star / unstar', action: async () => {
      Store.starred = await window.liquid.star(m)
    }})
    items.push({ label: 'Forward…', action: () => ui.prompt(
      'Forward message',
      'Enter recipient number with country code',
      '',
      (v) => {
        const raw = String(v || '').replace(/\D/g, '')
        if (raw.length >= 8) window.liquid.forward(m, raw + '@s.whatsapp.net')
      }
    )})
  }
  if (m.fromMe && m.kind === 'text') {
    items.push('-')
    items.push({ label: 'Edit…', action: () => ui.prompt(
      'Edit message', 'New text', m.text,
      (t) => window.liquid.edit(m.jid, m.id, t)
    )})
    items.push({ label: 'Delete for everyone', danger: true, action: () => window.liquid.del(m.jid, m.id) })
  }
  items.push('-')
  if (m.kind === 'image') {
    items.push({ label: 'Send as sticker…', action: () => window.liquid.sticker(Store.activeJid) })
  }
  ui.ctxMenu(e.clientX, e.clientY, items)
}

function openViewer(m) {
  window.liquid.downloadMedia(m).then((res) => {
    $('viewer-img').src = res.dataUrl
    $('viewer-caption').textContent = m.caption || ''
    $('viewer').classList.remove('hidden')
  }).catch(() => {})
}

async function sendMessage() {
  const input = $('composer-input')
  const text = input.value.trim()
  if (!text || !Store.activeJid) return
  input.value = ''
  window.liquid.typing(Store.activeJid, false)
  try {
    await window.liquid.sendText(Store.activeJid, text, quotedMessage)
    clearQuote()
  } catch (e) {
    ui.toast(e.message || 'Message failed to send')
  }
}

async function doPair() {
  if (pairingInProgress) return
  const num = $('login-number').value.trim()
  const digits = num.replace(/\D/g, '')
  const st = $('login-status')
  const btn = $('login-btn')
  const box = $('pair-code')
  const value = $('pair-code-value')

  if (digits.length < 8 || digits.length > 15) {
    st.className = 'status-line err'
    st.textContent = 'Enter a valid international number, including the country code.'
    $('login-number').focus()
    return
  }

  pairingInProgress = true
  value.textContent = '—'
  box.classList.add('hidden')
  st.className = 'status-line'
  st.textContent = 'Connecting to WhatsApp…'
  btn.disabled = true

  try {
    const code = await window.liquid.pair(digits)
    if (!code) throw new Error('WhatsApp did not return a pairing code')
    value.textContent = String(code).replace(/(.{4})(?=.)/, '$1-')
    box.classList.remove('hidden')
    st.className = 'status-line ok'
    st.textContent = 'Enter this code in WhatsApp → Linked devices → Link with phone number instead. Keep Liquid WhatsApp open.'
  } catch (e) {
    pairingInProgress = false
    box.classList.add('hidden')
    st.className = 'status-line err'
    st.textContent = e.message || 'Pairing failed'
    btn.disabled = false
  }
}

function withModal(tplId, wire) {
  const tpl = $(tplId)
  const clone = document.importNode(tpl.content, true)
  ui.modal(clone)
  if (wire) wire()
}

function openNewChat() {
  withModal('tpl-newchat', () => {
    const go = () => {
      const raw = $('nc-number').value.trim()
      const broadcast = $('nc-broadcast').checked
      if (broadcast) {
        const jids = raw.split(/[,\s]+/).filter(Boolean).map((n) => n.replace(/\D/g, '') + '@s.whatsapp.net')
        ui.prompt('Broadcast message', 'Type message', '', (t) => {
          if (jids.length) window.liquid.broadcast(jids, t)
        })
      } else {
        const jid = raw.replace(/\D/g, '') + '@s.whatsapp.net'
        ui.closeModal(); openChat(jid)
      }
    }
    $('nc-go').addEventListener('click', go)
    $('nc-number').addEventListener('keydown', (e) => { if (e.key === 'Enter') go() })
    const list = $('nc-contacts')
    window.liquid.contacts().then((cs) => {
      Store.setContacts(cs)
      for (const c of cs.slice(0, 200)) {
        const it = ui.el('div', { class: 'contact-item' })
        it.appendChild(ui.avatarEl(c.name))
        const mid = ui.el('div')
        mid.appendChild(ui.el('div', { class: 'c-name', text: c.name }))
        mid.appendChild(ui.el('div', { class: 'c-num', text: c.number }))
        it.appendChild(mid)
        it.addEventListener('click', () => { ui.closeModal(); openChat(c.id) })
        list.appendChild(it)
      }
    })
  })
}

function openPollModal() {
  withModal('tpl-poll', () => {
    $('poll-go').addEventListener('click', async () => {
      const name = $('poll-name').value.trim()
      const options = $('poll-options').value.split('\n').map((s) => s.trim()).filter(Boolean)
      const selectableCount = Number($('poll-count').value) || 1
      if (name && options.length >= 2) { await window.liquid.poll(Store.activeJid, name, options, { selectableCount }); ui.closeModal() }
    })
  })
}

function formatCallTime(ts) {
  try { return new Date(Number(ts)).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) } catch (_) { return '' }
}

async function openCallsModal() {
  withModal('tpl-calls', async () => {
    const render = (history) => {
      const out = $('call-history-list'); out.innerHTML = ''
      const list = history || []
      if (!list.length) { out.innerHTML = '<div class="hint">No calls recorded yet.</div>'; return }
      for (const c of list) {
        const row = document.createElement('div'); row.className = 'contact-row'
        const name = Store.chats.find(x => x.id === c.jid)?.name || (c.jid || '').split('@')[0] || 'Unknown'
        const direction = c.direction === 'outgoing' ? 'Outgoing' : 'Incoming'
        const type = c.type === 'video' ? 'Video' : 'Voice'
        row.innerHTML = `<div class="avatar alt-a">${type === 'Video' ? 'V' : '☎'}</div><div style="flex:1;min-width:0"><strong>${ui.esc(name)}</strong><div class="hint">${direction} · ${type} · ${ui.esc(c.status || 'unknown')}<br>${ui.esc(formatCallTime(c.timestamp))}</div></div>`
        out.appendChild(row)
      }
    }
    render(await window.liquid.callHistory().catch(() => []))
    $('call-link-audio').onclick = async () => { try { const link = await window.liquid.createCallLink('audio'); window.liquid.copyText(link); ui.toast('Audio call link copied') } catch (e) { ui.toast(e.message) } }
    $('call-link-video').onclick = async () => { try { const link = await window.liquid.createCallLink('video'); window.liquid.copyText(link); ui.toast('Video call link copied') } catch (e) { ui.toast(e.message) } }
    $('clear-call-history').onclick = async () => { await window.liquid.clearCallHistory(); render([]); ui.toast('Call history cleared') }
  })
}

function openViewOnceModal() {
  withModal('tpl-viewonce', () => {
    $('vo-go').addEventListener('click', async () => {
      const t = $('vo-text').value.trim()
      if (t) { await window.liquid.viewOnce(Store.activeJid, t); ui.closeModal() }
    })
  })
}

function openDisappearModal() {
  withModal('tpl-disappear', () => {
    $('disp-go').addEventListener('click', async () => {
      await window.liquid.disappear(Store.activeJid, Number($('disp-select').value))
      ui.closeModal()
    })
  })
}

async function openMessageSearchModal() {
  withModal('tpl-search', () => {
    const input = $('msg-search-input'), out = $('msg-search-results')
    const run = async () => {
      const q = input.value.trim(); out.innerHTML = ''
      if (!q) return
      const results = await window.liquid.searchMessages(q, Store.activeJid)
      if (!results.length) { out.appendChild(ui.el('div',{class:'hint',text:'No messages found'})); return }
      for (const m of results) {
        const b = ui.el('button',{class:'search-result',type:'button'})
        b.appendChild(ui.el('div',{text:(m.text||m.caption||m.kind||'Message').slice(0,220)}))
        b.appendChild(ui.el('small',{text:`${m.fromMe?'You':m.name} · ${new Date(m.timestamp).toLocaleString()}`}))
        b.addEventListener('click',()=>{ ui.closeModal(); openChat(m.jid); setTimeout(()=>{ const el=[...document.querySelectorAll('.msg')].find(x=>x.textContent.includes((m.text||'').slice(0,30))); el?.scrollIntoView({behavior:'smooth',block:'center'}) },150) })
        out.appendChild(b)
      }
    }
    input.addEventListener('input', run); input.focus()
  })
}

async function openGalleryModal() {
  withModal('tpl-gallery', () => {
    const out=$('gallery-grid'); out.innerHTML=''
    const media=Store.messagesOf(Store.activeJid).filter(m=>['image','sticker'].includes(m.kind))
    if(!media.length){out.appendChild(ui.el('div',{class:'hint',text:'No images or stickers in this chat.'}));return}
    media.slice(-100).forEach(m=>{ const img=ui.el('img',{alt:''}); out.appendChild(img); window.liquid.downloadMedia(m).then(r=>img.src=r.dataUrl).catch(()=>{}); img.addEventListener('click',()=>{ui.closeModal();openViewer(m)}) })
  })
}

async function openProfileModal() {
  const chat=Store.chats.find(c=>c.id===Store.activeJid); if(!chat) return
  withModal('tpl-profile',()=>{
    const out=$('profile-content'); out.appendChild(ui.avatarEl(chat.name,'large')); out.appendChild(ui.el('h2',{text:chat.name})); out.appendChild(ui.el('div',{class:'hint',text:Store.activeJid}))
    const row=ui.el('div',{class:'row',style:'margin-top:14px;gap:8px'})
    row.appendChild(ui.el('button',{class:'btn ghost',text:chat.pinned?'Unpin':'Pin',onclick:async()=>{await window.liquid.pinChat(chat.id,!chat.pinned);ui.closeModal()}}))
    row.appendChild(ui.el('button',{class:'btn ghost',text:chat.muted?'Unmute':'Mute',onclick:async()=>{await window.liquid.muteChat(chat.id,!chat.muted);ui.closeModal()}}))
    row.appendChild(ui.el('button',{class:'btn ghost',text:chat.archived?'Unarchive':'Archive',onclick:async()=>{await window.liquid.archiveChat(chat.id,!chat.archived);ui.closeModal()}})); out.appendChild(row)
    if(chat.id.endsWith('@g.us')) { const g=ui.el('button',{class:'btn primary',style:'width:100%;margin-top:10px',text:'Manage group',onclick:()=>{ui.closeModal();openGroupModal()}});out.appendChild(g) }
  })
}

async function openGroupModal() {
  if(!Store.activeJid?.endsWith('@g.us')) return
  withModal('tpl-group', async()=>{
    $('group-subject').value=Store.chats.find(c=>c.id===Store.activeJid)?.name||''
    const members=await window.liquid.groupParticipants(Store.activeJid).catch(()=>[]), out=$('group-members')
    out.innerHTML=''
    members.forEach(m=>{ const jid=m.id||m.jid||m; const label=typeof m==='string'?m:(m.name||m.notify||jid); const b=ui.el('button',{class:'contact-item',type:'button',text:label}); b.dataset.jid=jid; b.addEventListener('click',()=>b.classList.toggle('selected')); out.appendChild(b) })
    $('group-subject-save').onclick=async()=>{await window.liquid.groupSubject(Store.activeJid,$('group-subject').value);ui.closeModal()}
    const selected=()=>[...out.querySelectorAll('.selected')].map(x=>x.dataset.jid)
    $('group-add').onclick=async()=>{ui.toast('Use New chat/contact selection to choose members; group add requires a selected WhatsApp contact JID.');}
    $('group-remove').onclick=async()=>{await window.liquid.groupAction(Store.activeJid,'remove',selected());ui.closeModal()}
    $('group-promote').onclick=async()=>{await window.liquid.groupAction(Store.activeJid,'promote',selected());ui.closeModal()}
    $('group-leave').onclick=async()=>{await window.liquid.groupLeave(Store.activeJid);ui.closeModal()}
  })
}

async function openMessageSearchModal() {
  withModal('tpl-search', () => {
    const input = $('msg-search-input'), out = $('msg-search-results')
    const run = async () => {
      const q = input.value.trim(); out.innerHTML = ''
      if (!q) return
      const results = await window.liquid.searchMessages(q, Store.activeJid)
      if (!results.length) { out.appendChild(ui.el('div',{class:'hint',text:'No messages found'})); return }
      for (const m of results) {
        const b = ui.el('button',{class:'search-result',type:'button'})
        b.appendChild(ui.el('div',{text:(m.text||m.caption||m.kind||'Message').slice(0,220)}))
        b.appendChild(ui.el('small',{text:`${m.fromMe?'You':m.name} · ${new Date(m.timestamp).toLocaleString()}`}))
        b.addEventListener('click',()=>{ ui.closeModal(); openChat(m.jid) })
        out.appendChild(b)
      }
    }
    input.addEventListener('input', run); input.focus()
  })
}

async function openGalleryModal() {
  withModal('tpl-gallery', () => {
    const out=$('gallery-grid'); out.innerHTML=''
    const media=Store.messagesOf(Store.activeJid).filter(m=>['image','sticker'].includes(m.kind))
    if(!media.length){out.appendChild(ui.el('div',{class:'hint',text:'No images or stickers in this chat.'}));return}
    media.slice(-100).forEach(m=>{ const img=ui.el('img',{alt:''}); out.appendChild(img); window.liquid.downloadMedia(m).then(r=>img.src=r.dataUrl).catch(()=>{}); img.addEventListener('click',()=>{ui.closeModal();openViewer(m)}) })
  })
}

async function openProfileModal() {
  const chat=Store.chats.find(c=>c.id===Store.activeJid); if(!chat) return
  withModal('tpl-profile',()=>{
    const out=$('profile-content'); out.appendChild(ui.avatarEl(chat.name)); out.appendChild(ui.el('h2',{text:chat.name})); out.appendChild(ui.el('div',{class:'hint',text:Store.activeJid}))
    const row=ui.el('div',{class:'row',style:'margin-top:14px;gap:8px'})
    row.appendChild(ui.el('button',{class:'btn ghost',text:chat.pinned?'Unpin':'Pin',onclick:async()=>{await window.liquid.pinChat(chat.id,!chat.pinned);ui.closeModal()}}))
    row.appendChild(ui.el('button',{class:'btn ghost',text:chat.muted?'Unmute':'Mute',onclick:async()=>{await window.liquid.muteChat(chat.id,!chat.muted);ui.closeModal()}}))
    row.appendChild(ui.el('button',{class:'btn ghost',text:chat.archived?'Unarchive':'Archive',onclick:async()=>{await window.liquid.archiveChat(chat.id,!chat.archived);ui.closeModal()}})); out.appendChild(row)
    if(chat.id.endsWith('@g.us')) out.appendChild(ui.el('button',{class:'btn primary',style:'width:100%;margin-top:10px',text:'Manage group',onclick:()=>{ui.closeModal();openGroupModal()}}))
  })
}

async function openGroupModal() {
  if(!Store.activeJid?.endsWith('@g.us')) return
  withModal('tpl-group', async()=>{
    $('group-subject').value=Store.chats.find(c=>c.id===Store.activeJid)?.name||''
    const members=await window.liquid.groupParticipants(Store.activeJid).catch(()=>[]), out=$('group-members'); out.innerHTML=''
    members.forEach(m=>{ const jid=m.id||m.jid||m; const label=typeof m==='string'?m:(m.name||m.notify||jid); const b=ui.el('button',{class:'contact-item',type:'button',text:label}); b.dataset.jid=jid; b.addEventListener('click',()=>b.classList.toggle('selected')); out.appendChild(b) })
    $('group-subject-save').onclick=async()=>{await window.liquid.groupSubject(Store.activeJid,$('group-subject').value);ui.closeModal()}
    const selected=()=>[...out.querySelectorAll('.selected')].map(x=>x.dataset.jid)
    $('group-add').onclick=()=>ui.prompt('Add participant','Phone number with country code','',(v)=>window.liquid.groupAction(Store.activeJid,'add',[v.replace(/\D/g,'')+'@s.whatsapp.net']))
    $('group-remove').onclick=async()=>{await window.liquid.groupAction(Store.activeJid,'remove',selected());ui.closeModal()}
    $('group-promote').onclick=async()=>{await window.liquid.groupAction(Store.activeJid,'promote',selected());ui.closeModal()}
    $('group-leave').onclick=async()=>{await window.liquid.groupLeave(Store.activeJid);ui.closeModal()}
  })
}

function openStatusModal() {
  withModal('tpl-status', () => {
    $('st-go').addEventListener('click', async () => {
      const t = $('st-text').value.trim()
      if (t) { await window.liquid.postStatus(t); ui.closeModal() }
    })
    $('st-img').addEventListener('click', async () => { await window.liquid.postStatusImage(''); ui.closeModal() })
  })
}

async function openStarredModal() {
  const list = await window.liquid.starred()
  const tpl = $('tpl-starred')
  const clone = document.importNode(tpl.content, true)
  ui.modal(clone)
  const out = $('starred-list')
  out.innerHTML = ''
  if (!list.length) {
    out.appendChild(ui.el('div', { class: 'hint', text: 'No starred messages yet.' }))
    return
  }
  for (const s of list) {
    const it = ui.el('button', { class: 'star-item', type: 'button' })
    it.appendChild(ui.el('div', { text: s.text || s.kind || 'Message' }))
    it.appendChild(ui.el('div', { class: 's-meta', text: `${s.name || s.jid} · ${ui.day(s.ts)}` }))
    it.addEventListener('click', () => {
      ui.closeModal()
      openChat(s.jid)
    })
    out.appendChild(it)
  }
}

function openSettingsModal() {
  withModal('tpl-settings', () => {
    const s = Store.settings || {}
    const user = Store.user || {}
    const $id = (id) => document.getElementById(id)

    const formatSessionDate = (value) => {
      if (!value) return 'Not recorded'
      const d = new Date(value)
      if (Number.isNaN(d.getTime())) return 'Unknown'
      return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    }
    const formatRelative = (value) => {
      if (!value) return 'Not recorded'
      const ms = Date.now() - new Date(value).getTime()
      if (!Number.isFinite(ms) || ms < 0) return 'Just now'
      const mins = Math.floor(ms / 60000)
      if (mins < 1) return 'Just now'
      if (mins < 60) return `${mins} min ago`
      const hours = Math.floor(mins / 60)
      if (hours < 24) return `${hours} hr ago`
      return `${Math.floor(hours / 24)} day(s) ago`
    }
    const refreshLinkedSession = async () => {
      try {
        const info = await window.liquid.sessionInfo()
        const open = info?.connection === 'open'
        const saved = !!info?.savedLocally
        $id('session-status-line').textContent = open ? 'Connected and ready to reconnect' : saved ? 'Session saved locally; currently offline' : 'No linked session saved'
        const badge = $id('session-status-badge')
        badge.textContent = open ? 'Connected' : saved ? 'Saved' : 'Not linked'
        badge.className = 'session-badge ' + (open ? 'session-online' : saved ? 'session-saved' : 'session-offline')
        $id('session-phone').textContent = info?.phone ? '+' + String(info.phone).replace(/^\+/, '') : '—'
        $id('session-linked-at').textContent = formatSessionDate(info?.linkedAt)
        $id('session-last-active').textContent = info?.lastActiveAt ? formatRelative(info.lastActiveAt) : 'Not recorded'
        $id('session-storage').textContent = saved ? 'Saved locally' : 'Not present'
      } catch (e) {
        $id('session-status-line').textContent = 'Could not read session status'
      }
    }

    const sections = [...document.querySelectorAll('.settings-section')]
    const tabs = [...document.querySelectorAll('.settings-tab')]
    const selectSection = (name) => {
      tabs.forEach(t => t.classList.toggle('active', t.dataset.section === name))
      sections.forEach(panel => panel.classList.toggle('active', panel.dataset.sectionPanel === name))
    }
    tabs.forEach(tab => tab.addEventListener('click', () => selectSection(tab.dataset.section)))

    refreshLinkedSession()
    const diagGrid = $id('diagnostics-grid')
    const diagReport = $id('diagnostics-report')
    let lastDiagnosticReport = ''

    const fmtBytes = (n) => {
      n = Number(n) || 0
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
      if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
      return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
    }
    const diagStatus = (ok) => ok ? '<span class="diag-ok">✓</span>' : '<span class="diag-warn">!</span>'
    const runDiagnostics = async () => {
      diagReport.textContent = 'Running diagnostic…'
      try {
        const d = await window.liquid.diagnostics()
        const osVersion = String(d.system.os || '')
        const osOk = /^10\.(15|1[6-9])(?:\.|$)/.test(osVersion) || Number(osVersion.split('.')[0]) > 10
        const archOk = d.app.arch === 'x64'
        const micOk = ['granted', 'not-determined'].includes(d.permissions.microphone)
        const camOk = ['granted', 'not-determined'].includes(d.permissions.camera)
        const storageOk = !d.system.storage || d.system.storage.free > 1024 * 1024 * 1024
        const items = [
          ['Liquid WhatsApp', d.app.version, true],
          ['macOS', osVersion, osOk],
          ['Architecture', d.app.arch, archOk],
          ['CPU', d.system.cpu, true],
          ['CPU cores', String(d.system.cores), d.system.cores >= 2],
          ['Memory', fmtBytes(d.system.memory.total), d.system.memory.total >= 4 * 1024 * 1024 * 1024],
          ['Free memory', fmtBytes(d.system.memory.free), d.system.memory.free >= 512 * 1024 * 1024],
          ['Storage free', d.system.storage ? fmtBytes(d.system.storage.free) : 'Unavailable', storageOk],
          ['Microphone', d.permissions.microphone, micOk],
          ['Camera', d.permissions.camera, camOk],
          ['GPU', d.gpu?.featureStatus ? 'Detected' : 'Unavailable', !!d.gpu],
          ['WhatsApp session', d.connection.hasSession ? (d.connection.connected ? 'Connected' : 'Saved, disconnected') : 'Not linked', true],
          ['Performance mode', d.performance.mode, true]
        ]
        diagGrid.innerHTML = items.map(([label,value,ok]) => '<div class="diagnostic-item"><span>'+ui.esc(label)+'</span><strong>'+diagStatus(ok)+' '+ui.esc(String(value))+'</strong></div>').join('')

        lastDiagnosticReport = [
          'LIQUID WHATSAPP DIAGNOSTIC',
          'Generated: ' + new Date().toISOString(),
          '',
          'APP',
          'Version: ' + d.app.version,
          'Electron: ' + d.app.electron,
          'Chrome: ' + d.app.chrome,
          'Node: ' + d.app.node,
          'Packaged: ' + d.app.packaged,
          'Architecture: ' + d.app.arch,
          '',
          'SYSTEM',
          'macOS: ' + d.system.os,
          'CPU: ' + d.system.cpu,
          'Cores: ' + d.system.cores,
          'Memory: ' + fmtBytes(d.system.memory.total) + ' total / ' + fmtBytes(d.system.memory.free) + ' free',
          'Storage: ' + (d.system.storage ? fmtBytes(d.system.storage.free) + ' free / ' + fmtBytes(d.system.storage.total) + ' total' : 'unavailable'),
          '',
          'PERMISSIONS',
          'Microphone: ' + d.permissions.microphone,
          'Camera: ' + d.permissions.camera,
          '',
          'PERFORMANCE',
          'App CPU: ' + Number(d.process.cpuPercent || 0).toFixed(1) + '%',
          'App private memory: ' + fmtBytes((Number(d.process.privateMemory) || 0) * 1024),
          'App processes: ' + d.process.processCount,
          'Mode: ' + d.performance.mode,
          '',
          'CONNECTION',
          'Session: ' + (d.connection.hasSession ? 'saved' : 'not linked'),
          'Connected: ' + d.connection.connected,
          '',
          'GPU',
          JSON.stringify(d.gpu?.featureStatus || {}, null, 2)
        ].join('\n')
        diagReport.textContent = lastDiagnosticReport
      } catch (e) {
        diagReport.textContent = 'Diagnostic failed: ' + (e.message || e)
      }
    }

    $id('diagnostics-run').addEventListener('click', runDiagnostics)
    $id('diagnostics-copy').addEventListener('click', async () => {
      if (!lastDiagnosticReport) await runDiagnostics()
      if (lastDiagnosticReport) {
        await window.liquid.copyText(lastDiagnosticReport)
        ui.toast('Diagnostic report copied')
      }
    })

    $id('settings-name').textContent = user.name || 'Me'
    $id('settings-number').textContent = user.number ? '+' + user.number : 'Connected account'
    $id('settings-avatar').textContent = (user.name || 'M').trim().charAt(0).toUpperCase()

    $id('set-notif').checked = s.notifications !== false
    $id('set-typing').checked = s.typingIndicator !== false
    $id('set-sound').checked = s.soundNotifications !== false
    $id('set-preview').checked = s.showPreviews !== false
    $id('set-theme').value = s.theme || 'system'
    $id('set-glass').value = s.glassStyle || 'tinted'
    $id('set-reduce-motion').checked = !!s.reduceMotion
    $id('set-performance').value = s.performanceMode || 'auto'
    $id('set-backup').checked = s.backupEnabled !== false
    applyTheme(s.theme || 'system')

    const ai = s.ai || {}
    $id('ai-provider').value = ai.provider || 'openai'
    $id('ai-model').value = ai.model || ''
    $id('ai-key').value = ''
    $id('ai-key').placeholder = ai.keyStored ? 'API key saved securely — enter a new key to replace it' : 'API key (stored securely)'

    const privacyMap = {
      'pr-lastseen': 'lastseen', 'pr-online': 'online', 'pr-read': 'read',
      'pr-pic': 'pic', 'pr-status': 'status', 'pr-groups': 'groups'
    }
    for (const [id, key] of Object.entries(privacyMap)) {
      const el = $id(id)
      if (!el) continue
      el.value = (s.privacy && s.privacy[key]) || 'all'
      el.addEventListener('change', async () => {
        try { await window.liquid.setPrivacy(key, el.value); ui.toast(`${key} privacy updated`) } catch (e) { ui.toast(e.message || 'Could not update privacy') }
      })
    }

    $id('set-theme').addEventListener('change', () => {
      applyTheme($id('set-theme').value)
    })

    window.liquid.localInfo().then((info) => {
      $id('local-db-info').textContent = `${info.messages.toLocaleString()} messages · ${info.chats.toLocaleString()} chats · schema ${info.schema}`
    }).catch(() => {})

    $id('backup-export').addEventListener('click', async () => {
      const r = await window.liquid.exportLocal()
      if (r?.ok) ui.toast('Backup exported successfully')
    })

    const refreshStorage = async () => {
      const info = await window.liquid.localInfo()
      const fmt = (n) => { n = Number(n) || 0; if (n < 1024) return `${n} B`; if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`; if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`; return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB` }
      $id('local-db-info').innerHTML = `<strong>Local data</strong><br>${info.messages.toLocaleString()} messages · ${info.chats.toLocaleString()} chats · ${info.callHistory.toLocaleString()} calls<br><span class="hint">Total: ${fmt(info.bytes?.total)} · Messages: ${fmt(info.bytes?.messagesDb)} · Backups: ${fmt(info.bytes?.backups)} · Voice notes: ${fmt(info.bytes?.voiceNotes)}</span>`
    }
    refreshStorage()
    $id('storage-refresh').onclick = refreshStorage
    $id('storage-clear-backups').onclick = async () => { if (!confirm('Delete only local backup files? Your WhatsApp session and messages will remain.')) return; await window.liquid.clearBackups(); await refreshStorage(); ui.toast('Backups cleared') }

    $id('settings-save').addEventListener('click', async () => {
      await window.liquid.setSettings({
        notifications: $id('set-notif').checked,
        typingIndicator: $id('set-typing').checked,
        soundNotifications: $id('set-sound').checked,
        showPreviews: $id('set-preview').checked,
        theme: $id('set-theme').value,
        glassStyle: $id('set-glass').value,
        reduceMotion: $id('set-reduce-motion').checked,
        performanceMode: $id('set-performance').value,
        backupEnabled: $id('set-backup').checked,
        ai: { provider: $id('ai-provider').value, model: $id('ai-model').value.trim() }
      })
      const newAiKey = $id('ai-key').value.trim()
      if (newAiKey) await window.liquid.setAiKey(newAiKey)
      applyTheme($id('set-theme').value)
      window.liquidGlass?.apply($id('set-glass').value)
      applyPerformanceProfile()
      ui.toast('Settings saved')
    })

    $id('ai-save').addEventListener('click', async () => {
      await window.liquid.setSettings({
        ai: { provider: $id('ai-provider').value, model: $id('ai-model').value.trim() }
      })
      const newAiKey = $id('ai-key').value.trim()
      if (newAiKey) await window.liquid.setAiKey(newAiKey)
      $id('ai-key').value = ''
      ui.toast('AI settings saved securely')
    })

    $id('settings-logout').addEventListener('click', async () => {
      if (!confirm('Log out of this WhatsApp session on this Mac?')) return
      await window.liquid.logout()
      ui.closeModal()
    })
  })
}

function openAiModal() {
  withModal('tpl-ai', () => {
    const out = $('ai-out')
    const setBusy = (b) => { out.className = 'ai-out'; out.innerHTML = b ? '<span class="spinner">Thinking…</span>' : '' }
    const show = (html, sendText) => {
      out.className = 'ai-out'; out.innerHTML = html
      if (sendText) {
        const row = ui.el('div', { class: 'ai-actions' })
        const btn = ui.el('button', { class: 'btn primary', text: 'Send to chat' })
        btn.addEventListener('click', async () => { await window.liquid.sendText(Store.activeJid, sendText); ui.closeModal() })
        row.appendChild(btn)
        out.appendChild(row)
      }
    }
    const showErr = (e) => { out.className = 'ai-out err'; out.textContent = String(e.message || e) }

    $('ai-ask').addEventListener('click', async () => {
      const p = $('ai-prompt').value.trim()
      if (!p) return
      setBusy(true)
      try { const r = await aiCall([{ role: 'user', content: p }]); show(ui.esc(r.text), r.text) } catch (e) { showErr(e) }
    })
    $('ai-summarize').addEventListener('click', async () => {
      setBusy(true)
      const msgs = Store.messagesOf(Store.activeJid).slice(-50)
      const transcript = msgs.filter((m) => m.kind === 'text').map((m) => (m.fromMe ? 'Me' : 'Them') + ': ' + m.text).join('\n')
      try {
        const r = await aiCall([{ role: 'user', content: 'Summarize this WhatsApp conversation concisely:\n\n' + transcript }])
        show(ui.esc(r.text), r.text)
      } catch (e) { showErr(e) }
    })
    $('ai-image').addEventListener('click', async () => {
      const p = $('ai-prompt').value.trim()
      if (!p) return
      setBusy(true)
      try {
        const url = await aiImage(p)
        show('<img src="' + url + '">', p)
      } catch (e) { showErr(e) }
    })
  })
}

// Completed core asynchronous fetch controller endpoints parsing pipelines 
async function aiCall(messages) {
  return window.liquid.aiCall(messages)
}

async function aiImage(prompt) {
  return window.liquid.aiImage(prompt)
}

window.onload = init
