/**
 * game.js — 8-Ball Pool Client Engine
 * Handles: Canvas rendering, 2D physics, cue input, Socket.IO networking
 */

'use strict';

// ═══════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════

const TABLE_W    = 900;
const TABLE_H    = 500;
const BALL_R     = 14;
const FRICTION   = 0.986;       // Per-frame velocity multiplier
const MIN_SPEED  = 0.08;        // Below this → ball stops
const POCKET_R   = 22;
const MAX_POWER  = 22;          // Max cue ball launch speed

// Pocket positions [x, y] — 6 pockets
const POCKETS = [
  [POCKET_R, POCKET_R],                          // TL
  [TABLE_W / 2, POCKET_R - 4],                   // TM
  [TABLE_W - POCKET_R, POCKET_R],                // TR
  [POCKET_R, TABLE_H - POCKET_R],                // BL
  [TABLE_W / 2, TABLE_H - POCKET_R + 4],        // BM
  [TABLE_W - POCKET_R, TABLE_H - POCKET_R],      // BR
];

// Ball colors
const BALL_DATA = {
  0:  { color: '#FFFFFF', stripe: false, label: 'CUE' },
  1:  { color: '#F5C518', stripe: false },
  2:  { color: '#1565C0', stripe: false },
  3:  { color: '#C62828', stripe: false },
  4:  { color: '#7B1FA2', stripe: false },
  5:  { color: '#E65100', stripe: false },
  6:  { color: '#2E7D32', stripe: false },
  7:  { color: '#4E342E', stripe: false },
  8:  { color: '#1a1a1a', stripe: false },
  9:  { color: '#F5C518', stripe: true },
  10: { color: '#1565C0', stripe: true },
  11: { color: '#C62828', stripe: true },
  12: { color: '#7B1FA2', stripe: true },
  13: { color: '#E65100', stripe: true },
  14: { color: '#2E7D32', stripe: true },
  15: { color: '#4E342E', stripe: true },
};

const AVATAR_COLORS = ['#e74c3c','#3498db','#2ecc71','#f39c12'];


// ═══════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════

let socket, myPlayerId, roomId, playerName;
let players    = [];
let balls      = [];
let gameStarted = false;
let myTurn     = false;
let ballInHand = false;
let groupsAssigned = false;
let myGroup    = null;  // 'solids' | 'stripes' | null

// Physics simulation state
let simRunning = false;
let firstBallHit = null;
let railContacted = false;
let ballsPottedThisTurn = [];
let cueScratch = false;

// Cue input state
let aiming = false;
let aimStart = null;     // canvas coords of mousedown
let aimAngle = 0;
let aimPower = 0;
let mousePos  = { x: 0, y: 0 };

// Ball-in-hand placement mode
let placingCueBall = false;

// Canvas
let canvas, ctx;
let scaleX = 1, scaleY = 1;  // For DPI scaling

// Animation
let animFrameId = null;


// ═══════════════════════════════════════════════════
// ENTRY POINT
// ═══════════════════════════════════════════════════

function initGame(room, name) {
  roomId = room;
  playerName = name;

  setupCanvas();
  setupSocket();
  setupInput();
  startRenderLoop();
}

window.initGame = initGame;


// ═══════════════════════════════════════════════════
// CANVAS SETUP
// ═══════════════════════════════════════════════════

function setupCanvas() {
  canvas = document.getElementById('poolCanvas');

  // Resize canvas to fit viewport
  function resize() {
    const maxW = window.innerWidth - 480;   // account for sidebars
    const maxH = window.innerHeight - 100;
    const aspect = TABLE_W / TABLE_H;

    let w = Math.min(maxW, TABLE_W);
    let h = w / aspect;
    if (h > maxH) { h = maxH; w = h * aspect; }
    w = Math.max(w, 400);

    scaleX = w / TABLE_W;
    scaleY = h / TABLE_H;

    canvas.style.width  = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width  = w * (window.devicePixelRatio || 1);
    canvas.height = h * (window.devicePixelRatio || 1);

    ctx = canvas.getContext('2d');
    ctx.scale(
      (w / TABLE_W) * (window.devicePixelRatio || 1),
      (h / TABLE_H) * (window.devicePixelRatio || 1)
    );
  }

  resize();
  window.addEventListener('resize', resize);
}


