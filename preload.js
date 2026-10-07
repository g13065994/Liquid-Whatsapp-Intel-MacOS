const { contextBridge, ipcRenderer, clipboard } = require('electron')

const INVOKE_CHANNELS = new Set([
  'app:init', 'core:pair', 'core:logout', 'chat:set-active',
  'chat:send-text', 'chat:send-image', 'chat:send-media', 'chat:send-dropped-media',
  'chat:send-voice-note', 'chat:typing', 'network:ping', 'chat:load', 'chat:search',
  'chat:meta', 'chat:archive', 'chat:pin', 'chat:mute', 'chat:read', 'chat:edit',
  'chat:delete', 'chat:react', 'chat:forward', 'chat:poll', 'chat:viewonce',
  'chat:broadcast', 'chat:mention-all', 'chat:disappear', 'chat:sticker',
  'chat:star', 'chat:starred', 'media:download', 'contacts:list', 'group:participants',
  'group:action', 'group:subject', 'group:leave', 'status:post', 'status:post-image',
  'privacy:set', 'settings:get', 'settings:set', 'ai:set-key', 'ai:call', 'ai:image',
  'local:info', 'diagnostics:get', 'integrity:get', 'session:info',
  'local:clear-backups', 'calls:history', 'calls:clear-history', 'calls:create-link',
  'local:export', 'autoreply:add', 'autoreply:remove', 'schedule:list', 'schedule:add',
  'schedule:remove', 'call:action', 'whatsapp-web:call', 'external:open',
  'update:check', 'update:download', 'update:install'
])

const EVENT_CHANNELS = new Set([
  'connection', 'chats', 'messages', 'presence', 'settings', 'schedules', 'calls',
  'call:ring', 'call:state', 'call:error', 'call:audio', 'call:video', 'outbox',
  'open-chat', 'update:checking', 'update:available', 'update:not-available',
  'update:progress', 'update:downloaded', 'update:cancelled', 'update:error'
])

const invoke = (channel, ...args) => {
  if (!INVOKE_CHANNELS.has(channel)) throw new Error('Unsupported IPC channel')
  return ipcRenderer.invoke(channel, ...args)
}

function on(channel, cb) {
  if (!EVENT_CHANNELS.has(channel) && !EVENT_CHANNELS.has(channel.replace(/^ev:/, ''))) {
    throw new Error('Unsupported event channel')
  }
  const eventChannel = channel.startsWith('ev:') ? channel : 'ev:' + channel
  const listener = (_event, data) => cb(data)
  ipcRenderer.on(eventChannel, listener)
  return () => ipcRenderer.removeListener(eventChannel, listener)
}

