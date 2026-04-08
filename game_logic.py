"""
game_logic.py - 8-Ball Pool Game Rules and Ball Initialization
Handles server-side game logic separate from physics simulation
"""

import math
import random


# ─────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────

BALL_RADIUS = 14
TABLE_WIDTH = 900
TABLE_HEIGHT = 500
POCKET_RADIUS = 22

# Standard 8-ball rack positions (triangle formation)
# Cue ball starts at 1/4 from left, rack at 3/4 from left
RACK_X = TABLE_WIDTH * 0.65
RACK_Y = TABLE_HEIGHT * 0.5

# Ball colors for reference (used by frontend)
BALL_COLORS = {
    1:  {'color': '#F5C518', 'stripe': False},   # Yellow solid
    2:  {'color': '#1565C0', 'stripe': False},   # Blue solid
    3:  {'color': '#C62828', 'stripe': False},   # Red solid
    4:  {'color': '#6A1B9A', 'stripe': False},   # Purple solid
    5:  {'color': '#E65100', 'stripe': False},   # Orange solid
    6:  {'color': '#2E7D32', 'stripe': False},   # Green solid
    7:  {'color': '#4E342E', 'stripe': False},   # Maroon solid
    8:  {'color': '#212121', 'stripe': False},   # Black (8-ball)
    9:  {'color': '#F5C518', 'stripe': True},    # Yellow stripe
    10: {'color': '#1565C0', 'stripe': True},    # Blue stripe
    11: {'color': '#C62828', 'stripe': True},    # Red stripe
    12: {'color': '#6A1B9A', 'stripe': True},    # Purple stripe
    13: {'color': '#E65100', 'stripe': True},    # Orange stripe
    14: {'color': '#2E7D32', 'stripe': True},    # Green stripe
    15: {'color': '#4E342E', 'stripe': True},    # Maroon stripe
}

# Standard 8-ball rack order (5-row triangle)
# Row 1: 1 ball, Row 2: 2 balls, etc.
# Rules: 8-ball in center, corners must be one solid + one stripe
RACK_ORDER = [
    1,          # Tip (row 1)
    9, 2,       # Row 2
    8, 6, 11,   # Row 3 (8 in center of 3rd row = center of rack)
    12, 4, 13, 3,  # Row 4
    7, 15, 5, 14, 10  # Row 5 (base)
]


# ─────────────────────────────────────────────
# Ball Initialization
# ─────────────────────────────────────────────

def initialize_balls():
    """
    Create the standard 8-ball rack formation.
    Returns a list of ball objects with id, position, velocity, and potted status.
    """
    balls = []

    # Cue ball
    balls.append({
        'id': 0,
        'number': 0,
        'x': TABLE_WIDTH * 0.25,
        'y': TABLE_HEIGHT * 0.5,
        'vx': 0,
        'vy': 0,
        'potted': False,
        'color': '#FFFFFF',
        'stripe': False
    })

    # Rack the balls in triangle formation
    row = 0
    col = 0
    ball_index = 0
    spacing = BALL_RADIUS * 2.05  # Slight gap to avoid overlap issues

    for row_num in range(5):
        balls_in_row = row_num + 1
        # Center each row vertically around RACK_Y
        start_y = RACK_Y - (row_num * spacing / 2)

        for col_num in range(balls_in_row):
            if ball_index >= len(RACK_ORDER):
                break

            ball_num = RACK_ORDER[ball_index]
            ball_data = BALL_COLORS.get(ball_num, {'color': '#888888', 'stripe': False})

            x = RACK_X + row_num * spacing * math.cos(math.radians(30))
            y = start_y + col_num * spacing

            balls.append({
                'id': ball_num,
                'number': ball_num,
                'x': round(x, 2),
                'y': round(y, 2),
                'vx': 0,
                'vy': 0,
                'potted': False,
                'color': ball_data['color'],
                'stripe': ball_data['stripe']
            })
            ball_index += 1

    return balls


# ─────────────────────────────────────────────
# Game State
# ─────────────────────────────────────────────

