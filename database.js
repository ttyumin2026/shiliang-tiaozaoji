// 数据库初始化（SQLite 文件型数据库，无需安装数据库服务器）
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'local-life.db'));

// 开启 WAL 模式提升并发性能
db.pragma('journal_mode = WAL');

// 创建表
db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    category_name TEXT NOT NULL,
    content TEXT NOT NULL,
    images TEXT DEFAULT '[]',
    contact TEXT NOT NULL,
    is_top INTEGER DEFAULT 0,
    status INTEGER DEFAULT 1,
    ip TEXT,
    create_time INTEGER NOT NULL,
    expire_time INTEGER NOT NULL,
    off_shelf_time INTEGER,
    off_shelf_reason TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT UNIQUE NOT NULL,
    post_count INTEGER DEFAULT 0,
    last_post_time INTEGER,
    create_time INTEGER NOT NULL
  );

  -- 加速查询的索引
  CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
  CREATE INDEX IF NOT EXISTS idx_posts_category ON posts(category);
  CREATE INDEX IF NOT EXISTS idx_posts_create_time ON posts(create_time DESC);
  CREATE INDEX IF NOT EXISTS idx_posts_ip ON posts(ip);
`);

module.exports = db;