// ═══════════════════════════════════════════════════
// SOCKET.IO NETWORKING
// ═══════════════════════════════════════════════════

function setupSocket() {
  socket = io();
  window._socket = socket;

  // ── Connection ──
  socket.on('connect', () => {
    log('Connected to server', 'highlight');
    socket.emit('join_room', { room_id: roomId, player_name: playerName });
  });

  socket.on('disconnect', () => {
    log('Disconnected from server', 'foul');
  });

  // ── Room events ──
  socket.on('error', (data) => {
    log('⚠ ' + data.message, 'foul');
    showOverlay('⚠', data.message, data.message);
  });

  socket.on('room_joined', (data) => {
    myPlayerId = data.player_id;
    players = data.players;
    updatePlayerListUI();
    updateScoreBoard();

    document.getElementById('controlsHint').style.display = 'flex';

    if (data.game_state && data.game_state.started) {
      // Rejoining mid-game
      loadGameState(data.game_state);
    } else {
      showWaiting();
    }
    log(`Joined room ${roomId} as ${playerName}`);
  });

  socket.on('player_joined', (data) => {
    players = data.players;
    updatePlayerListUI();
    updateScoreBoard();
    log(`${data.player.name} joined the table`);
  });

  socket.on('player_left', (data) => {
    players = data.players;
    updatePlayerListUI();
    log(`${data.player_name} left`, 'foul');
  });

  // ── Game events ──
  socket.on('game_started', (data) => {
    gameStarted = true;
    players = data.players;
    loadGameState(data.game_state);
    hideOverlay();
    log('▶ Game started!', 'highlight');
    setTurn(data.current_player_id);
    updatePlayerListUI();
    updateScoreBoard();
    initBallTracker();
  });

  socket.on('shot_taken', (data) => {
    if (data.player_id === myPlayerId) return; // We already simulated locally
    // Simulate the shot from received params
    applyShotToLocal(data.angle, data.power, data.cue_ball_pos);
  });

  socket.on('turn_updated', (data) => {
    players = data.players;
    ballInHand = data.ball_in_hand;
    groupsAssigned = data.players.some(p => p.group);

    // Update my group
    const me = players.find(p => p.id === myPlayerId);
    if (me) myGroup = me.group;

    // Apply authoritative ball positions if provided (for re-sync)
    if (data.ball_positions && Object.keys(data.ball_positions).length > 0) {
      syncBallPositions(data.ball_positions);
    }

    if (data.foul) {
      log(`⚠ FOUL: ${data.foul_reason}`, 'foul');
    }

    if (data.balls_potted && data.balls_potted.length > 0) {
      log(`Potted: ${data.balls_potted.map(n => n === 0 ? 'CUE' : `#${n}`).join(', ')}`);
      updateBallTracker();
    }

    setTurn(data.current_player_id);
    updatePlayerListUI();
    updateScoreBoard();
  });

  socket.on('groups_assigned', (data) => {
    players = data.players;
    groupsAssigned = true;
    const me = players.find(p => p.id === myPlayerId);
    if (me && me.group) {
      myGroup = me.group;
      log(`Your group: ${me.group.toUpperCase()}`, 'highlight');
    }
    updatePlayerListUI();
    initBallTracker();
  });

  socket.on('turn_changed', (data) => {
    setTurn(data.current_player_id);
    ballInHand = data.ball_in_hand;
    console.log(`${data.current_player_name}'s turn`);
  });

  socket.on('cue_ball_placed', (data) => {
    const cueBall = balls.find(b => b.id === 0);
    if (cueBall && data.position) {
      cueBall.x = data.position.x;
      cueBall.y = data.position.y;
    }
  });

  socket.on('game_over', (data) => {
    gameStarted = false;
    myTurn = false;
    const icon = data.winner && data.winner.id === myPlayerId ? '🏆' : '😞';
    showOverlay(
      icon,
      data.winner ? `${data.winner.name.toUpperCase()} WINS!` : 'GAME OVER',
      data.reason,
      true
    );
    log(data.reason, 'win');
  });

  socket.on('waiting_for_players', () => {
    gameStarted = false;
    myTurn = false;
    showWaiting();
  });

  socket.on('chat_message', (data) => {
    appendChat(data.player_name, data.message);
  });
}


// ═══════════════════════════════════════════════════
// INPUT HANDLING
// ═══════════════════════════════════════════════════

function setupInput() {
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseup', onMouseUp);

  // Touch support
  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    const t = e.touches[0];
    onMouseDown(toCanvasEvent(t));
  }, { passive: false });
  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    const t = e.touches[0];
    onMouseMove(toCanvasEvent(t));
  }, { passive: false });
  canvas.addEventListener('touchend', e => {
    e.preventDefault();
    onMouseUp({});
  }, { passive: false });

  // Chat
  document.getElementById('chatSend').addEventListener('click', sendChat);
  document.getElementById('chatInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') sendChat();
  });
}

