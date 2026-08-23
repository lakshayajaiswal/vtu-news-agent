require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const client = new Anthropic();

// Database Setup
const db = new sqlite3.Database('news_agent.db', (err) => {
  if (err) console.error('Database connection error:', err);
  else console.log('✅ Database connected');
});

// Initialize database tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    send_time TEXT DEFAULT '07:00',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_owner BOOLEAN DEFAULT 0
  )`, (err) => {
    if (err) console.log('⚠️ Subscribers table exists');
    else console.log('✅ Subscribers table created');
  });

  db.run(`CREATE TABLE IF NOT EXISTS news (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT,
    category TEXT,
    source TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, (err) => {
    if (err) console.log('⚠️ News table exists');
    else console.log('✅ News table created');
  });

  db.run(`CREATE TABLE IF NOT EXISTS email_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'sent'
  )`, (err) => {
    if (err) console.log('⚠️ Email logs table exists');
    else console.log('✅ Email logs table created');
  });

  // Create owner account if doesn't exist
  const ownerEmail = process.env.OWNER_EMAIL;
  const ownerPassword = process.env.OWNER_PASSWORD;
  
  if (ownerEmail && ownerPassword) {
    db.get('SELECT * FROM subscribers WHERE email = ?', [ownerEmail], (err, row) => {
      if (err) {
        console.error('Error checking owner:', err);
        return;
      }
      if (!row) {
        db.run(
          'INSERT INTO subscribers (email, password, send_time, is_owner) VALUES (?, ?, ?, 1)',
          [ownerEmail, ownerPassword, process.env.DEFAULT_SEND_TIME || '07:00'],
          (err) => {
            if (err) console.error('Error creating owner:', err);
            else console.log('✅ Owner account created');
          }
        );
      }
    });
  }
});

