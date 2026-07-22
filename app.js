(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const app = $('#app');
  const workspace = $('#workspace');
  const states = { discovery: $('#discoveryState'), drop: $('#dropState'), transfer: $('#transferState') };
  const CHUNK_SIZE = 64 * 1024;
  const HIGH_WATER_MARK = 1024 * 1024;
  const LOW_WATER_MARK = 256 * 1024;
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

  let room = roomFromUrl();
  let socket;
  let peer;
  let channel;
  let isHost = false;
  let queuedCandidates = [];
  let dragDepth = 0;
  let toastTimer;
  let outgoing;
  let incoming;
  let pendingOffer;
  let cancelled = false;

  function roomFromUrl() {
    const url = new URL(location.href);
    const candidate = (url.searchParams.get('room') || url.pathname.split('/').filter(Boolean).pop() || '').toUpperCase();
    return /^[A-Z0-9]{4,8}$/.test(candidate) ? candidate : null;
  }
  function newRoomCode() { return crypto.getRandomValues(new Uint32Array(1))[0].toString(36).slice(0, 6).toUpperCase(); }
  function roomUrl() { return `${location.origin}/${room}`; }
  function setState(name) { Object.values(states).forEach((state) => state.classList.remove('active')); states[name].classList.add('active'); $('#chooseFile').hidden = name !== 'discovery' || channel?.readyState !== 'open'; }
  function showToast(message) { $('#toast').textContent = message; $('#toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 2200); }
  function formatBytes(bytes) { if (!bytes) return '0 B'; const units = ['B', 'KB', 'MB', 'GB', 'TB']; const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1); return `${(bytes / 1024 ** unit).toFixed(unit > 1 ? 2 : 0)} ${units[unit]}`; }
  function formatTime(seconds) { if (!Number.isFinite(seconds)) return 'calculating'; const minutes = Math.floor(seconds / 60); return `${String(minutes).padStart(2, '0')}:${String(Math.ceil(seconds % 60)).padStart(2, '0')}`; }
  function extension(name) { return name.includes('.') ? name.split('.').pop().slice(0, 4).toUpperCase() : 'FILE'; }
  function transferUI({ name, size, progress, speed = 0, mode, detail }) {
    const remaining = speed ? Math.max(0, (size - size * progress / 100) / speed) : Infinity;
    $('#fileName').textContent = name; $('#fileType').textContent = extension(name); $('#percent').textContent = `${Math.floor(progress)}%`; $('#progressBar').style.width = `${progress}%`;
    $('#fileMeta').textContent = progress >= 100 ? `${formatBytes(size)} · complete` : `${formatBytes(size)} · ${speed ? `${formatBytes(speed)}/s · ${formatTime(remaining)} remaining` : 'waiting'}`;
    $('#transferLabel').textContent = mode === 'receive' ? 'Receiving file' : mode === 'offer' ? 'Awaiting receiver' : 'Sending file';
    $('#transferDetail').textContent = detail || 'Direct encrypted connection';
  }
  function setRoomView(kind, message, detail) {
    const active = Boolean(room);
    app.dataset.room = kind;
    $('#roomControls').hidden = !active; $('#showQr').hidden = !active; $('#createRoom').hidden = active;
    $('#roomHeading').textContent = active ? (kind === 'connected' ? 'Device connected' : kind === 'joining' ? 'Joining room' : 'Private room created') : 'Start a private room';
    $('#status').innerHTML = `<b>${message}</b> ${detail || ''}`;
    $('#eyebrow').textContent = active ? `room ${room}` : 'private transfer';
    if (active) { $('#roomCode').textContent = roomUrl().replace(/^https?:\/\//, ''); $('#qrText').textContent = roomUrl(); renderQr(); }
  }
  function setPeer(label, state) { $('#peerText').textContent = label; $('#peerDot').textContent = state === 'connected' ? '✓' : state === 'connecting' ? '◌' : '·'; }
  function renderQr() {
    if (!room) return;
    $('#qr').replaceChildren();
    const image = new Image(170, 170); image.alt = 'QR code for this room'; image.src = `/qr?room=${encodeURIComponent(room)}`; $('#qr').append(image);
  }
  function createRoom() {
    room = newRoomCode();
    if (location.protocol !== 'file:') history.pushState({}, '', `/${room}`);
    setRoomView('live', 'Room created.', 'Share the link or QR code with one device.'); setPeer('Waiting for a device', 'waiting'); connectSignal();
  }
  function signal(payload) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload)); }
  function closePeer() { channel?.close(); peer?.close(); channel = undefined; peer = undefined; queuedCandidates = []; }
  function makePeer() {
    if (peer) return peer;
    peer = new RTCPeerConnection({ iceServers });
    peer.onicecandidate = ({ candidate }) => { if (candidate) signal({ type: 'signal', signal: { kind: 'candidate', candidate } }); };
    peer.onconnectionstatechange = () => { if (peer?.connectionState === 'failed') { closePeer(); setRoomView('live', 'Connection failed.', 'Ask the other device to open the room again.'); setPeer('Waiting for a device', 'waiting'); } };
    peer.ondatachannel = ({ channel: dataChannel }) => attachChannel(dataChannel);
    return peer;
  }
  function attachChannel(dataChannel) {
    channel = dataChannel; channel.binaryType = 'arraybuffer'; channel.bufferedAmountLowThreshold = LOW_WATER_MARK;
    channel.onopen = () => { app.dataset.room = 'connected'; setRoomView('connected', 'Direct connection secured.', 'Choose a file when you are ready.'); setPeer('Direct connection secured', 'connected'); $('#chooseFile').hidden = false; showToast('Device connected'); };
    channel.onclose = () => { $('#chooseFile').hidden = true; if (room) { app.dataset.room = 'live'; setRoomView('live', 'Device disconnected.', 'This room is ready for another device.'); setPeer('Waiting for a device', 'waiting'); } };
    channel.onerror = () => showToast('Connection error'); channel.onmessage = receiveMessage;
  }
  async function makeOffer() { const current = makePeer(); attachChannel(current.createDataChannel('nearby', { ordered: true })); const description = await current.createOffer(); await current.setLocalDescription(description); signal({ type: 'signal', signal: { kind: 'offer', description } }); }
  async function drainCandidates(current) { const candidates = queuedCandidates; queuedCandidates = []; for (const candidate of candidates) await current.addIceCandidate(candidate); }
  async function handleSignal({ signal: incomingSignal }) {
    try {
      if (incomingSignal.kind === 'offer') { const current = makePeer(); await current.setRemoteDescription(incomingSignal.description); await drainCandidates(current); const description = await current.createAnswer(); await current.setLocalDescription(description); signal({ type: 'signal', signal: { kind: 'answer', description } }); }
      if (incomingSignal.kind === 'answer') { await peer?.setRemoteDescription(incomingSignal.description); if (peer) await drainCandidates(peer); }
      if (incomingSignal.kind === 'candidate') { if (peer?.remoteDescription) await peer.addIceCandidate(incomingSignal.candidate); else queuedCandidates.push(incomingSignal.candidate); }
    } catch (error) { console.error(error); setRoomView('live', 'Pairing did not finish.', 'Open the same room link on both devices and try again.'); }
  }
  function connectSignal() {
    if (location.protocol === 'file:') { setRoomView('live', 'Preview mode.', 'Run the server to enable pairing.'); return; }
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; socket = new WebSocket(`${protocol}//${location.host}/signal`);
    socket.addEventListener('open', () => signal({ type: 'join', room }));
    socket.addEventListener('message', async ({ data }) => {
      const message = JSON.parse(data);
      if (message.type === 'joined') { isHost = message.host; setRoomView(message.host ? 'live' : 'joining', message.host ? 'Room created.' : 'Joining shared room.', message.host ? 'Share the link or QR code with one device.' : 'Waiting for the first device.'); setPeer(message.host ? 'Waiting for a device' : 'Connecting to room', message.host ? 'waiting' : 'connecting'); }
      if (message.type === 'peer-joined' && isHost) { setRoomView('joining', 'Device found.', 'Establishing a direct encrypted connection.'); setPeer('Establishing connection', 'connecting'); await makeOffer(); }
      if (message.type === 'signal') await handleSignal(message);
      if (message.type === 'peer-left') { closePeer(); setRoomView('live', 'Device left the room.', 'This room is ready for another device.'); setPeer('Waiting for a device', 'waiting'); }
      if (message.type === 'room-full') { setRoomView('live', 'This room is in use.', 'Create a new room to share with someone else.'); setPeer('Room full', 'waiting'); }
    });
    socket.addEventListener('close', () => { if (!channel) setRoomView('live', 'Connection service unavailable.', 'Refresh to try again.'); });
  }
  function waitForBuffer() { if (channel.bufferedAmount <= HIGH_WATER_MARK) return Promise.resolve(); return new Promise((resolve) => channel.addEventListener('bufferedamountlow', resolve, { once: true })); }
  function offerFile(file) {
    if (!channel || channel.readyState !== 'open') return showToast('Connect a second device first');
    cancelled = false; outgoing = { file, sent: 0 }; setState('transfer'); $('#cancel').textContent = 'Cancel';
    transferUI({ name: file.name, size: file.size, progress: 0, mode: 'offer', detail: 'Waiting for the receiver to accept this file' });
    channel.send(JSON.stringify({ type: 'file-offer', name: file.name, size: file.size, mime: file.type || 'application/octet-stream' }));
  }
  async function streamOutgoing() {
    if (!outgoing || !channel || channel.readyState !== 'open') return;
    const started = performance.now();
    try {
      while (outgoing.sent < outgoing.file.size && !cancelled && channel.readyState === 'open') {
        await waitForBuffer(); const bytes = await outgoing.file.slice(outgoing.sent, outgoing.sent + CHUNK_SIZE).arrayBuffer(); channel.send(bytes); outgoing.sent += bytes.byteLength;
        const speed = outgoing.sent / Math.max(.1, (performance.now() - started) / 1000); transferUI({ name: outgoing.file.name, size: outgoing.file.size, progress: outgoing.sent / outgoing.file.size * 100, speed, mode: 'send' });
      }
      if (!cancelled) { channel.send(JSON.stringify({ type: 'file-end' })); transferUI({ name: outgoing.file.name, size: outgoing.file.size, progress: 100, mode: 'send', detail: 'Sent directly to the receiving device' }); $('#cancel').textContent = 'Done'; }
    } catch (error) { console.error(error); showToast('Transfer interrupted'); }
  }
  function showOffer(offer) { pendingOffer = offer; $('#offerName').textContent = offer.name; $('#offerMeta').textContent = `${formatBytes(offer.size)} · ${extension(offer.name)} file`; $('#offerNote').textContent = 'This device will choose where to save it.'; $('#offerModal').classList.add('open'); }
  async function acceptOffer() {
    if (!pendingOffer) return;
    const transfer = { ...pendingOffer, received: 0, started: performance.now(), writeChain: Promise.resolve(), chunks: null, writable: null };
    try {
      if ('showSaveFilePicker' in window) { const handle = await window.showSaveFilePicker({ suggestedName: transfer.name }); transfer.writable = await handle.createWritable(); }
      else transfer.chunks = [];
    } catch (error) { if (error.name !== 'AbortError') showToast('Could not open the save location'); return; }
    incoming = transfer; pendingOffer = undefined; $('#offerModal').classList.remove('open'); setState('transfer'); $('#cancel').textContent = 'Cancel';
    transferUI({ name: incoming.name, size: incoming.size, progress: 0, mode: 'receive', detail: incoming.writable ? 'Saving directly to your chosen location' : 'Browser download mode — keep this tab open' });
    channel.send(JSON.stringify({ type: 'file-accept' }));
  }
  function declineOffer() { if (!pendingOffer) return; channel?.send(JSON.stringify({ type: 'file-decline' })); pendingOffer = undefined; $('#offerModal').classList.remove('open'); showToast('File declined'); }
  function receiveMessage({ data }) {
    if (typeof data === 'string') { const message = JSON.parse(data); handleControl(message); return; }
    if (!incoming) return;
    const chunk = data; incoming.received += chunk.byteLength;
    incoming.writeChain = incoming.writeChain.then(() => incoming.writable ? incoming.writable.write(chunk) : incoming.chunks.push(chunk));
    const speed = incoming.received / Math.max(.1, (performance.now() - incoming.started) / 1000); transferUI({ name: incoming.name, size: incoming.size, progress: Math.min(100, incoming.received / incoming.size * 100), speed, mode: 'receive', detail: incoming.writable ? 'Saving directly to your chosen location' : 'Browser download mode — keep this tab open' });
  }
  async function handleControl(message) {
    if (message.type === 'file-offer') return showOffer(message);
    if (message.type === 'file-accept') return streamOutgoing();
    if (message.type === 'file-decline') { outgoing = undefined; setState('discovery'); return showToast('Receiver declined this file'); }
    if (message.type === 'file-end' && incoming) return finishReceive();
    if (message.type === 'cancel') { await abortIncoming(); outgoing = undefined; setState('discovery'); return showToast('Transfer cancelled by the other device'); }
    if (message.type === 'received') { $('#transferDetail').textContent = 'Receiver saved the file'; }
  }
  async function finishReceive() {
    const complete = incoming; incoming = undefined;
    try {
      await complete.writeChain;
      if (complete.writable) { await complete.writable.close(); $('#transferDetail').textContent = 'Saved to the location you chose'; }
      else { const url = URL.createObjectURL(new Blob(complete.chunks, { type: complete.mime })); const link = document.createElement('a'); link.href = url; link.download = complete.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000); $('#transferDetail').textContent = 'Download started'; }
      transferUI({ name: complete.name, size: complete.size, progress: 100, mode: 'receive', detail: $('#transferDetail').textContent }); $('#cancel').textContent = 'Done'; channel?.send(JSON.stringify({ type: 'received' }));
    } catch (error) { console.error(error); showToast('Could not save this file'); }
  }
  async function abortIncoming() { if (incoming?.writable) { try { await incoming.writable.abort(); } catch {} } incoming = undefined; }
  async function cancelTransfer() { cancelled = true; channel?.readyState === 'open' && channel.send(JSON.stringify({ type: 'cancel' })); await abortIncoming(); outgoing = undefined; setState('discovery'); showToast('Transfer cancelled'); }
  function setupEvents() {
    $('#createRoom').addEventListener('click', createRoom); $('#chooseFile').addEventListener('click', () => channel?.readyState === 'open' ? $('#fileInput').click() : showToast('Connect a second device first')); $('#fileInput').addEventListener('change', (event) => { if (event.target.files?.[0]) offerFile(event.target.files[0]); event.target.value = ''; });
    ['dragenter', 'dragover'].forEach((name) => document.addEventListener(name, (event) => { event.preventDefault(); dragDepth += 1; workspace.classList.add('dragging'); $('#dropTitle').textContent = channel?.readyState === 'open' ? 'Drop files to send' : 'Connect a device first'; setState('drop'); }));
    ['dragleave', 'drop'].forEach((name) => document.addEventListener(name, (event) => { event.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) { workspace.classList.remove('dragging'); if (!event.dataTransfer?.files?.length) setState('discovery'); } })); document.addEventListener('drop', (event) => { if (event.dataTransfer.files?.[0]) offerFile(event.dataTransfer.files[0]); });
    $('#cancel').addEventListener('click', () => $('#cancel').textContent === 'Done' ? setState('discovery') : cancelTransfer()); $('#backToRoom').addEventListener('click', cancelTransfer); $('#showQr').addEventListener('click', () => $('#qrModal').classList.add('open')); $('#closeQr').addEventListener('click', () => $('#qrModal').classList.remove('open')); $('#qrModal').addEventListener('click', (event) => { if (event.target === event.currentTarget) event.currentTarget.classList.remove('open'); }); $('#acceptOffer').addEventListener('click', acceptOffer); $('#declineOffer').addEventListener('click', declineOffer);
    $('#copyLink').addEventListener('click', async () => { try { await navigator.clipboard.writeText(roomUrl()); showToast('Room link copied'); } catch { showToast(roomUrl()); } }); $('#securityButton').addEventListener('click', () => { const drawer = $('#drawer'); const open = drawer.classList.toggle('open'); drawer.setAttribute('aria-hidden', String(!open)); }); $('#closeDrawer').addEventListener('click', () => $('#drawer').classList.remove('open'));
    workspace.addEventListener('pointermove', (event) => { const rect = workspace.getBoundingClientRect(); const x = (event.clientX - rect.left) / rect.width - .5; const y = (event.clientY - rect.top) / rect.height - .5; app.style.setProperty('--mouse-x', `${event.clientX / innerWidth * 100}%`); app.style.setProperty('--mouse-y', `${event.clientY / innerHeight * 100}%`); $('#radar').style.setProperty('--lean-x', `${x * -9}deg`); $('#radar').style.setProperty('--lean-y', `${y * 9}deg`); }); workspace.addEventListener('pointerleave', () => { $('#radar').style.setProperty('--lean-x', '0deg'); $('#radar').style.setProperty('--lean-y', '0deg'); });
  }
  setupEvents();
  if (room) { setRoomView('joining', 'Joining shared room.', 'Waiting for the first device.'); setPeer('Connecting to room', 'connecting'); connectSignal(); } else setRoomView('idle', 'Create a room', 'to invite one device.');
})();