function toCanvasEvent(touch) {
  const rect = canvas.getBoundingClientRect();
  return {
    clientX: touch.clientX,
    clientY: touch.clientY,
    preventDefault: () => {}
  };
}

function canvasCoords(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) / scaleX,
    y: (e.clientY - rect.top)  / scaleY
  };
}

function onMouseDown(e) {
  if (!gameStarted) return;

  const pos = canvasCoords(e);

  // Ball-in-hand: click to place cue ball
  if (ballInHand && myTurn) {
    placingCueBall = true;
    return;
  }

  if (!myTurn || simRunning) return;

  const cueBall = balls.find(b => b.id === 0 && !b.potted);
  if (!cueBall) return;

  // Start aiming from cue ball
  aiming = true;
  aimStart = { x: cueBall.x, y: cueBall.y };
  mousePos = pos;

  document.getElementById('powerWrap').style.display = 'flex';
}

function onMouseMove(e) {
  mousePos = canvasCoords(e);

  if (placingCueBall && myTurn) {
    // Clamp to table
    const x = Math.max(BALL_R + 2, Math.min(TABLE_W - BALL_R - 2, mousePos.x));
    const y = Math.max(BALL_R + 2, Math.min(TABLE_H - BALL_R - 2, mousePos.y));
    const cueBall = balls.find(b => b.id === 0);
    if (cueBall) { cueBall.x = x; cueBall.y = y; }
    return;
  }

  if (!aiming) return;

  // Calculate angle from cue ball to mouse (reversed for shot direction)
  const dx = aimStart.x - mousePos.x;
  const dy = aimStart.y - mousePos.y;
  aimAngle = Math.atan2(dy, dx);

  // Power based on distance (capped)
  const dist = Math.min(Math.hypot(dx, dy), 160);
  aimPower = dist / 160;

  // Update power UI
  const pct = Math.round(aimPower * 100);
  document.getElementById('powerFill').style.height = pct + '%';
  document.getElementById('powerPct').textContent = pct + '%';
}

function onMouseUp(e) {
  // Ball-in-hand placement confirm
  if (placingCueBall && myTurn) {
    placingCueBall = false;
    ballInHand = false;
    const cueBall = balls.find(b => b.id === 0);
    if (cueBall) {
      socket.emit('cue_ball_placed', {
        room_id: roomId,
        position: { x: cueBall.x, y: cueBall.y }
      });
    }
    return;
  }

  if (!aiming || !myTurn) return;
  aiming = false;

  document.getElementById('powerWrap').style.display = 'none';

  if (aimPower < 0.02) return; // Too weak, ignore

  // Execute shot
  executeShot(aimAngle, aimPower);
}


// ═══════════════════════════════════════════════════
// PHYSICS ENGINE
// ═══════════════════════════════════════════════════

/**
 * Apply a shot: set cue ball velocity and begin simulation
 */
