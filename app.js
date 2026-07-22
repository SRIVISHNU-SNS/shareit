(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const app = $('#app');
  const workspace = $('#workspace');
  const states = { discovery: $('#discoveryState'), drop: $('#dropState'), transfer: $('#transferState') };
  const CHUNK_SIZE = 48 * 1024;
  const HIGH_WATER_MARK = 1024 * 1024;
  const START_DELAY = 1300;
  let { room, secret } = inviteFromUrl();
  let ownerKey = room ? sessionStorage.getItem(`nearby-owner:${room}`) : null;
  let socket;
  let role = 'idle';
  let toastTimer;
  let dragDepth = 0;
  let outgoing;
  let incoming;
  let pendingOffer;
  let aesKey;

  function inviteFromUrl() {
    const url = new URL(location.href);
    const candidate = url.pathname.split('/').filter(Boolean).pop()?.toUpperCase();
    const hash = new URLSearchParams(location.hash.slice(1));
    return { room: /^[A-Z0-9]{4,8}$/.test(candidate || '') ? candidate : null, secret: hash.get('k') || null };
  }
  function randomCode() { return crypto.getRandomValues(new Uint32Array(1))[0].toString(36).slice(0, 6).toUpperCase(); }
  function randomSecret(bytes = 32) { return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes))); }
  function bytesToBase64Url(bytes) { let text = ''; bytes.forEach((value) => { text += String.fromCharCode(value); }); return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
  function base64UrlToBytes(value) { const normal = value.replaceAll('-', '+').replaceAll('_', '/'); const padded = normal + '='.repeat((4 - normal.length % 4) % 4); return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)); }
  function roomUrl() { return `${location.origin}/${room}#k=${secret}`; }
  function setState(name) { Object.values(states).forEach((state) => state.classList.remove('active')); states[name].classList.add('active'); $('#chooseFile').hidden = name !== 'discovery' || role !== 'owner' || socket?.readyState !== WebSocket.OPEN; }
  function showToast(message) { $('#toast').textContent = message; $('#toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 2400); }
  function formatBytes(bytes) { if (!bytes) return '0 B'; const units = ['B', 'KB', 'MB', 'GB', 'TB']; const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1); return `${(bytes / 1024 ** unit).toFixed(unit > 1 ? 2 : 0)} ${units[unit]}`; }
  function formatTime(seconds) { if (!Number.isFinite(seconds)) return 'calculating'; const minutes = Math.floor(seconds / 60); return `${String(minutes).padStart(2, '0')}:${String(Math.ceil(seconds % 60)).padStart(2, '0')}`; }
  function extension(name) { return name.includes('.') ? name.split('.').pop().slice(0, 4).toUpperCase() : 'FILE'; }
  function message(payload) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload)); }
  function transferUI({ name, size, progress, speed = 0, mode, detail }) {
    const remaining = speed ? Math.max(0, (size - size * progress / 100) / speed) : Infinity;
    $('#fileName').textContent = name; $('#fileType').textContent = extension(name); $('#percent').textContent = `${Math.floor(progress)}%`; $('#progressBar').style.width = `${progress}%`;
    $('#fileMeta').textContent = progress >= 100 ? `${formatBytes(size)} · complete` : `${formatBytes(size)} · ${speed ? `${formatBytes(speed)}/s · ${formatTime(remaining)} remaining` : 'waiting'}`;
    $('#transferLabel').textContent = mode === 'receive' ? 'Receiving file' : mode === 'offer' ? 'Waiting for receivers' : 'Broadcasting file'; $('#transferDetail').textContent = detail || 'End-to-end encrypted transfer';
  }
  function setRoomView(state, title, detail, count = 0) {
    const active = Boolean(room); app.dataset.room = state; app.dataset.role = role;
    $('#roomControls').hidden = !active; $('#showQr').hidden = !active; $('#createRoom').hidden = active;
    $('#roomHeading').textContent = active ? title : 'Start a private room'; $('#status').innerHTML = `<b>${detail}</b> ${role === 'owner' ? 'Only you can send files in this room.' : active ? 'You can receive files from the room owner.' : ''}`;
    $('#eyebrow').textContent = active ? `room ${room}` : 'private broadcast';
    if (active) { $('#roomCode').textContent = roomUrl().replace(/^https?:\/\//, ''); $('#qrText').textContent = roomUrl(); renderQr(); }
    $('#peerText').textContent = role === 'owner' ? `${count} receiver${count === 1 ? '' : 's'} connected` : 'Connected as receiver'; $('#peerDot').textContent = state === 'connected' ? '✓' : '·';
  }
  function renderQr() {
    if (!room || !secret || typeof window.qrcode !== 'function') return;
    const qr = window.qrcode(0, 'M'); qr.addData(roomUrl()); qr.make(); const image = new Image(170, 170); image.alt = 'Encrypted room invite QR code'; image.src = qr.createDataURL(4, 0); $('#qr').replaceChildren(image);
  }
  async function getAesKey() {
    if (!secret) throw new Error('This invite link is missing its encryption key.');
    if (!aesKey) aesKey = crypto.subtle.importKey('raw', base64UrlToBytes(secret), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    return aesKey;
  }
  function iv(prefix, index) { const value = new Uint8Array(12); value.set(base64UrlToBytes(prefix), 0); new DataView(value.buffer).setUint32(8, index); return value; }
  function createRoom() {
    room = randomCode(); secret = randomSecret(); ownerKey = randomSecret(); aesKey = undefined; sessionStorage.setItem(`nearby-owner:${room}`, ownerKey); history.pushState({}, '', `/${room}#k=${secret}`); setRoomView('live', 'Private room created', 'Share the invite with up to 250 receivers.', 0); connect();
  }
  function connect() {
    if (location.protocol === 'file:') { setRoomView('live', 'Preview mode', 'Run the server to enable a live room.', 0); return; }
    if (!secret) { setRoomView('live', 'Incomplete invite', 'Ask the owner to send the full room link.', 0); return; }
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/signal`); socket.binaryType = 'arraybuffer';
    socket.addEventListener('open', () => message({ type: 'join', room, ownerKey })); socket.addEventListener('message', receive); socket.addEventListener('close', () => { if (room) setRoomView('live', 'Room service unavailable', 'Refresh to reconnect.', 0); });
  }
  function receive({ data }) { if (typeof data === 'string') { handleControl(JSON.parse(data)); return; } receiveChunk(data); }
  function handleControl(event) {
    if (event.type === 'joined') { role = event.role; setRoomView(role === 'owner' ? 'live' : 'connected', role === 'owner' ? 'Private room created' : 'Room joined', role === 'owner' ? 'Share the invite with up to 250 receivers.' : 'Waiting for the owner to share a file.', event.receivers); setState('discovery'); return; }
    if (event.type === 'room-update') { setRoomView(role === 'owner' ? 'live' : 'connected', role === 'owner' ? 'Private room created' : 'Room joined', role === 'owner' ? 'Receivers can accept your files.' : 'Waiting for the owner to share a file.', event.receivers); return; }
    if (event.type === 'owner-offline') { setRoomView('live', 'Owner is offline', 'This room can receive only while its creator is connected.', event.receivers); return; }
    if (event.type === 'room-full') { setRoomView('live', 'Room is full', 'This room already has 250 receivers.', event.receivers); return; }
    if (event.type === 'room-not-found') { setRoomView('live', 'Room not found', 'Ask the owner to create a room first.', 0); return; }
    if (event.type === 'broadcast-offer') return showOffer(event);
    if (event.type === 'broadcast-audience') return onAudience(event);
    if (event.type === 'broadcast-start') return startReceiving(event);
    if (event.type === 'broadcast-end' && incoming) return finishReceive();
    if (event.type === 'broadcast-cancel') { abortIncoming(); outgoing = undefined; setState('discovery'); showToast('Transfer cancelled'); return; }
    if (event.type === 'receiver-slow') return showToast('A slow receiver was removed to keep the broadcast smooth');
  }
  function offerFile(file) {
    if (role !== 'owner') return showToast('Only the room creator can send files');
    outgoing = { id: crypto.randomUUID(), file, accepted: 0, started: false, sent: 0, nonce: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(8))) }; setState('transfer'); $('#cancel').textContent = 'Cancel'; transferUI({ name: file.name, size: file.size, progress: 0, mode: 'offer', detail: 'Waiting for receivers to accept this encrypted file' });
    message({ type: 'broadcast-offer', transferId: outgoing.id, name: file.name, size: file.size, mime: file.type || 'application/octet-stream', nonce: outgoing.nonce });
  }
  function onAudience({ transferId, count }) {
    if (!outgoing || outgoing.id !== transferId) return; outgoing.accepted = count; transferUI({ name: outgoing.file.name, size: outgoing.file.size, progress: 0, mode: 'offer', detail: count ? `${count} receiver${count === 1 ? '' : 's'} accepted — starting shortly` : 'Waiting for a receiver to accept' });
    if (count && !outgoing.startTimer && !outgoing.started) outgoing.startTimer = setTimeout(startBroadcast, START_DELAY);
  }
  async function waitForSocket() { while (socket?.bufferedAmount > HIGH_WATER_MARK) await new Promise((resolve) => setTimeout(resolve, 20)); }
  async function startBroadcast() {
    if (!outgoing || outgoing.started || !outgoing.accepted) return; outgoing.started = true; message({ type: 'broadcast-start', transferId: outgoing.id }); const started = performance.now(); const key = await getAesKey();
    try {
      while (outgoing.sent < outgoing.file.size && outgoing && socket?.readyState === WebSocket.OPEN) { await waitForSocket(); const plain = await outgoing.file.slice(outgoing.sent, outgoing.sent + CHUNK_SIZE).arrayBuffer(); const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv(outgoing.nonce, outgoing.sent / CHUNK_SIZE) }, key, plain); socket.send(encrypted); outgoing.sent += plain.byteLength; const speed = outgoing.sent / Math.max(.1, (performance.now() - started) / 1000); transferUI({ name: outgoing.file.name, size: outgoing.file.size, progress: outgoing.sent / outgoing.file.size * 100, speed, mode: 'send', detail: `Sending once to ${outgoing.accepted} accepted receiver${outgoing.accepted === 1 ? '' : 's'}` }); }
      if (outgoing) { message({ type: 'broadcast-end', transferId: outgoing.id }); transferUI({ name: outgoing.file.name, size: outgoing.file.size, progress: 100, mode: 'send', detail: 'Encrypted broadcast complete' }); $('#cancel').textContent = 'Done'; }
    } catch (error) { console.error(error); showToast('Broadcast interrupted'); }
  }
  function showOffer(offer) { pendingOffer = offer; $('#offerName').textContent = offer.name; $('#offerMeta').textContent = `${formatBytes(offer.size)} · ${extension(offer.name)} file`; $('#offerNote').textContent = 'Encrypted by the room owner. Choose whether to receive it.'; $('#offerModal').classList.add('open'); }
  async function acceptOffer() {
    if (!pendingOffer || !secret) return showToast('This invite does not contain an encryption key'); const transfer = { ...pendingOffer, received: 0, index: 0, chunks: null, writable: null, writeChain: Promise.resolve(), started: performance.now() };
    try { if ('showSaveFilePicker' in window) { const handle = await window.showSaveFilePicker({ suggestedName: transfer.name }); transfer.writable = await handle.createWritable(); } else transfer.chunks = []; await getAesKey(); }
    catch (error) { if (error.name !== 'AbortError') showToast('Could not open the save location'); return; }
    incoming = transfer; pendingOffer = undefined; $('#offerModal').classList.remove('open'); setState('transfer'); $('#cancel').textContent = 'Cancel'; transferUI({ name: incoming.name, size: incoming.size, progress: 0, mode: 'receive', detail: incoming.writable ? 'Saving directly to the location you chose' : 'Browser download mode — keep this tab open' }); message({ type: 'broadcast-accept', transferId: incoming.transferId });
  }
  function declineOffer() { if (!pendingOffer) return; message({ type: 'broadcast-decline', transferId: pendingOffer.transferId }); pendingOffer = undefined; $('#offerModal').classList.remove('open'); showToast('File declined'); }
  function startReceiving(event) { if (!incoming || incoming.transferId !== event.transferId) return; incoming.live = true; }
  function receiveChunk(ciphertext) {
    if (!incoming?.live) return; incoming.writeChain = incoming.writeChain.then(async () => { const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv(incoming.nonce, incoming.index++) }, await getAesKey(), ciphertext); if (incoming.writable) await incoming.writable.write(plain); else incoming.chunks.push(plain); incoming.received += plain.byteLength; const speed = incoming.received / Math.max(.1, (performance.now() - incoming.started) / 1000); transferUI({ name: incoming.name, size: incoming.size, progress: Math.min(100, incoming.received / incoming.size * 100), speed, mode: 'receive', detail: incoming.writable ? 'Saving directly to the location you chose' : 'Browser download mode — keep this tab open' }); }).catch((error) => { console.error(error); showToast('Could not decrypt this transfer'); });
  }
  async function finishReceive() { const complete = incoming; incoming = undefined; try { await complete.writeChain; if (complete.writable) { await complete.writable.close(); $('#transferDetail').textContent = 'Saved to the location you chose'; } else { const url = URL.createObjectURL(new Blob(complete.chunks, { type: complete.mime })); const link = document.createElement('a'); link.href = url; link.download = complete.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000); $('#transferDetail').textContent = 'Download started'; } transferUI({ name: complete.name, size: complete.size, progress: 100, mode: 'receive', detail: $('#transferDetail').textContent }); $('#cancel').textContent = 'Done'; } catch (error) { console.error(error); showToast('Could not save this file'); } }
  async function abortIncoming() { if (incoming?.writable) try { await incoming.writable.abort(); } catch {} incoming = undefined; }
  async function cancelTransfer() { if (outgoing) message({ type: 'broadcast-cancel', transferId: outgoing.id }); if (incoming) message({ type: 'broadcast-cancel', transferId: incoming.transferId }); clearTimeout(outgoing?.startTimer); outgoing = undefined; await abortIncoming(); setState('discovery'); showToast('Transfer cancelled'); }
  function setupEvents() {
    $('#createRoom').addEventListener('click', createRoom); $('#chooseFile').addEventListener('click', () => role === 'owner' ? $('#fileInput').click() : showToast('Only the room creator can send files')); $('#fileInput').addEventListener('change', (event) => { if (event.target.files?.[0]) offerFile(event.target.files[0]); event.target.value = ''; });
    ['dragenter', 'dragover'].forEach((name) => document.addEventListener(name, (event) => { event.preventDefault(); dragDepth += 1; workspace.classList.add('dragging'); $('#dropTitle').textContent = role === 'owner' ? 'Drop files to broadcast' : 'Only the room owner can send'; $('#dropCopy').textContent = role === 'owner' ? 'Receivers choose whether to accept them.' : 'You will be asked before receiving a file.'; setState('drop'); })); ['dragleave', 'drop'].forEach((name) => document.addEventListener(name, (event) => { event.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) { workspace.classList.remove('dragging'); if (!event.dataTransfer?.files?.length) setState('discovery'); } })); document.addEventListener('drop', (event) => { if (role === 'owner' && event.dataTransfer.files?.[0]) offerFile(event.dataTransfer.files[0]); else if (event.dataTransfer.files?.[0]) showToast('Only the room creator can send files'); });
    $('#cancel').addEventListener('click', () => $('#cancel').textContent === 'Done' ? setState('discovery') : cancelTransfer()); $('#backToRoom').addEventListener('click', cancelTransfer); $('#showQr').addEventListener('click', () => $('#qrModal').classList.add('open')); $('#closeQr').addEventListener('click', () => $('#qrModal').classList.remove('open')); $('#qrModal').addEventListener('click', (event) => { if (event.target === event.currentTarget) event.currentTarget.classList.remove('open'); }); $('#acceptOffer').addEventListener('click', acceptOffer); $('#declineOffer').addEventListener('click', declineOffer); $('#copyLink').addEventListener('click', async () => { try { await navigator.clipboard.writeText(roomUrl()); showToast('Encrypted invite copied'); } catch { showToast(roomUrl()); } }); $('#securityButton').addEventListener('click', () => $('#drawer').classList.toggle('open')); $('#closeDrawer').addEventListener('click', () => $('#drawer').classList.remove('open'));
    workspace.addEventListener('pointermove', (event) => { const box = workspace.getBoundingClientRect(); const x = (event.clientX - box.left) / box.width - .5; const y = (event.clientY - box.top) / box.height - .5; app.style.setProperty('--mouse-x', `${event.clientX / innerWidth * 100}%`); app.style.setProperty('--mouse-y', `${event.clientY / innerHeight * 100}%`); $('#radar').style.setProperty('--lean-x', `${x * -9}deg`); $('#radar').style.setProperty('--lean-y', `${y * 9}deg`); }); workspace.addEventListener('pointerleave', () => { $('#radar').style.setProperty('--lean-x', '0deg'); $('#radar').style.setProperty('--lean-y', '0deg'); });
  }
  setupEvents(); if (room) { if (!secret) setRoomView('live', 'Incomplete invite', 'Ask the owner to send the full invite link.', 0); else { role = ownerKey ? 'owner' : 'receiver'; setRoomView('joining', 'Joining room', 'Connecting to the private broadcast room.', 0); connect(); } } else setRoomView('idle', 'Start a private room', 'Create a room to invite up to 250 receivers.', 0);
})();