// Email Configuration
const emailTransporter = nodemailer.createTransport({
  service: process.env.EMAIL_SERVICE || 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

// Test email connection
emailTransporter.verify((error, success) => {
  if (error) {
    console.log('❌ Email configuration error:', error.message);
  } else {
    console.log('✅ Email service ready');
  }
});

// News Sources
const newsSources = {
  vtu: {
    name: 'VTU Updates',
    emoji: '🎓',
    sources: [
      { url: 'https://vtu.ac.in/news', keyword: 'VTU' },
      { url: 'https://vtu.ac.in', keyword: 'announcements' }
    ]
  },
  ai: {
    name: 'AI & Generative AI',
    emoji: '🤖',
    sources: [
      { url: 'https://news.ycombinator.com/newest', keyword: 'AI' },
      { url: 'https://www.producthunt.com/', keyword: 'AI tools' }
    ]
  },
  dev: {
    name: 'Software Development',
    emoji: '💻',
    sources: [
      { url: 'https://github.com/trending', keyword: 'development' },
      { url: 'https://dev.to', keyword: 'programming' }
    ]
  },
  security: {
    name: 'Cybersecurity',
    emoji: '🔒',
    sources: [
      { url: 'https://krebsonsecurity.com/', keyword: 'security' },
      { url: 'https://thehackernews.com/', keyword: 'cyber' }
    ]
  }
};

// Fetch news
async function fetchAllNews() {
  const allNews = [];
  
  for (const [catKey, catData] of Object.entries(newsSources)) {
    for (const source of catData.sources) {
      try {
        const response = await axios.get(source.url, {
          timeout: 5000,
          headers: { 'User-Agent': 'Mozilla/5.0 News Aggregator' }
        });
        
        allNews.push({
          category: catData.name,
          emoji: catData.emoji,
          title: `${catData.name}: ${source.keyword}`,
          content: response.data.substring(0, 300),
          source: source.url,
          timestamp: new Date()
        });
      } catch (err) {
        console.log(`⚠️ Could not fetch from ${source.url}`);
      }
    }
  }
  
  return allNews.length > 0 ? allNews : generateSampleNews();
}

function generateSampleNews() {
  return [
    {
      category: 'VTU Updates',
      emoji: '🎓',
      title: '📚 VTU CSE 2025 Exam Schedule',
      content: 'Exam dates announced for May 1-15, 2025. Registration opens February 1st.',
      source: 'VTU Official',
      timestamp: new Date()
    },
    {
      category: 'AI & Generative AI',
      emoji: '🤖',
      title: '🤖 Claude Opus 4.6 Released',
      content: 'New Claude model with improved coding capabilities and faster inference.',
      source: 'Anthropic',
      timestamp: new Date()
    },
    {
      category: 'Software Development',
      emoji: '💻',
      title: '💻 React 19.2 Released',
      content: 'React 19.2 now available with Server Components and improved performance.',
      source: 'React',
      timestamp: new Date()
    },
    {
      category: 'Cybersecurity',
      emoji: '🔒',
      title: '⚠️ Critical Security Alert',
      content: 'Important: Update your systems if you run Linux servers. Patch available.',
      source: 'Krebson Security',
      timestamp: new Date()
    }
  ];
}

// Summarize with Claude
async function summarizeNews(newsItems) {
  if (newsItems.length === 0) return 'No news available today.';

  try {
    const newsContent = newsItems
      .map((item, i) => `${i + 1}. [${item.category}] ${item.title}\nContent: ${item.content}`)
      .join('\n\n');

    const message = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Create a professional yet casual daily news digest from these items. Organize by category. Mark urgent items with ⚠️. Keep it under 500 words and actionable.

${newsContent}`
      }]
    });

    return message.content[0].type === 'text' 
      ? message.content[0].text 
      : 'Unable to summarize news.';
  } catch (err) {
    console.error('Claude API Error:', err.message);
    return 'News digest temporarily unavailable.';
  }
}

// Format summary text lines into HTML (kept separate to avoid nested template literal issues)
function formatSummaryLines(summary) {
  const lines = summary.split('\n');
  let html = '';

  for (const line of lines) {
    if (line.includes('⚠️')) {
      html += '<div class="alert"><p>' + escapeHtml(line) + '</p></div>';
    } else if (line.startsWith('#')) {
      html += '<h2>' + escapeHtml(line.replace(/^#+\s*/, '')) + '</h2>';
    } else if (line.trim()) {
      html += '<p>' + escapeHtml(line) + '</p>';
    }
  }

  return html;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Send digest
async function sendDigestToSubscriber(email, sendTime) {
  try {
    const newsItems = await fetchAllNews();
    const summary = await summarizeNews(newsItems);

    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; background: #f5f5f5; padding: 20px; margin: 0; }
    .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; padding: 30px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .header { border-left: 4px solid #0066cc; padding-left: 20px; margin-bottom: 30px; }
    .header h1 { margin: 0; color: #333; font-size: 24px; }
    .header p { color: #666; margin: 8px 0 0 0; }
    .content { line-height: 1.8; color: #333; }
    .content h2 { color: #0066cc; font-size: 16px; border-bottom: 2px solid #e0e0e0; padding-bottom: 10px; margin-top: 20px; margin-bottom: 10px; }
    .alert { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 15px 0; border-radius: 6px; }
    .alert p { margin: 0; color: #856404; }
    .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #e0e0e0; text-align: center; color: #999; font-size: 12px; }
    .cta { text-align: center; margin: 25px 0; }
    .cta a { display: inline-block; background: #0066cc; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold; }
    .cta a:hover { background: #0052a3; }
    ul { margin: 10px 0; padding-left: 20px; }
    li { margin: 6px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📰 Your Daily News Brief</h1>
      <p>${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
    </div>
    
    <div class="content">
      ${formatSummaryLines(summary)}
    </div>

    <div class="cta">
      <a href="http://localhost:3000">📖 View Full News on Website</a>
    </div>

    <div class="footer">
      <p>You're receiving this because you subscribed to VTU News Agent</p>
      <p>Next digest: Tomorrow at ${sendTime}</p>
      <p><small>© 2025 VTU News Agent</small></p>
    </div>
  </div>
</body>
</html>
    `;

    await emailTransporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Your Daily News Brief',
      html: htmlContent
    });

    db.run('INSERT INTO email_logs (email, status) VALUES (?, ?)', [email, 'sent']);
    console.log(`✅ Email sent to ${email}`);
  } catch (err) {
    console.error(`❌ Error sending to ${email}:`, err.message);
    db.run('INSERT INTO email_logs (email, status) VALUES (?, ?)', [email, 'failed']);
  }
}

