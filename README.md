# 🎱 8-Ball Pool — Multiplayer Web Game

A real-time multiplayer 8-ball pool game built with **Flask**, **Flask-SocketIO**, **MongoDB**, and **HTML5 Canvas**.

---

## 🚀 Quick Start

### 1. Install dependencies

```bash
pip install flask flask-socketio pymongo eventlet
```

### 2. Start MongoDB (optional — game runs without it)

```bash
# macOS
brew services start mongodb-community

# Linux
sudo systemctl start mongod

# Windows
net start MongoDB
```

> The game works **without MongoDB** (in-memory only). MongoDB adds match history persistence.

### 3. Run the server

```bash
python app.py
```

### 4. Open your browser

```
http://localhost:5000
```

---

## 🎮 How to Play

1. **Enter your name** and a **Room ID** (e.g., `POOL01`)
2. Share the Room ID with friends (up to **4 players** per room)
3. Game starts automatically when **2+ players** join
4. **Click and drag** from the cue ball to aim — drag further for more power
5. **Release** to shoot

### Rules (Standard 8-Ball)
- First player to pot a ball is assigned **solids (1–7)** or **stripes (9–15)**
- You must pot all your balls before going for the **8-ball**
- Potting the 8-ball legally = **WIN**
- Potting the 8-ball early or scratching on the 8-ball = **LOSS**
- **Fouls**: scratch, hitting wrong group first, no rail contact = opponent gets ball-in-hand

---

## 📁 Project Structure

```
pool_game/
├── app.py              # Flask server + Socket.IO events
├── db.py               # MongoDB connection & operations
├── game_logic.py       # 8-ball rules, ball initialization
├── requirements.txt    # Python dependencies
├── templates/
│   ├── index.html      # Lobby page
│   └── game.html       # Game page
└── static/
    ├── css/style.css   # Full UI styling
    └── js/game.js      # Canvas engine + physics + networking
```

---

## 🔧 Configuration

| Setting | Default | How to change |
|---------|---------|---------------|
| MongoDB URI | `mongodb://localhost:27017/` | Set `MONGO_URI` env var |
| Server port | `5000` | Edit `app.py` last line |
| Max players | 4 | Edit `app.py` join logic |
| Friction | 0.986 | Edit `game.js` FRICTION constant |

---

## 🌐 Multiplayer Architecture

```
Player A ──── Socket.IO ────┐
Player B ──── Socket.IO ────┤── Flask Server ── MongoDB
Player C ──── Socket.IO ────┘
```

- **Server** authorizes turns and validates game rules
- **Clients** run physics simulation locally (lock-step on shot params)
- **Shot sync**: angle + power broadcast → all clients simulate identically
- **Turn results** reported by shooting client → server validates → broadcasts state

---

## 📝 Socket Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `join_room` | Client→Server | Join/create a room |
| `room_joined` | Server→Client | Confirm join + current state |
| `player_joined` | Server→All | New player notification |
| `game_started` | Server→All | Game begins with ball positions |
| `cue_shot` | Client→Server | Shot parameters |
| `shot_taken` | Server→All | Mirror shot to other clients |
| `turn_result` | Client→Server | Physics result report |
| `turn_updated` | Server→All | Turn outcome + next player |
| `game_over` | Server→All | Winner announcement |
| `restart_game` | Client→Server | Request rematch |
| `chat_message` | Both | In-game chat |
# 8-ballpool
