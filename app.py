"""
app.py - Main Flask application for Multiplayer 8-Ball Pool
Handles HTTP routes and Socket.IO events for real-time multiplayer communication
"""

from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, join_room, leave_room, emit
from db import (
    create_room, get_room, update_room_state, add_player_to_room,
    remove_player_from_room, save_match_history, get_match_history
)
from game_logic import (
    initialize_balls, assign_groups, check_win_condition,
    validate_shot, process_turn_result, get_initial_game_state
)
import uuid
import json


app = Flask(__name__)
app.config['SECRET_KEY'] = 'pool-game-secret-2024'

socketio = SocketIO(app, cors_allowed_origins="*", logger=False, engineio_logger=False)

active_rooms = {}



# ─────────────────────────────────────────────
# HTTP Routes
# ─────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/game/<room_id>')
def game(room_id):
    return render_template('game.html', room_id=room_id)

@app.route('/api/rooms/<room_id>', methods=['GET'])
def get_room_info(room_id):
    room = get_room(room_id)
    if not room:
        return jsonify({'exists': False})
    return jsonify({
        'exists': True,
        'player_count': len(room.get('players', [])),
        'max_players': 4,
        'game_started': room.get('game_state', {}).get('started', False)
    })

@app.route('/api/history', methods=['GET'])
def match_history():
    history = get_match_history(limit=10)
    return jsonify(history)



# ─────────────────────────────────────────────
# Socket.IO Events
# ─────────────────────────────────────────────

@socketio.on('connect')
def handle_connect():
    print(f"[CONNECT] Client connected: {request.sid}")

@socketio.on('disconnect')
def handle_disconnect():
    sid = request.sid
    print(f"[DISCONNECT] Client disconnected: {sid}")

    for room_id, room_data in list(active_rooms.items()):
        players = room_data.get('players', [])
        player = next((p for p in players if p['sid'] == sid), None)

        if player:
            active_rooms[room_id]['players'] = [p for p in players if p['sid'] != sid]
            remove_player_from_room(room_id, player['id'])

            emit('player_left', {
                'player_id': player['id'],
                'player_name': player['name'],
                'players': active_rooms[room_id]['players']
            }, room=room_id)

            game_state = active_rooms[room_id].get('game_state', {})
            if game_state.get('current_player_id') == player['id']:
                _advance_turn(room_id)

            if not active_rooms[room_id]['players']:
                del active_rooms[room_id]
            break

@socketio.on('join_room')
def handle_join_room(data):
    room_id = data.get('room_id', '').strip().upper()
    player_name = data.get('player_name', 'Player').strip()

    if not room_id or not player_name:
        emit('error', {'message': 'Room ID and player name are required'})
        return

    if room_id not in active_rooms:
        active_rooms[room_id] = {
            'players': [],
            'game_state': get_initial_game_state()
        }
        create_room(room_id)

    room = active_rooms[room_id]
    players = room['players']

    if len(players) >= 4:
        emit('error', {'message': 'Room is full (max 4 players)'})
        return

    if room['game_state'].get('started') and not any(p['id'] == request.sid for p in players):
        emit('error', {'message': 'Game already in progress'})
        return

    player_id = str(uuid.uuid4())[:8]
    player = {
        'id': player_id,
        'sid': request.sid,
        'name': player_name,
        'score': 0,
        'group': None,
        'balls_potted': []
    }

    active_rooms[room_id]['players'].append(player)
    add_player_to_room(room_id, player)

    join_room(room_id)

    emit('room_joined', {
        'player_id': player_id,
        'room_id': room_id,
        'players': players,
        'game_state': room['game_state']
    })

    emit('player_joined', {
        'player': player,
        'players': active_rooms[room_id]['players']
    }, room=room_id, include_self=False)

    print(f"[JOIN] {player_name} joined room {room_id} ({len(active_rooms[room_id]['players'])}/4 players)")

    if len(active_rooms[room_id]['players']) >= 2 and not room['game_state'].get('started'):
        _start_game(room_id)

