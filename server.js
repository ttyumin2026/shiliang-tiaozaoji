// server.js — Express 服务器
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// 每月免费发帖额度
const MONTHLY_QUOTA = 2;
// 帖子有效期 30 天
const EXPIRE_DAYS = 30;

// 分类配置
const CATEGORIES = [
  { id: 'used_car', name: '二手车', icon: '🚗' },
  { id: 'used_house', name: '二手房', icon: '🏠' },
  { id: 'rent', name: '租房', icon: '🔑' },
  { id: 'shop', name: '商铺转让', icon: '🏪' },
  { id: 'idle', name: '闲置', icon: '📦' },
  { id: 'job', name: '招聘', icon: '💼' },
  { id: 'service', name: '本地服务', icon: '🛠️' },
  { id: 'pet', name: '宠物', icon: '🐾' }
];

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 图片上传目录
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 单张最大 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('只能上传图片'));
  }
});

// 获取客户端 IP（兼容反向代理）
function getClientIP(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

// ============ API ============

// 获取分类列表
app.get('/api/categories', (req, res) => {
  res.json({ code: 0, data: CATEGORIES });
});

// 获取帖子列表（分页、搜索、分类筛选）
app.get('/api/posts', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = 10;
  const offset = (page - 1) * pageSize;
  const keyword = req.query.keyword || '';
  const category = req.query.category || '';

  let where = 'WHERE status = 1';
  const params = [];
  if (category) { where += ' AND category = ?'; params.push(category); }
  if (keyword) { where += ' AND title LIKE ?'; params.push('%' + keyword + '%'); }

  const total = db.prepare(`SELECT COUNT(*) as count FROM posts ${where}`).get(...params).count;

  const list = db.prepare(
    `SELECT * FROM posts ${where} ORDER BY is_top DESC, create_time DESC LIMIT ? OFFSET ?`
  ).all(...params, pageSize, offset);

  // 解析 images JSON
  const formatted = list.map(p => ({
    ...p,
    images: JSON.parse(p.images || '[]').map(img => '/uploads/' + img),
    is_top: !!p.is_top,
    create_time: p.create_time,
    create_time_text: formatTime(p.create_time)
  }));

  res.json({
    code: 0,
    data: { list: formatted, total, page, pageSize, hasMore: offset + pageSize < total }
  });
});

// 获取帖子详情
app.get('/api/posts/:id', (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.json({ code: 1, msg: '帖子不存在' });

  res.json({
    code: 0,
    data: {
      ...post,
      images: JSON.parse(post.images || '[]').map(img => '/uploads/' + img),
      is_top: !!post.is_top,
      create_time_text: formatTime(post.create_time)
    }
  });
});

// 图片上传
app.post('/api/upload', upload.array('images', 9), (req, res) => {
  const files = (req.files || []).map(f => f.filename);
  res.json({ code: 0, data: files });
});

// 发布帖子
app.post('/api/posts', (req, res) => {
  const { title, category, content, images, contact, isTop } = req.body;
  const ip = getClientIP(req);

  // 参数校验
  if (!title || !title.trim()) return res.json({ code: 1, msg: '请输入标题' });
  if (title.length > 30) return res.json({ code: 1, msg: '标题不能超过30字' });
  if (!category) return res.json({ code: 1, msg: '请选择分类' });
  if (!content || !content.trim()) return res.json({ code: 1, msg: '请输入内容' });
  if (content.length > 500) return res.json({ code: 1, msg: '内容不能超过500字' });
  if (!contact || !contact.trim()) return res.json({ code: 1, msg: '请输入联系方式' });
  if (images && images.length > 9) return res.json({ code: 1, msg: '图片最多9张' });

  const cat = CATEGORIES.find(c => c.id === category);
  if (!cat) return res.json({ code: 1, msg: '分类无效' });

  // 额度校验：当月发帖数
  const now = Date.now();
  const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const startOfNextMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).getTime();

  const countResult = db.prepare(
    'SELECT COUNT(*) as count FROM posts WHERE ip = ? AND create_time >= ? AND create_time < ?'
  ).get(ip, startOfMonth, startOfNextMonth);

  if (countResult.count >= MONTHLY_QUOTA) {
    return res.json({
      code: 403,
      msg: '额度已用完，请购买加量包',
      quota: MONTHLY_QUOTA,
      used: countResult.count
    });
  }

  // 写入帖子
  const expireTime = now + EXPIRE_DAYS * 24 * 60 * 60 * 1000;
  const imageNames = (images || []).map(img => img.replace(/^.*[\\/]/, ''));

  const result = db.prepare(
    `INSERT INTO posts (title, category, category_name, content, images, contact, is_top, status, ip, create_time, expire_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
  ).run(title.trim(), category, cat.name, content.trim(), JSON.stringify(imageNames), contact.trim(), isTop ? 1 : 0, ip, now, expireTime);

  // 更新用户记录
  const existingUser = db.prepare('SELECT id FROM users WHERE ip = ?').get(ip);
  if (existingUser) {
    db.prepare('UPDATE users SET post_count = post_count + 1, last_post_time = ? WHERE ip = ?').run(now, ip);
  } else {
    db.prepare('INSERT INTO users (ip, post_count, last_post_time, create_time) VALUES (?, 1, ?, ?)').run(ip, now, now);
  }

  res.json({ code: 0, msg: '发布成功', postId: result.lastInsertRowid, used: countResult.count + 1, quota: MONTHLY_QUOTA });
});

// 手动触发下架（也可被定时器调用）
app.post('/api/auto-offshelf', (req, res) => {
  const now = Date.now();
  const result = db.prepare(
    'UPDATE posts SET status = 0, off_shelf_time = ?, off_shelf_reason = ? WHERE status = 1 AND expire_time < ?'
  ).run(now, 'expired', now);

  res.json({ code: 0, msg: '下架完成', count: result.changes });
});

// 时间格式化
function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;
  const minute = 60 * 1000, hour = 60 * minute, day = 24 * hour;

  if (diff < minute) return '刚刚';
  if (diff < hour) return Math.floor(diff / minute) + '分钟前';
  if (diff < day) return Math.floor(diff / hour) + '小时前';
  if (diff < 7 * day) return Math.floor(diff / day) + '天前';

  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const d = date.getDate().toString().padStart(2, '0');
  return m + '-' + d;
}

// 定时下架：每 10 分钟检查一次（无需外部 cron）
setInterval(() => {
  const now = Date.now();
  const result = db.prepare(
    'UPDATE posts SET status = 0, off_shelf_time = ?, off_shelf_reason = ? WHERE status = 1 AND expire_time < ?'
  ).run(now, 'expired', now);
  if (result.changes > 0) console.log(`[自动下架] 处理了 ${result.changes} 条到期帖子`);
}, 10 * 60 * 1000);

// 启动服务器
app.listen(PORT, () => {
  console.log(`本地生活网站已启动: http://localhost:${PORT}`);
});