contextBridge.exposeInMainWorld('liquid', {
  init: () => invoke('app:init'),
  pair: (number) => invoke('core:pair', number),
  logout: () => invoke('core:logout'),
  setActive: (jid) => invoke('chat:set-active', jid),
  sendText: (jid, text, quoted) => invoke('chat:send-text', jid, text, quoted),
  sendImage: (jid, caption, quoted) => invoke('chat:send-image', jid, caption, quoted),
  sendMedia: (jid, caption, quoted) => invoke('chat:send-media', jid, caption, quoted),
  sendDroppedMedia: (jid, filePath, caption, quoted) => invoke('chat:send-dropped-media', jid, filePath, caption, quoted),
  sendVoiceNote: (jid, dataUrl, durationMs, quoted) => invoke('chat:send-voice-note', jid, dataUrl, durationMs, quoted),
  typing: (jid, on) => invoke('chat:typing', jid, on),
  networkPing: () => invoke('network:ping'),
  loadChat: (jid) => invoke('chat:load', jid),
  searchMessages: (q, jid) => invoke('chat:search', q, jid),
  setChatMeta: (jid, patch) => invoke('chat:meta', jid, patch),
  archiveChat: (jid, value) => invoke('chat:archive', jid, value),
  pinChat: (jid, value) => invoke('chat:pin', jid, value),
  muteChat: (jid, value) => invoke('chat:mute', jid, value),
  read: (jid, ids) => invoke('chat:read', jid, ids),
  edit: (jid, id, text) => invoke('chat:edit', jid, id, text),
  del: (jid, id) => invoke('chat:delete', jid, id),
  react: (jid, msg, reaction) => invoke('chat:react', jid, msg, reaction),
  forward: (msg, targetJid) => invoke('chat:forward', msg, targetJid),
  poll: (jid, name, options, settings) => invoke('chat:poll', jid, name, options, settings),
  viewOnce: (jid, text) => invoke('chat:viewonce', jid, text),
  broadcast: (jids, text) => invoke('chat:broadcast', jids, text),
  mentionAll: (jid, text) => invoke('chat:mention-all', jid, text),
  disappear: (jid, sec) => invoke('chat:disappear', jid, sec),
  sticker: (jid) => invoke('chat:sticker', jid),
  star: (m) => invoke('chat:star', m),
  starred: () => invoke('chat:starred'),
  downloadMedia: (dto) => invoke('media:download', dto),
  contacts: () => invoke('contacts:list'),
  groupParticipants: (jid) => invoke('group:participants', jid),
  groupAction: (jid, action, participants) => invoke('group:action', jid, action, participants),
  groupSubject: (jid, subject) => invoke('group:subject', jid, subject),
  groupLeave: (jid) => invoke('group:leave', jid),
  postStatus: (text) => invoke('status:post', text),
  postStatusImage: (caption) => invoke('status:post-image', caption),
  setPrivacy: (key, value) => invoke('privacy:set', key, value),
  getSettings: () => invoke('settings:get'),
  setSettings: (patch) => invoke('settings:set', patch),
  setAiKey: (key) => invoke('ai:set-key', key),
  aiCall: (messages) => invoke('ai:call', messages),
  aiImage: (prompt) => invoke('ai:image', prompt),
  localInfo: () => invoke('local:info'),
  diagnostics: () => invoke('diagnostics:get'),
  integrity: () => invoke('integrity:get'),
  sessionInfo: () => invoke('session:info'),
  clearBackups: () => invoke('local:clear-backups'),
  callHistory: () => invoke('calls:history'),
  clearCallHistory: () => invoke('calls:clear-history'),
  createCallLink: (type) => invoke('calls:create-link', type),
  exportLocal: () => invoke('local:export'),
  addAutoReply: (rule) => invoke('autoreply:add', rule),
  removeAutoReply: (id) => invoke('autoreply:remove', id),
  getSchedules: () => invoke('schedule:list'),
  addSchedule: (s) => invoke('schedule:add', s),
  removeSchedule: (id) => invoke('schedule:remove', id),
  copyText: (t) => clipboard.writeText(String(t)),
  callAction: (action, callId, targetJid, isVideo) => invoke('call:action', action, callId, targetJid, isVideo),
  openWhatsAppWebCall: (targetJid, isVideo) => invoke('whatsapp-web:call', targetJid, !!isVideo),
  openExternal: (url) => invoke('external:open', url),
  checkForUpdates: () => invoke('update:check'),
  downloadUpdate: () => invoke('update:download'),
  installUpdate: () => invoke('update:install'),

  on,
  onOpenChat: (cb) => on('open-chat', cb),
  onCallRing: (cb) => on('ev:call:ring', cb),
  onCallState: (cb) => on('ev:call:state', cb),
  onCallError: (cb) => on('ev:call:error', cb),
  onCallAudio: (cb) => on('ev:call:audio', cb),
  onCallVideo: (cb) => on('ev:call:video', cb),
  onOutbox: (cb) => on('outbox', cb),
  onUpdateChecking: (cb) => on('ev:update:checking', cb),
  onUpdateAvailable: (cb) => on('ev:update:available', cb),
  onUpdateNotAvailable: (cb) => on('ev:update:not-available', cb),
  onUpdateProgress: (cb) => on('ev:update:progress', cb),
  onUpdateDownloaded: (cb) => on('ev:update:downloaded', cb),
  onUpdateCancelled: (cb) => on('ev:update:cancelled', cb),
  onUpdateError: (cb) => on('ev:update:error', cb)
})
