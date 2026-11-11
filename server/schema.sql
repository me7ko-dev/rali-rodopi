-- Рали Родопи — онлайн база (Cloudflare D1).
-- Локално: npm run schema:local   Онлайн: npm run schema:remote
-- Само CREATE ... IF NOT EXISTS. Нови колони се добавят с ALTER TABLE ... ADD COLUMN в отделен файл, никога DROP.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                 -- както го е написал играчът
  name_key TEXT NOT NULL UNIQUE,      -- с малки букви (уникалност)
  pass TEXT NOT NULL,                 -- PBKDF2-SHA256 (base64)
  salt TEXT NOT NULL,
  created INTEGER NOT NULL,
  seen INTEGER NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,  -- точки от онлайн състезания (проверени)
  garage INTEGER NOT NULL DEFAULT 0,  -- точки за гаража: онлайн + сам с ботове
  races INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  look TEXT NOT NULL DEFAULT '',      -- избраната визия (JSON), само бои/номер/спойлер/следа
  imported INTEGER NOT NULL DEFAULT 0, -- взел ли е точките, изкарани преди профила
  ip TEXT NOT NULL DEFAULT ''          -- отпечатък (SHA-256 със сол) на адреса при регистрация — не истинският IP
);
CREATE INDEX IF NOT EXISTS users_ip ON users(ip);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,             -- SHA-256 на истинския ключ
  user INTEGER NOT NULL,
  created INTEGER NOT NULL,
  seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user);

-- лимити: най-много n пъти до until (регистрации от адрес, опити за вход, състезания сам)
CREATE TABLE IF NOT EXISTS limits (
  key TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  until INTEGER NOT NULL
);

-- всяко онлайн състезание на всеки човек (valid = 0: сървърът го е отхвърлил, не влиза в класациите)
CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user INTEGER NOT NULL,
  track TEXT NOT NULL,
  room TEXT NOT NULL,
  place INTEGER NOT NULL,
  cars INTEGER NOT NULL,
  humans INTEGER NOT NULL,
  laps INTEGER NOT NULL,
  time_ms INTEGER,                    -- NULL = не е завършил
  best_ms INTEGER,
  points INTEGER NOT NULL,
  valid INTEGER NOT NULL,
  why TEXT NOT NULL DEFAULT '',       -- защо е отхвърлен
  car TEXT NOT NULL,
  t INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS results_t ON results(t);
CREATE INDEX IF NOT EXISTS results_user ON results(user, t);

-- най-добра обиколка на човек по писта (само от проверени онлайн състезания)
CREATE TABLE IF NOT EXISTS laps (
  user INTEGER NOT NULL,
  track TEXT NOT NULL,
  best_ms INTEGER NOT NULL,
  car TEXT NOT NULL,
  t INTEGER NOT NULL,
  PRIMARY KEY (user, track)
);
CREATE INDEX IF NOT EXISTS laps_track ON laps(track, best_ms);
