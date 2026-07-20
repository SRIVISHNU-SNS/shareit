(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const workspace = $('#workspace');
  const states = { discovery: $('#discoveryState'), drop: $('#dropState'), transfer: $('#transferState') };
  const fileInput = $('#fileInput');
  const choose = $('#chooseFile');
  const toast = $('#toast');
  const status = $('.status');
  const deviceButtons = [...document.querySelectorAll('.device')];
  const roomCode = $('#roomCode');
  const qrCaption = document.querySelector('.qr-caption code');
  const qr = $('#qr');
  const MAX_ROOM_LENGTH = 8;
  const CHUNK_SIZE = 64 * 1024;
  const HIGH_WATER_MARK = 1024 * 1024;
  const LOW_WATER_MARK = 256 * 1024;
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

  let socket;
  let peer;
  let channel;
  let dragDepth = 0;
  let toastTimer;
  let cancelled = false;
  let activeTransfer;
  let incoming;
  let queuedCandidates = [];
  let room = getRoom();
  let isHost = false;

  function getRoom() {
    const url = new URL(window.location.href);
    const pathRoom = url.pathname.split('/').filter(Boolean).pop();
    const candidate = (url.searchParams.get('room') || pathRoom || '').toUpperCase();
    const valid = new RegExp(`^[A-Z0-9]{4,${MAX_ROOM_LENGTH}}$`).test(candidate);
    const result = valid ? candidate : crypto.getRandomValues(new Uint32Array(1))[0].toString(36).slice(0, 5).toUpperCase();
    if (location.protocol !== 'file:' && !valid) history.replaceState({}, '', `/${result}`);
    return result;
  }

  function roomUrl() { return `${location.origin}/${room}`; }
  function setState(name) {
    Object.values(states).forEach((state) => state.classList.remove('active'));
    states[name].classList.add('active');
    choose.hidden = name === 'transfer';
  }
  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2100);
  }
  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / 1024 ** index).toFixed(index > 1 ? 2 : 0)} ${units[index]}`;
  }
  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return 'calculating…';
    const minutes = Math.floor(seconds / 60);
    return `${String(minutes).padStart(2, '0')}:${String(Math.ceil(seconds % 60)).padStart(2, '0')}`;
  }
  function transferUI({ name, size, progress, speed = 0, mode }) {
    const extension = name.includes('.') ? name.split('.').pop().slice(0, 4).toUpperCase() : 'FILE';
    const remaining = speed ? (size - (size * progress / 100)) / speed : Infinity;
    $('#fileName').textContent = name;
    $('#fileType').textContent = extension;
    $('#percent').textContent = `${Math.floor(progress)}%`;
    $('#progressBar').style.width = `${progress}%`;
    $('#fileMeta').textContent = progress >= 100
      ? `${formatBytes(size)} · complete`
      : `${formatBytes(size)} · ${speed ? `${formatBytes(speed)}/s` : 'preparing'} · ${formatTime(remaining)} remaining`;
    $('#transferLabel').textContent = mode === 'receive' ? 'Receiving from connected device' : 'Streaming to connected device';
  }
  function refreshDiscovery(message, peerLabel = 'Waiting for a second device') {
    status.innerHTML = `<b>${message}</b> ${peerLabel}`;
    deviceButtons[0].innerHTML = `<span class="avatar">${channel?.readyState === 'open' ? '✓' : '◌'}</span>${channel?.readyState === 'open' ? 'Peer connected' : 'This room'}`;
    deviceButtons[1].hidden = true;
  }
  function updateRoomUI() {
    roomCode.textContent = roomUrl().replace(/^https?:\/\//, '');
    qrCaption.textContent = roomUrl().replace(/^https?:\/\//, '');
    if (window.QRCode) {
      qr.replaceChildren();
      window.QRCode.toCanvas(qrCaption.textContent, { width: 170, margin: 1, color: { dark: '#121214', light: '#f0f0ec' } }, (error, canvas) => {
        if (!error) qr.append(canvas);
      });
    }
  }
  function signal(payload) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }
  function clearConnection() {
    channel?.close();
    peer?.close();
    channel = undefined;
    peer = undefined;
    queuedCandidates = [];
  }
  function makePeer() {
    if (peer) return peer;
    peer = new RTCPeerConnection({ iceServers });
    peer.onicecandidate = ({ candidate }) => { if (candidate) signal({ type: 'signal', signal: { kind: 'candidate', candidate } }); };
    peer.onconnectionstatechange = () => {
      if (peer?.connectionState === 'failed') {
        refreshDiscovery('Connection could not be established.', 'Try copying the room link again.');
        clearConnection();
      }
    };
    peer.ondatachannel = ({ channel: incomingChannel }) => attachChannel(incomingChannel);
    return peer;
  }
  function attachChannel(nextChannel) {
    channel = nextChannel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = LOW_WATER_MARK;
    channel.onopen = () => {
      refreshDiscovery('Securely connected.', 'Choose files to stream directly.');
      choose.removeAttribute('aria-disabled');
      showToast('Peer connected');
    };
    channel.onclose = () => refreshDiscovery('Connection closed.', 'Share the room link to reconnect.');
    channel.onerror = () => showToast('Transfer channel error');
    channel.onmessage = receiveMessage;
  }
  async function offer() {
    const currentPeer = makePeer();
    attachChannel(currentPeer.createDataChannel('nearby', { ordered: true }));
    const description = await currentPeer.createOffer();
    await currentPeer.setLocalDescription(description);
    signal({ type: 'signal', signal: { kind: 'offer', description } });
  }
  async function onSignal(message) {
    const { kind } = message.signal;
    try {
      if (kind === 'offer') {
        const currentPeer = makePeer();
        await currentPeer.setRemoteDescription(message.signal.description);
        await drainCandidates(currentPeer);
        const description = await currentPeer.createAnswer();
        await currentPeer.setLocalDescription(description);
        signal({ type: 'signal', signal: { kind: 'answer', description } });
      } else if (kind === 'answer') {
        await peer?.setRemoteDescription(message.signal.description);
        if (peer) await drainCandidates(peer);
      } else if (kind === 'candidate') {
        if (peer?.remoteDescription) await peer.addIceCandidate(message.signal.candidate);
        else queuedCandidates.push(message.signal.candidate);
      }
    } catch (error) {
      console.error(error);
      refreshDiscovery('Pairing encountered a problem.', 'Try re-opening this room on both devices.');
    }
  }
  async function drainCandidates(currentPeer) {
    const candidates = queuedCandidates;
    queuedCandidates = [];
    for (const candidate of candidates) await currentPeer.addIceCandidate(candidate);
  }
  function connectSignal() {
    if (location.protocol === 'file:') {
      refreshDiscovery('Preview mode.', 'Run the included server to enable real device pairing.');
      return;
    }
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${location.host}/signal`);
    socket.addEventListener('open', () => signal({ type: 'join', room, device: navigator.userAgent.includes('Mobile') ? 'Phone' : 'Computer' }));
    socket.addEventListener('message', async ({ data }) => {
      const message = JSON.parse(data);
      if (message.type === 'joined') {
        isHost = message.host;
        refreshDiscovery('Room is ready.', isHost ? 'Share the link or QR code with one device.' : 'Connecting to the first device…');
      }
      if (message.type === 'peer-joined' && isHost) { refreshDiscovery('Device found.', 'Creating an encrypted direct tunnel…'); await offer(); }
      if (message.type === 'signal') await onSignal(message);
      if (message.type === 'peer-left') { clearConnection(); refreshDiscovery('Other device left.', 'This room is ready for another device.'); }
      if (message.type === 'room-full') { refreshDiscovery('This room is full.', 'Create a new room to send to someone else.'); }
    });
    socket.addEventListener('close', () => { if (!channel) refreshDiscovery('Signaling is offline.', 'Refresh to reconnect.'); });
  }
  function waitForBuffer() {
    if (channel.bufferedAmount <= HIGH_WATER_MARK) return Promise.resolve();
    return new Promise((resolve) => {
      const release = () => { channel.removeEventListener('bufferedamountlow', release); resolve(); };
      channel.addEventListener('bufferedamountlow', release, { once: true });
    });
  }
  async function sendFile(file) {
    if (!channel || channel.readyState !== 'open') { showToast('Waiting for the other device to connect'); return; }
    cancelled = false;
    const startedAt = performance.now();
    activeTransfer = { file, sent: 0 };
    setState('transfer');
    $('#cancel').textContent = 'Cancel';
    channel.send(JSON.stringify({ type: 'file-meta', name: file.name, size: file.size, mime: file.type || 'application/octet-stream' }));
    while (activeTransfer.sent < file.size && !cancelled && channel.readyState === 'open') {
      await waitForBuffer();
      const chunk = await file.slice(activeTransfer.sent, activeTransfer.sent + CHUNK_SIZE).arrayBuffer();
      channel.send(chunk);
      activeTransfer.sent += chunk.byteLength;
      const elapsed = Math.max(.1, (performance.now() - startedAt) / 1000);
      transferUI({ name: file.name, size: file.size, progress: activeTransfer.sent / file.size * 100, speed: activeTransfer.sent / elapsed, mode: 'send' });
    }
    if (cancelled) return;
    channel.send(JSON.stringify({ type: 'file-end' }));
    transferUI({ name: file.name, size: file.size, progress: 100, mode: 'send' });
    $('#transferDetail').textContent = 'File sent over a direct encrypted connection';
    $('#cancel').textContent = 'Done';
    showToast('Transfer complete');
  }
  function receiveMessage({ data }) {
    if (typeof data === 'string') {
      const message = JSON.parse(data);
      if (message.type === 'file-meta') {
        incoming = { ...message, received: 0, chunks: [], startedAt: performance.now() };
        setState('transfer');
        $('#cancel').textContent = 'Cancel';
        $('#transferDetail').textContent = 'Receiving directly — keep this tab open';
        transferUI({ name: incoming.name, size: incoming.size, progress: 0, mode: 'receive' });
      }
      if (message.type === 'file-end' && incoming) finishReceive();
      if (message.type === 'cancel') { incoming = undefined; setState('discovery'); showToast('Transfer cancelled by other device'); }
      return;
    }
    if (!incoming) return;
    incoming.chunks.push(data);
    incoming.received += data.byteLength;
    const elapsed = Math.max(.1, (performance.now() - incoming.startedAt) / 1000);
    transferUI({ name: incoming.name, size: incoming.size, progress: Math.min(100, incoming.received / incoming.size * 100), speed: incoming.received / elapsed, mode: 'receive' });
  }
  function finishReceive() {
    const complete = incoming;
    incoming = undefined;
    const url = URL.createObjectURL(new Blob(complete.chunks, { type: complete.mime }));
    const download = document.createElement('a');
    download.href = url;
    download.download = complete.name;
    download.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    transferUI({ name: complete.name, size: complete.size, progress: 100, mode: 'receive' });
    $('#transferDetail').textContent = 'Transfer complete · download started';
    $('#cancel').textContent = 'Done';
    channel?.send(JSON.stringify({ type: 'received' }));
    showToast('Download started');
  }
  function cancelTransfer() {
    cancelled = true;
    if (channel?.readyState === 'open') channel.send(JSON.stringify({ type: 'cancel' }));
    activeTransfer = undefined;
    incoming = undefined;
    setState('discovery');
    showToast('Transfer cancelled');
  }
  function setupEvents() {
    ['dragenter', 'dragover'].forEach((eventName) => document.addEventListener(eventName, (event) => {
      event.preventDefault();
      dragDepth += 1;
      workspace.classList.add('dragging');
      setState('drop');
    }));
    ['dragleave', 'drop'].forEach((eventName) => document.addEventListener(eventName, (event) => {
      event.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) { workspace.classList.remove('dragging'); if (!event.dataTransfer?.files?.length) setState('discovery'); }
    }));
    document.addEventListener('drop', (event) => { if (event.dataTransfer.files?.length) sendFile(event.dataTransfer.files[0]); });
    choose.addEventListener('click', () => { if (channel?.readyState === 'open') fileInput.click(); else showToast('Connect a second device first'); });
    fileInput.addEventListener('change', (event) => { if (event.target.files?.length) sendFile(event.target.files[0]); fileInput.value = ''; });
    deviceButtons.forEach((button) => button.addEventListener('click', () => showToast(channel?.readyState === 'open' ? 'This peer is ready to receive' : 'Share the room link to connect a device')));
    $('#cancel').addEventListener('click', () => $('#cancel').textContent === 'Done' ? setState('discovery') : cancelTransfer());
    $('#backToRoom').addEventListener('click', () => { cancelled = true; setState('discovery'); });
    $('#showQr').addEventListener('click', () => $('#qrModal').classList.add('open'));
    $('#closeQr').addEventListener('click', () => $('#qrModal').classList.remove('open'));
    $('#qrModal').addEventListener('click', (event) => { if (event.target === event.currentTarget) event.currentTarget.classList.remove('open'); });
    $('#securityButton').addEventListener('click', () => { const drawer = $('#drawer'); const open = drawer.classList.toggle('open'); drawer.setAttribute('aria-hidden', String(!open)); $('#securityButton').setAttribute('aria-expanded', String(open)); });
    $('#closeDrawer').addEventListener('click', () => { $('#drawer').classList.remove('open'); $('#securityButton').setAttribute('aria-expanded', 'false'); });
    $('#copyLink').addEventListener('click', async () => { try { await navigator.clipboard.writeText(roomUrl()); showToast('Room link copied'); } catch { showToast(roomUrl()); } });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { $('#qrModal').classList.remove('open'); $('#drawer').classList.remove('open'); } });
  }

  updateRoomUI();
  setupEvents();
  connectSignal();
})();