def get_initial_game_state():
    """Return a fresh game state dictionary"""
    return {
        'started': False,
        'balls': [],
        'current_player_id': None,
        'turn_number': 0,
        'ball_in_hand': False,
        'groups_assigned': False,
        'winner_id': None,
        'ball_positions': {}
    }


# ─────────────────────────────────────────────
# Game Logic Helpers
# ─────────────────────────────────────────────

def assign_groups(first_ball_potted, players, current_player_id):
    """
    Assign solid/stripe groups based on first ball potted.
    Returns updated players list.
    """
    if 1 <= first_ball_potted <= 7:
        shooter_group = 'solids'
        other_group = 'stripes'
    elif 9 <= first_ball_potted <= 15:
        shooter_group = 'stripes'
        other_group = 'solids'
    else:
        return players  # 8-ball potted first is a foul, handled elsewhere

    for player in players:
        if player['id'] == current_player_id:
            player['group'] = shooter_group
        else:
            player['group'] = other_group

    return players


def validate_shot(game_state, player, first_ball_hit):
    """
    Validate whether the first ball hit is legal.
    Returns (is_valid, reason)
    """
    if not game_state.get('groups_assigned'):
        # Before groups assigned, any ball except 8-ball is valid first hit
        if first_ball_hit == 8:
            return False, 'Cannot hit 8-ball before clearing your group'
        return True, ''

    group = player.get('group')
    if not group:
        return True, ''

    # Check if the player has all their balls potted (can now hit 8-ball)
    own_balls = get_group_balls(group)
    potted = set(player.get('balls_potted', []))

    if own_balls.issubset(potted):
        # Player should be shooting for 8-ball
        if first_ball_hit != 8:
            return False, 'Must hit the 8-ball - all your balls are potted!'
        return True, ''

    # Must hit own group first
    if group == 'solids' and not (1 <= first_ball_hit <= 7):
        return False, 'Must hit your solid balls first!'
    if group == 'stripes' and not (9 <= first_ball_hit <= 15):
        return False, 'Must hit your stripe balls first!'

    return True, ''


def check_win_condition(player, balls_potted_this_turn, game_state):
    """
    Check if the player wins by potting the 8-ball.
    Returns (win, reason)
    """
    if 8 not in balls_potted_this_turn:
        return False, ''

    group = player.get('group')
    if not group:
        return False, 'Potted 8-ball before groups assigned - loss!'

    own_balls = get_group_balls(group)
    potted = set(player.get('balls_potted', []))
    all_potted = own_balls.issubset(potted)

    if all_potted:
        return True, f"{player['name']} wins!"
    else:
        return False, 'Potted 8-ball before clearing your group - loss!'


def get_group_balls(group):
    """Return set of ball numbers for a group"""
    if group == 'solids':
        return set(range(1, 8))   # 1-7
    elif group == 'stripes':
        return set(range(9, 16))  # 9-15
    return set()


def process_turn_result(event_data, players, game_state):
    """
    High-level turn result processing.
    Returns dict with foul, turn_continues, winner, updated state.
    """
    player_id = event_data.get('player_id')
    balls_potted = event_data.get('balls_potted', [])
    cue_scratch = event_data.get('cue_scratch', False)
    hit_own_first = event_data.get('hit_own_first', True)
    rail_contacted = event_data.get('rail_contacted', False)

    current_player = next((p for p in players if p['id'] == player_id), None)
    if not current_player:
        return {'error': 'Player not found'}

    foul = False
    foul_reason = ''

    if cue_scratch:
        foul = True
        foul_reason = 'Scratch! Cue ball potted.'
    elif not hit_own_first and game_state.get('groups_assigned'):
        foul = True
        foul_reason = 'Wrong ball hit first - foul!'
    elif not rail_contacted and not balls_potted:
        foul = True
        foul_reason = 'No rail contact - foul!'

    return {
        'foul': foul,
        'foul_reason': foul_reason,
        'balls_potted': balls_potted
    }