function executeShot(angle, power) {
  const cueBall = balls.find(b => b.id === 0 && !b.potted);
  if (!cueBall) return;

  const speed = power * MAX_POWER;
  cueBall.vx = Math.cos(angle) * speed;
  cueBall.vy = Math.sin(angle) * speed;

  // Reset tracking for this turn
  firstBallHit = null;
  railContacted = false;
  ballsPottedThisTurn = [];
  cueScratch = false;
  simRunning = true;
  myTurn = false; // Prevent shooting during sim

  // Emit shot to server for other clients to mirror
  socket.emit('cue_shot', {
    room_id: roomId,
    player_id: myPlayerId,
    angle: angle,
    power: power,
    cue_ball_pos: { x: cueBall.x, y: cueBall.y }
  });
}

/**
 * Mirror a shot received from network (for non-shooting players)
 */
function applyShotToLocal(angle, power, cueBallPos) {
  const cueBall = balls.find(b => b.id === 0 && !b.potted);
  if (!cueBall) return;

  if (cueBallPos) { cueBall.x = cueBallPos.x; cueBall.y = cueBallPos.y; }

  const speed = power * MAX_POWER;
  cueBall.vx = Math.cos(angle) * speed;
  cueBall.vy = Math.sin(angle) * speed;

  simRunning = true;
}

/**
 * Run one physics step
 */
function physicsStep() {
  if (!simRunning) return;

  let anyMoving = false;

  // Update each ball
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    if (b.potted) continue;
    if (Math.abs(b.vx) < MIN_SPEED && Math.abs(b.vy) < MIN_SPEED) {
      b.vx = b.vy = 0;
      continue;
    }

    anyMoving = true;
    b.x += b.vx;
    b.y += b.vy;

    // Apply friction
    b.vx *= FRICTION;
    b.vy *= FRICTION;

    // Wall reflections with rail contact detection
    if (b.x - BALL_R < 0) {
      b.x = BALL_R;
      b.vx = Math.abs(b.vx) * 0.85;
      if (b.id === 0) railContacted = true;
    }
    if (b.x + BALL_R > TABLE_W) {
      b.x = TABLE_W - BALL_R;
      b.vx = -Math.abs(b.vx) * 0.85;
      if (b.id === 0) railContacted = true;
    }
    if (b.y - BALL_R < 0) {
      b.y = BALL_R;
      b.vy = Math.abs(b.vy) * 0.85;
      if (b.id === 0) railContacted = true;
    }
    if (b.y + BALL_R > TABLE_H) {
      b.y = TABLE_H - BALL_R;
      b.vy = -Math.abs(b.vy) * 0.85;
      if (b.id === 0) railContacted = true;
    }

    // Pocket check
    for (const [px, py] of POCKETS) {
      const dist = Math.hypot(b.x - px, b.y - py);
      if (dist < POCKET_R) {
        b.potted = true;
        b.vx = b.vy = 0;
        if (b.id === 0) {
          cueScratch = true;
        } else {
          if (!ballsPottedThisTurn.includes(b.id)) {
            ballsPottedThisTurn.push(b.id);
          }
        }
        break;
      }
    }
  }

  // Ball-ball collisions
  for (let i = 0; i < balls.length; i++) {
    for (let j = i + 1; j < balls.length; j++) {
      const a = balls[i], b2 = balls[j];
      if (a.potted || b2.potted) continue;

      const dx = b2.x - a.x;
      const dy = b2.y - a.y;
      const dist = Math.hypot(dx, dy);
      if (dist === 0 || dist >= BALL_R * 2) continue;

      // Track first ball hit by cue ball
      if (a.id === 0 && firstBallHit === null) firstBallHit = b2.id;
      if (b2.id === 0 && firstBallHit === null) firstBallHit = a.id;

      // Resolve overlap
      const overlap = (BALL_R * 2 - dist) / 2;
      const nx = dx / dist, ny = dy / dist;
      a.x -= nx * overlap;
      a.y -= ny * overlap;
      b2.x += nx * overlap;
      b2.y += ny * overlap;

      // Elastic collision
      const dvx = a.vx - b2.vx;
      const dvy = a.vy - b2.vy;
      const dot = dvx * nx + dvy * ny;
      if (dot <= 0) continue; // Moving apart

      const restitution = 0.92;
      a.vx  -= dot * nx * restitution;
      a.vy  -= dot * ny * restitution;
      b2.vx += dot * nx * restitution;
      b2.vy += dot * ny * restitution;
    }
  }

  // Check if simulation ended
  if (!anyMoving) {
    simRunning = false;
    onSimulationEnd();
  }
}

