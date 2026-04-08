"""
db.py - MongoDB connection and database operations
Handles persistence for rooms, players, and match history
"""

from pymongo import MongoClient
from datetime import datetime
import os

# ─────────────────────────────────────────────
# MongoDB Connection
# ─────────────────────────────────────────────

MONGO_URI = os.environ.get('MONGO_URI', 'mongodb+srv://vgugan16:gugan2004@cluster0.qyh1fuo.mongodb.net/dL?retryWrites=true&w=majority&appName=Cluster0')
DB_NAME = 'pool_game'

try:
    client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=3000)
    client.server_info()  # Test connection
    db = client[DB_NAME]
    rooms_col = db['rooms']
    history_col = db['match_history']
    print("[DB] MongoDB connected successfully")
except Exception as e:
    print(f"[DB] MongoDB connection failed: {e}")
    print("[DB] Running without persistence (in-memory only)")
    db = None
    rooms_col = None
    history_col = None


# ─────────────────────────────────────────────
# Room Operations
# ─────────────────────────────────────────────

def create_room(room_id):
    """Create a new room document in MongoDB"""
    if rooms_col is None:
        return
    try:
        rooms_col.update_one(
            {'room_id': room_id},
            {'$setOnInsert': {
                'room_id': room_id,
                'players': [],
                'game_state': {},
                'created_at': datetime.utcnow()
            }},
            upsert=True
        )
    except Exception as e:
        print(f"[DB] create_room error: {e}")


def get_room(room_id):
    """Retrieve room document from MongoDB"""
    if rooms_col is None:
        return None
    try:
        room = rooms_col.find_one({'room_id': room_id}, {'_id': 0})
        return room
    except Exception as e:
        print(f"[DB] get_room error: {e}")
        return None


def update_room_state(room_id, game_state, players):
    """Update game state and player list in MongoDB"""
    if rooms_col is None:
        return
    try:
        # Convert game_state balls to serializable format if needed
        serializable_state = _make_serializable(game_state)
        serializable_players = _make_serializable(players)

        rooms_col.update_one(
            {'room_id': room_id},
            {'$set': {
                'game_state': serializable_state,
                'players': serializable_players,
                'updated_at': datetime.utcnow()
            }}
        )
    except Exception as e:
        print(f"[DB] update_room_state error: {e}")


def add_player_to_room(room_id, player):
    """Add a player to the room's player array"""
    if rooms_col is None:
        return
    try:
        # Store a DB-safe version (no sid for security)
        db_player = {
            'id': player['id'],
            'name': player['name'],
            'score': player.get('score', 0),
            'group': player.get('group'),
            'balls_potted': player.get('balls_potted', [])
        }
        rooms_col.update_one(
            {'room_id': room_id},
            {'$push': {'players': db_player}}
        )
    except Exception as e:
        print(f"[DB] add_player_to_room error: {e}")


def remove_player_from_room(room_id, player_id):
    """Remove a player from the room"""
    if rooms_col is None:
        return
    try:
        rooms_col.update_one(
            {'room_id': room_id},
            {'$pull': {'players': {'id': player_id}}}
        )
    except Exception as e:
        print(f"[DB] remove_player_from_room error: {e}")


# ─────────────────────────────────────────────
# Match History
# ─────────────────────────────────────────────

def save_match_history(room_id, players, winner):
    """Save completed match to history collection"""
    if history_col is None:
        return
    try:
        record = {
            'room_id': room_id,
            'played_at': datetime.utcnow(),
            'winner_id': winner['id'] if winner else None,
            'winner_name': winner['name'] if winner else 'Draw',
            'players': [
                {
                    'id': p['id'],
                    'name': p['name'],
                    'score': p.get('score', 0),
                    'group': p.get('group'),
                    'balls_potted': p.get('balls_potted', [])
                }
                for p in players
            ]
        }
        history_col.insert_one(record)
    except Exception as e:
        print(f"[DB] save_match_history error: {e}")


def get_match_history(limit=10):
    """Retrieve recent match history"""
    if history_col is None:
        return []
    try:
        records = list(
            history_col.find({}, {'_id': 0})
            .sort('played_at', -1)
            .limit(limit)
        )
        # Convert datetime to string for JSON serialization
        for r in records:
            if 'played_at' in r:
                r['played_at'] = r['played_at'].isoformat()
        return records
    except Exception as e:
        print(f"[DB] get_match_history error: {e}")
        return []


# ─────────────────────────────────────────────
# Utility
# ─────────────────────────────────────────────

def _make_serializable(obj):
    """Recursively convert non-serializable types for MongoDB storage"""
    if isinstance(obj, dict):
        return {k: _make_serializable(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [_make_serializable(v) for v in obj]
    elif isinstance(obj, set):
        return list(obj)
    elif hasattr(obj, '__dict__'):
        return _make_serializable(obj.__dict__)
    return obj