@socketio.on('cue_shot')
def handle_cue_shot(data):
    room_id = data.get('room_id')
    player_id = data.get('player_id')
    angle = data.get('angle', 0)
    power = data.get('power', 0.5)

    if room_id not in active_rooms:
        emit('error', {'message': 'Room not found'})
        return

    room = active_rooms[room_id]
    game_state = room['game_state']

    if game_state.get('current_player_id') != player_id:
        emit('error', {'message': 'Not your turn'})
        return

    if not game_state.get('started'):
        emit('error', {'message': 'Game has not started yet'})
        return

    emit('shot_taken', {
        'player_id': player_id,
        'angle': angle,
        'power': power,
        'cue_ball_pos': data.get('cue_ball_pos')
    }, room=room_id)

    print(f"[SHOT] Player {player_id} in room {room_id} shot at angle={angle:.2f}, power={power:.2f}")

@socketio.on('turn_result')
def handle_turn_result(data):
    room_id = data.get('room_id')
    player_id = data.get('player_id')

    if room_id not in active_rooms:
        return

    room = active_rooms[room_id]
    game_state = room['game_state']

    if game_state.get('current_player_id') != player_id:
        return

    balls_potted = data.get('balls_potted', [])
    cue_scratch = data.get('cue_scratch', False)
    hit_own_first = data.get('hit_own_first', True)
    rail_contacted = data.get('rail_contacted', False)
    ball_positions = data.get('ball_positions', {})
    eight_ball_potted = data.get('eight_ball_potted', False)

    players = room['players']
    current_player = next((p for p in players if p['id'] == player_id), None)
    if not current_player:
        return

    # Assign groups if first pot
    if balls_potted and not any(p.get('group') for p in players):
        first_ball = balls_potted[0]
        if 1 <= first_ball <= 7:
            current_player['group'] = 'solids'
            other = next((p for p in players if p['id'] != player_id), None)
            if other:
                other['group'] = 'stripes'
        elif 9 <= first_ball <= 15:
            current_player['group'] = 'stripes'
            other = next((p for p in players if p['id'] != player_id), None)
            if other:
                other['group'] = 'solids'

        game_state['groups_assigned'] = True
        emit('groups_assigned', {'players': players}, room=room_id)

    # Score own balls only
    for ball_num in balls_potted:
        if ball_num != 8:
            current_player['balls_potted'].append(ball_num)
            current_player['score'] += 1

    # Detect fouls
    foul = False
    foul_reason = ''

    if cue_scratch:
        foul = True
        foul_reason = 'Cue ball scratched!'
        game_state['ball_in_hand'] = True
    elif not hit_own_first and game_state.get('groups_assigned'):
        foul = True
        foul_reason = 'Must hit your own balls first!'
        game_state['ball_in_hand'] = True
    elif not rail_contacted and not balls_potted:
        foul = True
        foul_reason = 'Ball or rail must be contacted!'
        game_state['ball_in_hand'] = True

    # 8-ball win/loss
    winner = None
    game_over = False

    if eight_ball_potted:
        own_balls_all_in = _check_all_own_balls_potted(current_player, game_state)
        if foul or not own_balls_all_in:
            game_over = True
            winner = next((p for p in players if p['id'] != player_id), None)
            emit('game_over', {
                'winner': winner,
                'reason': f"{current_player['name']} illegally potted the 8-ball!"
            }, room=room_id)
        else:
            game_over = True
            winner = current_player
            emit('game_over', {
                'winner': winner,
                'reason': f"{current_player['name']} wins by legally potting the 8-ball!"
            }, room=room_id)

        if game_over:
            game_state['started'] = False
            game_state['winner_id'] = winner['id'] if winner else None
            save_match_history(room_id, players, winner)

    game_state['ball_positions'] = ball_positions

    # Key fix: turn never continues if foul
    own_balls_potted = _get_own_balls(balls_potted, current_player.get('group'))
    turn_continues = bool(own_balls_potted) and not foul and not game_over

    if not game_over:
        if foul:
            _advance_turn(room_id)   # foul → next player (ball_in_hand already set)
        elif not turn_continues:
            _advance_turn(room_id)
        # else: same player continues (only if legal pot and no foul)

    emit('turn_updated', {
        'player_id': player_id,
        'balls_potted': balls_potted,
        'foul': foul,
        'foul_reason': foul_reason,
        'ball_in_hand': game_state['ball_in_hand'],
        'turn_continues': turn_continues,
        'current_player_id': game_state['current_player_id'],
        'players': players,
        'ball_positions': ball_positions
    }, room=room_id)

    update_room_state(room_id, game_state, players)