// Schedule digests
function scheduleAllDigests() {
  db.all('SELECT email, send_time FROM subscribers', (err, subscribers) => {
    if (err || !subscribers) {
      console.log('⚠️ No subscribers yet');
      return;
    }
    
    console.log(`📅 Scheduling ${subscribers.length} subscribers...`);
    
    subscribers.forEach(sub => {
      try {
        const [hour, minute] = sub.send_time.split(':');
        const cronExpr = `${minute} ${hour} * * *`;
        
        cron.schedule(cronExpr, () => {
          console.log(`📧 Sending digest to ${sub.email} at ${sub.send_time}`);
          sendDigestToSubscriber(sub.email, sub.send_time);
        });
      } catch (err) {
        console.error(`Error scheduling for ${sub.email}:`, err.message);
      }
    });
  });
}

// API: Login
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.json({ success: false, error: 'Email and password required' });
  }
  
  db.get(
    'SELECT * FROM subscribers WHERE email = ? AND password = ?',
    [email, password],
    (err, row) => {
      if (err) {
        return res.json({ success: false, error: 'Database error' });
      }
      if (row) {
        res.json({ 
          success: true, 
          token: Buffer.from(email).toString('base64'), 
          isOwner: row.is_owner 
        });
      } else {
        res.json({ success: false, error: 'Invalid credentials' });
      }
    }
  );
});

// API: Add subscriber
app.post('/api/subscribers', (req, res) => {
  const { email, password } = req.body;
  const sendTime = req.query.sendTime || process.env.DEFAULT_SEND_TIME || '07:00';
  
  if (!email || !password) {
    return res.json({ success: false, error: 'Email and password required' });
  }
  
  db.run(
    'INSERT INTO subscribers (email, password, send_time) VALUES (?, ?, ?)',
    [email, password, sendTime],
    (err) => {
      if (err) {
        res.json({ success: false, error: 'Email already exists' });
      } else {
        console.log(`✅ New subscriber: ${email}`);
        res.json({ success: true, message: 'Subscriber added' });
      }
    }
  );
});

// API: Get subscribers (owner only)
app.get('/api/subscribers', (req, res) => {
  const token = req.headers.authorization;
  if (!token) {
    return res.json({ error: 'Not authorized' });
  }
  
  const email = Buffer.from(token, 'base64').toString('utf8');
  
  db.get('SELECT is_owner FROM subscribers WHERE email = ?', [email], (err, user) => {
    if (user && user.is_owner) {
      db.all('SELECT email, send_time, created_at FROM subscribers WHERE is_owner = 0', (err, rows) => {
        res.json(rows || []);
      });
    } else {
      res.json({ error: 'Not authorized' });
    }
  });
});

// API: Delete subscriber
app.delete('/api/subscribers/:email', (req, res) => {
  const { email } = req.params;
  const token = req.headers.authorization;
  
  if (!token) return res.json({ error: 'Not authorized' });
  
  const ownerEmail = Buffer.from(token, 'base64').toString('utf8');
  
  db.get('SELECT is_owner FROM subscribers WHERE email = ?', [ownerEmail], (err, user) => {
    if (user && user.is_owner) {
      db.run('DELETE FROM subscribers WHERE email = ?', [email], () => {
        console.log(`✅ Subscriber removed: ${email}`);
        res.json({ success: true });
      });
    } else {
      res.json({ error: 'Not authorized' });
    }
  });
});

// API: Get news
app.get('/api/news', (req, res) => {
  db.all('SELECT * FROM news ORDER BY created_at DESC LIMIT 100', (err, rows) => {
    res.json(rows || []);
  });
});

