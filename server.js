const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Database setup
const db = new sqlite3.Database('./equipment_borrowing.db', (err) => {
  if (err) {
    console.error('資料庫連線失敗:', err.message);
  } else {
    console.log('已連線至 SQLite 資料庫');
    initDatabase();
  }
});

// Initialize database tables
function initDatabase() {
  db.serialize(() => {
    // 設備列表
    db.run(`
      CREATE TABLE IF NOT EXISTS equipment (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT,
        status TEXT DEFAULT 'available',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 借用記錄
    db.run(`
      CREATE TABLE IF NOT EXISTS borrow_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        equipment_id INTEGER NOT NULL,
        borrower_name TEXT NOT NULL,
        department TEXT NOT NULL,
        phone TEXT NOT NULL,
        borrow_date DATETIME DEFAULT CURRENT_TIMESTAMP,
        return_date DATETIME,
        status TEXT DEFAULT 'borrowed',
        FOREIGN KEY (equipment_id) REFERENCES equipment(id)
      )
    `);

    // 初始化一些設備資料（如果表格是空的）
    db.get('SELECT COUNT(*) as count FROM equipment', (err, row) => {
      if (row.count === 0) {
        const devices = [
          { name: '投影機 A', category: '視訊設備' },
          { name: '投影機 B', category: '視訊設備' },
          { name: '筆記型電腦 #1', category: '電腦設備' },
          { name: '筆記型電腦 #2', category: '電腦設備' },
          { name: '會議電話', category: '通訊設備' },
          { name: '手提擴音器', category: '視訊設備' },
          { name: '攝影機', category: '視訊設備' },
          { name: '平板裝置 #1', category: '電腦設備' },
          { name: '平板裝置 #2', category: '電腦設備' },
          { name: '翻頁筆', category: '文具用品' },
        ];
        const stmt = db.prepare('INSERT INTO equipment (name, category) VALUES (?, ?)');
        devices.forEach(d => stmt.run(d.name, d.category));
        stmt.finalize();
        console.log('已初始化設備資料');
      }
    });
  });
}

// API Routes

// 取得所有設備及其借用狀態
app.get('/api/equipment', (req, res) => {
  const query = `
    SELECT e.*, 
           b.borrower_name, b.department, b.phone, b.borrow_date,
           CASE WHEN b.status = 'borrowed' THEN 1 ELSE 0 END as is_borrowed
    FROM equipment e
    LEFT JOIN (
      SELECT equipment_id, borrower_name, department, phone, borrow_date, status,
             ROW_NUMBER() OVER (PARTITION BY equipment_id ORDER BY borrow_date DESC) as rn
      FROM borrow_records
    ) b ON e.id = b.equipment_id AND b.rn = 1 AND b.status = 'borrowed'
    ORDER BY e.category, e.name
  `;
  
  db.all(query, [], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

// 借用設備
app.post('/api/borrow', (req, res) => {
  const { equipment_id, borrower_name, department, phone } = req.body;

  // 驗證必填欄位
  if (!equipment_id || !borrower_name || !department || !phone) {
    return res.status(400).json({ error: '請填寫所有必填欄位' });
  }

  // 檢查設備是否已被借用
  db.get(
    'SELECT * FROM borrow_records WHERE equipment_id = ? AND status = ?',
    [equipment_id, 'borrowed'],
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      if (row) {
        return res.status(409).json({ error: '此設備已被借用' });
      }

      // 新增借用記錄
      const stmt = db.prepare(`
        INSERT INTO borrow_records (equipment_id, borrower_name, department, phone, status)
        VALUES (?, ?, ?, ?, 'borrowed')
      `);
      stmt.run(equipment_id, borrower_name, department, phone, (err) => {
        if (err) {
          return res.status(500).json({ error: err.message });
        }
        res.json({ message: '借用成功', success: true });
      });
      stmt.finalize();
    }
  );
});

// 歸還設備
app.post('/api/return', (req, res) => {
  const { equipment_id } = req.body;

  if (!equipment_id) {
    return res.status(400).json({ error: '缺少設備 ID' });
  }

  db.run(
    `UPDATE borrow_records 
     SET status = 'returned', return_date = CURRENT_TIMESTAMP 
     WHERE equipment_id = ? AND status = 'borrowed'`,
    [equipment_id],
    function (err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: '找不到借用記錄或已完成歸還' });
      }
      res.json({ message: '歸還成功', success: true });
    }
  );
});

// 取得借用記錄
app.get('/api/records', (req, res) => {
  const query = `
    SELECT br.*, e.name as equipment_name, e.category
    FROM borrow_records br
    JOIN equipment e ON br.equipment_id = e.id
    ORDER BY br.borrow_date DESC
    LIMIT 100
  `;
  
  db.all(query, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// 刪除設備
app.delete('/api/equipment/:id', (req, res) => {
  const { id } = req.params;
  
  // 先檢查設備是否正在被借用
  db.get(
    'SELECT * FROM borrow_records WHERE equipment_id = ? AND status = ?',
    [id, 'borrowed'],
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      if (row) {
        return res.status(409).json({ error: '此設備正在借出中，無法刪除' });
      }
      
      db.run('DELETE FROM equipment WHERE id = ?', id, function (err) {
        if (err) {
          return res.status(500).json({ error: err.message });
        }
        if (this.changes === 0) {
          return res.status(404).json({ error: '找不到此設備' });
        }
        res.json({ message: '刪除成功', success: true });
      });
    }
  );
});

// 新增設備
app.post('/api/equipment', (req, res) => {
  const { name, category } = req.body;
  
  if (!name) {
    return res.status(400).json({ error: '設備名稱為必填欄位' });
  }

  db.run(
    'INSERT INTO equipment (name, category) VALUES (?, ?)',
    [name, category || '未分類'],
    function (err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ message: '新增成功', id: this.lastID, success: true });
    }
  );
});

// Start server
app.listen(PORT, () => {
  console.log(`儀器設備借用系統已啟動: http://localhost:${PORT}`);
});