/**
 * Called when all balls stop moving — report result to server
 */
function onSimulationEnd() {
  const ballPositions = {};
  balls.forEach(b => {
    ballPositions[b.id] = { x: b.x, y: b.y, potted: b.potted };
  });

  let hitOwnFirst = true;
  if (groupsAssigned && myGroup && firstBallHit !== null && firstBallHit !== 0) {
    if (myGroup === 'solids'  && !(firstBallHit >= 1 && firstBallHit <= 7))  hitOwnFirst = false;
    if (myGroup === 'stripes' && !(firstBallHit >= 9 && firstBallHit <= 15)) hitOwnFirst = false;
  }

  const eightPotted = ballsPottedThisTurn.includes(8);

  // Only the shooting player (who initiated the shot) sends result
  socket.emit('turn_result', {
    room_id: roomId,
    player_id: myPlayerId,
    balls_potted: ballsPottedThisTurn,
    cue_scratch: cueScratch,
    hit_own_first: hitOwnFirst,
    rail_contacted: railContacted,
    eight_ball_potted: eightPotted,
    ball_positions: ballPositions
  });

  // Optional: respawn cue ball visually after scratch (for preview only)
 if (cueScratch) {
        const cueBall = balls.find(b => b.id === 0);
        if (cueBall) {
            cueBall.potted = false;
            cueBall.x = TABLE_W * 0.25;
            cueBall.y = TABLE_H * 0.5;
            cueBall.vx = cueBall.vy = 0;
        }
    }

  updateBallTracker();
}

// ═══════════════════════════════════════════════════
// RENDERING
// ═══════════════════════════════════════════════════

function startRenderLoop() {
  function loop() {
    physicsStep();
    render();
    animFrameId = requestAnimationFrame(loop);
  }
  animFrameId = requestAnimationFrame(loop);
}

function render() {
  if (!ctx) return;
  ctx.clearRect(0, 0, TABLE_W, TABLE_H);

  drawTable();
  drawPockets();
  drawBalls();

  if (gameStarted && !simRunning) {
    if (myTurn && !placingCueBall) drawCueAim();
    if (placingCueBall) drawPlacementGuide();
  }
}

function drawTable() {
  // Felt surface
  const grad = ctx.createRadialGradient(
    TABLE_W/2, TABLE_H/2, 50,
    TABLE_W/2, TABLE_H/2, Math.max(TABLE_W, TABLE_H)
  );
  grad.addColorStop(0, '#236b44');
  grad.addColorStop(1, '#1a5c38');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, TABLE_W, TABLE_H);

  // Felt texture lines
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 1;
  for (let y = 0; y < TABLE_H; y += 12) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(TABLE_W, y); ctx.stroke();
  }

  // Baulk line (head string)
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(TABLE_W * 0.25, 0);
  ctx.lineTo(TABLE_W * 0.25, TABLE_H);
  ctx.stroke();
  ctx.setLineDash([]);

  // Center spot
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.beginPath();
  ctx.arc(TABLE_W * 0.65, TABLE_H * 0.5, 3, 0, Math.PI * 2);
  ctx.fill();

  // Head spot
  ctx.beginPath();
  ctx.arc(TABLE_W * 0.25, TABLE_H * 0.5, 3, 0, Math.PI * 2);
  ctx.fill();
}