// API: Send digest now (testing)
app.post('/api/send-digest', (req, res) => {
  db.all('SELECT email, send_time FROM subscribers', (err, subscribers) => {
    if (err || !subscribers) {
      return res.json({ success: false, error: 'No subscribers' });
    }
    
    subscribers.forEach(sub => {
      sendDigestToSubscriber(sub.email, sub.send_time);
    });
    
    res.json({ success: true, message: `Sent to ${subscribers.length} subscribers` });
  });
});

// API: Test email
app.post('/api/test-email', (req, res) => {
  const { email } = req.body;
  
  if (!email) {
    return res.json({ success: false, error: 'Email required' });
  }
  
  emailTransporter.sendMail({
    from: process.env.EMAIL_USER,
    to: email,
    subject: 'Test Email - VTU News Agent',
    html: '<h1>Test Successful!</h1><p>Your VTU News Agent is working correctly.</p>'
  }, (err, info) => {
    if (err) {
      console.error('Test email error:', err);
      res.json({ success: false, error: err.message });
    } else {
      console.log(`✅ Test email sent to ${email}`);
      res.json({ success: true, message: `Test email sent to ${email}` });
    }
  });
});

// Serve HTML
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>VTU News Agent</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Arial, sans-serif; background: #f5f5f5; }
    .navbar { background: #0066cc; color: white; padding: 20px; text-align: center; }
    .navbar h1 { font-size: 28px; margin: 0; }
    .container { max-width: 900px; margin: 0 auto; padding: 20px; }
    .login-box { background: white; padding: 40px; border-radius: 12px; max-width: 450px; margin: 50px auto; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    .login-box h2 { text-align: center; margin-bottom: 30px; color: #333; }
    .input { width: 100%; padding: 12px; margin: 15px 0; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; }
    .button { width: 100%; padding: 12px; background: #0066cc; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 14px; margin-top: 10px; }
    .button:hover { background: #0052a3; }
    .message { text-align: center; margin: 15px 0; font-size: 14px; }
    .success { color: green; }
    .error { color: red; }
    .hidden { display: none; }
    .dashboard { padding: 20px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin-bottom: 30px; }
    .stat-card { background: white; padding: 20px; border-radius: 8px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .stat-value { font-size: 28px; font-weight: bold; color: #0066cc; }
    .stat-label { font-size: 12px; color: #666; margin-top: 8px; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #e0e0e0; }
    th { background: #0066cc; color: white; font-weight: bold; }
    tr:hover { background: #f5f5f5; }
    .logout-btn { background: #dc3545; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-weight: bold; }
  </style>
</head>
<body>
  <div class="navbar">
    <h1>📰 VTU News Agent</h1>
    <p>Automated Daily News Digest</p>
  </div>
  
  <div class="container">
    <div id="loginBox" class="login-box">
      <h2>Login</h2>
      <input type="email" id="email" class="input" placeholder="Email" />
      <input type="password" id="password" class="input" placeholder="Password" />
      <button class="button" onclick="login()">Login</button>
      <div class="message" id="message"></div>
    </div>

    <div id="dashboardBox" class="hidden dashboard">
      <button class="logout-btn" onclick="logout()">Logout</button>
      <h2 style="margin: 20px 0;">Owner Dashboard</h2>
      
      <div class="stats">
        <div class="stat-card">
          <div class="stat-label">Active Subscribers</div>
          <div class="stat-value" id="subscriber-count">0</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Emails Sent Today</div>
          <div class="stat-value" id="email-count">0</div>
        </div>
      </div>

      <h3>Subscribers</h3>
      <table id="subscriberTable">
        <tr>
          <th>Email</th>
          <th>Send Time</th>
          <th>Joined</th>
          <th>Actions</th>
        </tr>
      </table>

      <div style="margin-top: 30px; background: white; padding: 20px; border-radius: 8px;">
        <h3>Add New Subscriber</h3>
        <input type="email" id="newEmail" class="input" placeholder="Email" />
        <input type="password" id="newPassword" class="input" placeholder="Password" />
        <input type="time" id="newTime" class="input" value="07:00" />
        <button class="button" onclick="addSubscriber()">Add Subscriber</button>
      </div>

      <div style="margin-top: 20px; background: white; padding: 20px; border-radius: 8px;">
        <h3>Quick Actions</h3>
        <button class="button" onclick="sendTestEmail()">Send Test Email</button>
        <button class="button" onclick="sendNow()">Send Digest Now</button>
      </div>
    </div>
  </div>

  <script>
    function login() {
      const email = document.getElementById('email').value;
      const password = document.getElementById('password').value;

      if (!email || !password) {
        showMessage('Please enter email and password', 'error');
        return;
      }

      fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          localStorage.setItem('token', data.token);
          localStorage.setItem('isOwner', data.isOwner);
          localStorage.setItem('email', email);
          document.getElementById('loginBox').classList.add('hidden');
          document.getElementById('dashboardBox').classList.remove('hidden');
          loadDashboard();
        } else {
          showMessage('Invalid credentials', 'error');
        }
      })
      .catch(err => showMessage('Error: ' + err.message, 'error'));
    }

    function logout() {
      localStorage.clear();
      location.reload();
    }

    function loadDashboard() {
      const token = localStorage.getItem('token');
      fetch('/api/subscribers', { headers: { 'Authorization': token } })
      .then(r => r.json())
      .then(data => {
        document.getElementById('subscriber-count').innerText = data.length;
        const table = document.getElementById('subscriberTable');
        table.innerHTML = '<tr><th>Email</th><th>Send Time</th><th>Joined</th><th>Actions</th></tr>';
        data.forEach(sub => {
          table.innerHTML += \`<tr>
            <td>\${sub.email}</td>
            <td>\${sub.send_time}</td>
            <td>\${new Date(sub.created_at).toLocaleDateString()}</td>
            <td><button style="background:#dc3545;color:white;border:none;padding:6px 12px;border-radius:4px;cursor:pointer;" onclick="deleteSubscriber('\${sub.email}')">Remove</button></td>
          </tr>\`;
        });
      });
    }

    function addSubscriber() {
      const email = document.getElementById('newEmail').value;
      const password = document.getElementById('newPassword').value;
      const time = document.getElementById('newTime').value;

      if (!email || !password) {
        showMessage('Please enter email and password', 'error');
        return;
      }

      fetch('/api/subscribers?sendTime=' + time, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          showMessage('Subscriber added!', 'success');
          document.getElementById('newEmail').value = '';
          document.getElementById('newPassword').value = '';
          loadDashboard();
        } else {
          showMessage(data.error, 'error');
        }
      });
    }

    function deleteSubscriber(email) {
      const token = localStorage.getItem('token');
      fetch('/api/subscribers/' + email, {
        method: 'DELETE',
        headers: { 'Authorization': token }
      })
      .then(r => r.json())
      .then(data => {
        showMessage('Subscriber removed', 'success');
        loadDashboard();
      });
    }

    function sendTestEmail() {
      const email = localStorage.getItem('email');
      fetch('/api/test-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      })
      .then(r => r.json())
      .then(data => showMessage(data.message || data.error, data.success ? 'success' : 'error'));
    }

    function sendNow() {
      fetch('/api/send-digest', { method: 'POST' })
      .then(r => r.json())
      .then(data => showMessage(data.message, data.success ? 'success' : 'error'));
    }

    function showMessage(msg, type) {
      const el = document.getElementById('message');
      el.innerText = msg;
      el.className = 'message ' + type;
    }

    // Check if already logged in
    if (localStorage.getItem('token')) {
      document.getElementById('loginBox').classList.add('hidden');
      document.getElementById('dashboardBox').classList.remove('hidden');
      loadDashboard();
    }
  </script>
</body>
</html>
  `);
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║       🚀 VTU NEWS AGENT - RUNNING SUCCESSFULLY       ║
╠═══════════════════════════════════════════════════════╣
║   🌐 Website: http://localhost:${PORT}                  ║
║   📧 Owner: ${process.env.OWNER_EMAIL || 'Not set'}             ║
║   ⏰ Default Time: ${process.env.DEFAULT_SEND_TIME || '07:00'}          ║
║   ✅ Agent Running 24/7                              ║
╚═══════════════════════════════════════════════════════╝
  `);
  
  // Schedule digests
  setTimeout(() => {
    scheduleAllDigests();
  }, 2000);
});