@socketio.on('cue_ball_placed')
def handle_cue_ball_placed(data):
    room_id = data.get('room_id')
    position = data.get('position')

    if room_id not in active_rooms:
        return

    active_rooms[room_id]['game_state']['ball_in_hand'] = False
    active_rooms[room_id]['game_state']['cue_ball_pos'] = position

    emit('cue_ball_placed', {
        'position': position,
        'room_id': room_id
    }, room=room_id, include_self=False)

@socketio.on('restart_game')
def handle_restart_game(data):
    room_id = data.get('room_id')
    if room_id not in active_rooms:
        return

    active_rooms[room_id]['game_state'] = get_initial_game_state()

    for player in active_rooms[room_id]['players']:
        player['score'] = 0
        player['group'] = None
        player['balls_potted'] = []

    if len(active_rooms[room_id]['players']) >= 2:
        _start_game(room_id)
    else:
        emit('waiting_for_players', {}, room=room_id)

@socketio.on('chat_message')
def handle_chat(data):
    room_id = data.get('room_id')
    emit('chat_message', {
        'player_name': data.get('player_name'),
        'message': data.get('message')
    }, room=room_id)

# ─────────────────────────────────────────────
# Helper Functions
# ─────────────────────────────────────────────

def _start_game(room_id):
    room = active_rooms[room_id]
    players = room['players']

    balls = initialize_balls()
    game_state = room['game_state']
    game_state['started'] = True
    game_state['balls'] = balls
    game_state['current_player_id'] = players[0]['id']
    game_state['turn_number'] = 1
    game_state['ball_in_hand'] = False
    game_state['groups_assigned'] = False

    update_room_state(room_id, game_state, players)

    emit('game_started', {
        'game_state': game_state,
        'players': players,
        'current_player_id': game_state['current_player_id']
    }, room=room_id)

    print(f"[GAME] Started in room {room_id} with {len(players)} players")

def _advance_turn(room_id):
    if room_id not in active_rooms:
        return

    room = active_rooms[room_id]
    players = room['players']
    game_state = room['game_state']

    if not players:
        return

    current_id = game_state.get('current_player_id')
    current_index = next((i for i, p in enumerate(players) if p['id'] == current_id), 0)
    next_index = (current_index + 1) % len(players)
    next_player = players[next_index]

    game_state['current_player_id'] = next_player['id']
    game_state['turn_number'] = game_state.get('turn_number', 1) + 1

    emit('turn_changed', {
        'current_player_id': next_player['id'],
        'current_player_name': next_player['name'],
        'turn_number': game_state['turn_number'],
        'ball_in_hand': game_state['ball_in_hand']
    }, room=room_id)

def _check_all_own_balls_potted(player, game_state):
    group = player.get('group')
    if not group:
        return False

    potted = set(player.get('balls_potted', []))
    if group == 'solids':
        required = set(range(1, 8))
    else:
        required = set(range(9, 16))

    return required.issubset(potted)

def _get_own_balls(balls_potted, group):
    if not group or not balls_potted:
        return []
    if group == 'solids':
        return [b for b in balls_potted if 1 <= b <= 7]
    else:
        return [b for b in balls_potted if 9 <= b <= 15]

# ─────────────────────────────────────────────
# Entry Point
# ─────────────────────────────────────────────

if __name__ == '__main__':
    print("🎱 8-Ball Pool Server starting...")
    print("   Visit: http://localhost:5000")
    socketio.run(app, debug=True, host='0.0.0.0', port=5000)