function drawPockets() {
  for (const [px, py] of POCKETS) {
    // Shadow
    ctx.shadowBlur = 16;
    ctx.shadowColor = 'rgba(0,0,0,0.8)';

    ctx.fillStyle = '#050e09';
    ctx.beginPath();
    ctx.arc(px, py, POCKET_R, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur = 0;

    // Pocket rim
    ctx.strokeStyle = 'rgba(74,44,10,0.6)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(px, py, POCKET_R, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawBalls() {
  for (const ball of balls) {
    if (ball.potted) continue;
    drawBall(ball);
  }
}

function drawBall(ball) {
  const { x, y, id } = ball;
  const data = BALL_DATA[id] || { color: '#888', stripe: false };

  ctx.save();
  ctx.translate(x, y);

  // Shadow
  ctx.shadowBlur = 8;
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 3;

  if (data.stripe) {
    // White base
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(0, 0, BALL_R, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur = 0;

    // Colored stripe band
    ctx.fillStyle = data.color;
    ctx.beginPath();
    ctx.arc(0, 0, BALL_R, 0, Math.PI * 2);
    ctx.save();
    ctx.clip();
    ctx.fillRect(-BALL_R, -BALL_R * 0.42, BALL_R * 2, BALL_R * 0.84);
    ctx.restore();

    // Number circle on stripe
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(0, 0, BALL_R * 0.38, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Solid ball
    ctx.fillStyle = data.color;
    ctx.beginPath();
    ctx.arc(0, 0, BALL_R, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur = 0;

    // Number circle
    if (id !== 0) {
      ctx.fillStyle = id === 8 ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.arc(0, 0, BALL_R * 0.38, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Ball number
  if (id !== 0) {
    ctx.fillStyle = id === 8 ? '#000' : data.color === '#ffffff' ? '#333' : '#222';
    if (data.stripe) ctx.fillStyle = data.color;
    ctx.font = `bold ${id >= 10 ? 8 : 9}px DM Sans`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(id), 0, 0.5);
  }

  // Specular highlight
  const highlight = ctx.createRadialGradient(-BALL_R*0.3, -BALL_R*0.35, 0, 0, 0, BALL_R);
  highlight.addColorStop(0, 'rgba(255,255,255,0.45)');
  highlight.addColorStop(0.4, 'rgba(255,255,255,0.1)');
  highlight.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = highlight;
  ctx.beginPath();
  ctx.arc(0, 0, BALL_R, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawCueAim() {
  const cueBall = balls.find(b => b.id === 0 && !b.potted);
  if (!cueBall) return;

  if (aiming) {
    const angle = aimAngle;

    // Dotted aim line
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.moveTo(cueBall.x, cueBall.y);
    ctx.lineTo(
      cueBall.x + Math.cos(angle) * 280,
      cueBall.y + Math.sin(angle) * 280
    );
    ctx.stroke();

    // Cue stick
    const cueStart = 30 + aimPower * 40;
    const cueLen = 180;
    const backAngle = angle + Math.PI;
    ctx.strokeStyle = '#c8922a';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(
      cueBall.x + Math.cos(backAngle) * cueStart,
      cueBall.y + Math.sin(backAngle) * cueStart
    );
    ctx.lineTo(
      cueBall.x + Math.cos(backAngle) * (cueStart + cueLen),
      cueBall.y + Math.sin(backAngle) * (cueStart + cueLen)
    );
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.restore();
  } else {
    // Idle cue indicator
    const dx = mousePos.x - cueBall.x;
    const dy = mousePos.y - cueBall.y;
    const angle = Math.atan2(dy, dx) + Math.PI;

    ctx.save();
    ctx.strokeStyle = 'rgba(200,146,42,0.5)';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cueBall.x + Math.cos(angle) * 30, cueBall.y + Math.sin(angle) * 30);
    ctx.lineTo(cueBall.x + Math.cos(angle) * 90, cueBall.y + Math.sin(angle) * 90);
    ctx.stroke();
    ctx.restore();
  }
}

function drawPlacementGuide() {
  const cueBall = balls.find(b => b.id === 0);
  if (!cueBall) return;

  ctx.save();
  ctx.strokeStyle = 'rgba(124,191,224,0.8)';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.arc(cueBall.x, cueBall.y, BALL_R + 4, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = 'rgba(124,191,224,0.15)';
  ctx.beginPath();
  ctx.arc(cueBall.x, cueBall.y, BALL_R + 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}


// ═══════════════════════════════════════════════════
// GAME STATE MANAGEMENT
// ═══════════════════════════════════════════════════

function loadGameState(state) {
  if (state.balls && state.balls.length > 0) {
    balls = state.balls.map(b => ({ ...b }));
  }
  gameStarted = state.started || false;
  ballInHand  = state.ball_in_hand || false;
  groupsAssigned = state.groups_assigned || false;

  const me = players.find(p => p.id === myPlayerId);
  if (me) myGroup = me.group || null;
}

function setTurn(currentPlayerId) {
  myTurn = (currentPlayerId === myPlayerId);

  const currentPlayer = players.find(p => p.id === currentPlayerId);
  const label = document.getElementById('turnLabel');
  if (label) {
    label.textContent = myTurn
      ? '🎯 YOUR TURN'
      : `⏳ ${currentPlayer ? currentPlayer.name + "'s turn" : "Waiting..."}`;
    label.style.color = myTurn ? '#d4a843' : '#8aad96';
  }

  updatePlayerListUI();
}

function syncBallPositions(positions) {
  for (const [id, pos] of Object.entries(positions)) {
    const ball = balls.find(b => b.id === parseInt(id));
    if (ball) {
      ball.x = pos.x;
      ball.y = pos.y;
      ball.potted = pos.potted;
      ball.vx = ball.vy = 0;
    }
  }
}


// ═══════════════════════════════════════════════════
// UI UPDATES
// ═══════════════════════════════════════════════════

function updatePlayerListUI() {
  const list = document.getElementById('playerList');
  if (!list) return;

  const currentPlayer = players.find(p =>
    p.id === (document.getElementById('turnLabel')?.textContent.includes('YOUR') ? myPlayerId : null)
  );

  list.innerHTML = players.map((p, i) => {
    const isActive = p.id === getActiveTurnPlayerId();
    const isMe = p.id === myPlayerId;
    const groupIcon = p.group === 'solids' ? '⚫' : p.group === 'stripes' ? '🔵' : '—';

    return `
      <div class="player-item ${isActive ? 'active' : ''} ${isMe ? 'is-me' : ''}">
        <div class="player-avatar" style="background:${AVATAR_COLORS[i % AVATAR_COLORS.length]}20;color:${AVATAR_COLORS[i % AVATAR_COLORS.length]}">
          ${p.name[0].toUpperCase()}
        </div>
        <div class="player-info">
          <div class="player-name-label">${p.name}${isMe ? ' (you)' : ''}</div>
          <div class="player-group-label">${p.group ? p.group.toUpperCase() : 'No group yet'}</div>
        </div>
        ${isActive && gameStarted ? '<div class="turn-dot"></div>' : ''}
      </div>
    `;
  }).join('');
}

let _activeTurnPlayerId = null;
function getActiveTurnPlayerId() { return _activeTurnPlayerId; }

// Intercept setTurn to track active
const _origSetTurn = setTurn;
// (already defined above, keeping reference)

// Patch setTurn
function setTurn(currentPlayerId) {
  _activeTurnPlayerId = currentPlayerId;
  myTurn = (currentPlayerId === myPlayerId);

  const currentPlayer = players.find(p => p.id === currentPlayerId);
  const label = document.getElementById('turnLabel');
  if (label) {
    label.textContent = myTurn
      ? '🎯 YOUR TURN'
      : `⏳ ${currentPlayer ? currentPlayer.name + "'s turn" : "Waiting..."}`;
    label.style.color = myTurn ? '#d4a843' : '#8aad96';
  }

  updatePlayerListUI();
}

function updateScoreBoard() {
  const board = document.getElementById('scoreBoard');
  if (!board) return;

  board.innerHTML = players.map((p, i) => {
    const isActive = p.id === _activeTurnPlayerId;
    return `
      <div class="score-item ${isActive ? 'active' : ''}">
        <div>
          <div class="score-name" style="color:${AVATAR_COLORS[i % AVATAR_COLORS.length]}">${p.name}</div>
          <div style="font-size:10px;color:var(--text-muted)">${p.group || 'TBD'}</div>
        </div>
        <div class="score-val">${p.score || 0}</div>
      </div>
    `;
  }).join('');
}

function initBallTracker() {
  const tracker = document.getElementById('ballTracker');
  if (!tracker) return;

  const solidNums  = [1,2,3,4,5,6,7];
  const stripeNums = [9,10,11,12,13,14,15];

  function renderGroup(nums, label) {
    const row = `
      <div class="tracker-row">
        <div class="tracker-label">${label}</div>
        ${nums.map(n => {
          const data = BALL_DATA[n];
          return `
            <div class="mini-ball ${data.stripe ? 'stripe' : ''}"
                 id="miniball-${n}"
                 style="background:${data.color}; ${data.stripe ? 'color:#fff' : ''}">
              <span style="position:relative;z-index:1;font-size:8px">${n}</span>
            </div>
          `;
        }).join('')}
      </div>
    `;
    return row;
  }

  tracker.innerHTML =
    renderGroup(solidNums, 'SOLIDS') +
    renderGroup(stripeNums, 'STRIPES') +
    `<div class="tracker-row">
       <div class="tracker-label">8-BALL</div>
       <div class="mini-ball eight" id="miniball-8" style="background:#1a1a1a">
         <span style="position:relative;z-index:1;font-size:8px;color:#fff">8</span>
       </div>
     </div>`;
}

function updateBallTracker() {
  balls.forEach(b => {
    if (b.id === 0) return;
    const el = document.getElementById(`miniball-${b.id}`);
    if (el) el.classList.toggle('potted', b.potted);
  });
}


// ═══════════════════════════════════════════════════
// OVERLAYS
// ═══════════════════════════════════════════════════

function showOverlay(icon, title, sub, showRestart = false) {
  const overlay = document.getElementById('overlay');
  const card = document.getElementById('overlayCard');
  document.getElementById('overlayTitle').textContent = title;
  document.getElementById('overlaySub').textContent = sub;
  document.querySelector('.overlay-icon').textContent = icon;

  const btn = document.getElementById('overlayBtn');
  btn.style.display = showRestart ? 'inline-block' : 'none';

  overlay.classList.remove('hidden');
}

function hideOverlay() {
  document.getElementById('overlay').classList.add('hidden');
}

function showWaiting() {
  showOverlay('⏳', 'WAITING FOR PLAYERS', 'Share the Room ID to invite friends (min. 2 players)');
}


// ═══════════════════════════════════════════════════
// LOG & CHAT
// ═══════════════════════════════════════════════════

function log(message, type = '') {
  const logEl = document.getElementById('gameLog');
  if (!logEl) return;

  const entry = document.createElement('div');
  entry.className = `log-entry ${type === 'foul' ? 'log-foul' : type === 'win' ? 'log-win' : ''}`;
  entry.innerHTML = type === 'highlight'
    ? `<span class="log-highlight">${message}</span>`
    : message;

  logEl.prepend(entry);

  // Keep log from growing too large
  while (logEl.children.length > 30) logEl.removeChild(logEl.lastChild);
}

function appendChat(author, message) {
  const chatEl = document.getElementById('chatMessages');
  if (!chatEl) return;

  const msg = document.createElement('div');
  msg.className = 'chat-msg';
  msg.innerHTML = `<span class="chat-author">${author}:</span> <span class="chat-text">${message}</span>`;
  chatEl.appendChild(msg);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function sendChat() {
  const input = document.getElementById('chatInput');
  const msg = input.value.trim();
  if (!msg) return;

  socket.emit('chat_message', {
    room_id: roomId,
    player_name: playerName,
    message: msg
  });
  appendChat(playerName + ' (you)', msg);
  input.value = '';
}
