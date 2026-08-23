require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
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

// Email Configuration - using Resend (HTTP API) instead of SMTP
// Render's free tier blocks outbound SMTP ports, so Gmail SMTP cannot work there.
// Resend sends over HTTPS, which is never blocked.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'VTU News Agent <onboarding@resend.dev>';

async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not set in environment variables');
  }
  const response = await axios.post(
    'https://api.resend.com/emails',
    { from: RESEND_FROM, to: [to], subject, html },
    { headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' } }
  );
  return response.data;
}

if (RESEND_API_KEY) {
  console.log('✅ Email service ready (Resend)');
} else {
  console.log('❌ RESEND_API_KEY not set - emails will fail');
}

// News Sources
// Fetch news from real, structured APIs (not raw HTML scraping)
async function fetchAllNews() {
  const allNews = [];

  // --- AI & Dev & Security news via Hacker News API (free, no key needed) ---
  try {
    const topIds = await axios.get('https://hacker-news.firebaseio.com/v0/topstories.json', { timeout: 8000 });
    const ids = topIds.data.slice(0, 25); // check top 25 stories

    const stories = await Promise.all(
      ids.map(id =>
        axios.get(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { timeout: 8000 })
          .then(r => r.data)
          .catch(() => null)
      )
    );

    const keywordMap = [
      { cat: 'AI & Generative AI', emoji: '🤖', keywords: ['ai', 'llm', 'gpt', 'claude', 'openai', 'anthropic', 'machine learning', 'neural'] },
      { cat: 'Cybersecurity', emoji: '🔒', keywords: ['security', 'vulnerability', 'breach', 'exploit', 'cve', 'hack', 'malware', 'ransomware'] },
      { cat: 'Software Development', emoji: '💻', keywords: ['react', 'javascript', 'python', 'rust', 'programming', 'framework', 'github', 'code', 'developer', 'api'] }
    ];

    for (const story of stories) {
      if (!story || !story.title) continue;
      const titleLower = story.title.toLowerCase();

      for (const group of keywordMap) {
        if (group.keywords.some(kw => titleLower.includes(kw))) {
          allNews.push({
            category: group.cat,
            emoji: group.emoji,
            title: story.title,
            content: story.url ? `Read more: ${story.url}` : `${story.score || 0} points on Hacker News`,
            source: 'Hacker News',
            timestamp: new Date(story.time * 1000)
          });
          break; // only file each story under one category
        }
      }
    }
  } catch (err) {
    console.log('⚠️ Hacker News fetch failed:', err.message);
  }

  // --- Software Development: GitHub Trending via public search API (free, no key) ---
  try {
    const since = new Date();
    since.setDate(since.getDate() - 3);
    const dateStr = since.toISOString().split('T')[0];

    const ghResponse = await axios.get('https://api.github.com/search/repositories', {
      params: { q: `created:>${dateStr}`, sort: 'stars', order: 'desc', per_page: 5 },
      headers: { 'User-Agent': 'VTU-News-Agent', Accept: 'application/vnd.github+json' },
      timeout: 8000
    });

    for (const repo of ghResponse.data.items || []) {
      allNews.push({
        category: 'Software Development',
        emoji: '💻',
        title: `🔥 Trending: ${repo.full_name}`,
        content: repo.description || 'No description available',
        source: repo.html_url,
        timestamp: new Date(repo.created_at)
      });
    }
  } catch (err) {
    console.log('⚠️ GitHub fetch failed:', err.message);
  }

  // --- VTU / General news via NewsAPI (needs free key from newsapi.org) ---
  if (process.env.NEWSAPI_KEY) {
    try {
      const newsResponse = await axios.get('https://newsapi.org/v2/everything', {
        params: {
          q: 'VTU OR "Visvesvaraya Technological University" OR "Karnataka engineering exam"',
          sortBy: 'publishedAt',
          language: 'en',
          pageSize: 5,
          apiKey: process.env.NEWSAPI_KEY
        },
        timeout: 8000
      });

      for (const article of newsResponse.data.articles || []) {
        allNews.push({
          category: 'VTU Updates',
          emoji: '🎓',
          title: article.title,
          content: article.description || 'No description available',
          source: article.url,
          timestamp: new Date(article.publishedAt)
        });
      }
    } catch (err) {
      console.log('⚠️ NewsAPI fetch failed:', err.message);
    }
  }

  return allNews.length > 0 ? allNews : generateSampleNews();
}

function generateSampleNews() {
  return [
    {
      category: 'VTU Updates',
      emoji: '🎓',
      title: 'No VTU-specific news found today',
      content: 'Add a NEWSAPI_KEY environment variable (free from newsapi.org) to get real VTU/Karnataka education news.',
      source: 'System',
      timestamp: new Date()
    },
    {
      category: 'AI & Generative AI',
      emoji: '🤖',
      title: 'No matching AI news found today',
      content: 'Today\'s top Hacker News stories did not include AI-related keywords. This is normal on quiet news days.',
      source: 'System',
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
      model: 'claude-sonnet-5',
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
    console.error('Claude API Error:', err.status, err.message, err.error || '');
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
      <a href="${process.env.APP_URL || 'http://localhost:3000'}">📖 View Full News on Website</a>
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

    await sendEmail(email, 'Your Daily News Brief', htmlContent);

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

// API: Public Signup (anyone can create their own subscriber account)
app.post('/api/signup', (req, res) => {
  const { email, password, sendTime } = req.body;

  if (!email || !password) {
    return res.json({ success: false, error: 'Email and password required' });
  }
  if (password.length < 6) {
    return res.json({ success: false, error: 'Password must be at least 6 characters' });
  }

  const finalSendTime = sendTime || process.env.DEFAULT_SEND_TIME || '07:00';

  db.get('SELECT * FROM subscribers WHERE email = ?', [email], (err, existing) => {
    if (existing) {
      return res.json({ success: false, error: 'This email is already registered. Please login instead.' });
    }

    db.run(
      'INSERT INTO subscribers (email, password, send_time) VALUES (?, ?, ?)',
      [email, password, finalSendTime],
      (err) => {
        if (err) {
          return res.json({ success: false, error: 'Could not create account. Try again.' });
        }
        console.log(`✅ New self-signup: ${email}`);
        scheduleAllDigests(); // re-schedule to include the new subscriber
        res.json({ success: true, message: 'Account created! You can now login.' });
      }
    );
  });
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
// API: Get my own profile (subscriber self-service)
app.get('/api/my-profile', (req, res) => {
  const token = req.headers.authorization;
  if (!token) return res.json({ error: 'Not authorized' });
  const email = Buffer.from(token, 'base64').toString('utf8');

  db.get('SELECT email, send_time, is_owner, created_at FROM subscribers WHERE email = ?', [email], (err, row) => {
    if (row) res.json(row);
    else res.json({ error: 'Not found' });
  });
});

// API: Update my own send time (subscriber self-service)
app.put('/api/my-time', (req, res) => {
  const token = req.headers.authorization;
  if (!token) return res.json({ success: false, error: 'Not authorized' });
  const email = Buffer.from(token, 'base64').toString('utf8');
  const { sendTime } = req.body;

  const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
  if (!timeRegex.test(sendTime)) {
    return res.json({ success: false, error: 'Invalid time format' });
  }

  db.run('UPDATE subscribers SET send_time = ? WHERE email = ?', [sendTime, email], (err) => {
    if (err) return res.json({ success: false, error: 'Update failed' });
    scheduleAllDigests();
    res.json({ success: true, message: 'Time updated' });
  });
});

app.get('/api/news', (req, res) => {
  db.all('SELECT * FROM news ORDER BY created_at DESC LIMIT 100', (err, rows) => {
    res.json(rows || []);
  });
});

// API: Send digest now (testing)
// API: Hourly check endpoint - designed for external cron services (cron-job.org etc)
// to call this every hour. Only sends to subscribers whose send_time hour matches current hour.
app.get('/api/hourly-check', (req, res) => {
  const now = new Date();
  const currentHour = String(now.getHours()).padStart(2, '0');

  db.all('SELECT email, send_time FROM subscribers', (err, subscribers) => {
    if (err || !subscribers) {
      return res.json({ success: false, error: 'No subscribers' });
    }

    const dueNow = subscribers.filter(sub => sub.send_time.startsWith(currentHour));

    dueNow.forEach(sub => {
      sendDigestToSubscriber(sub.email, sub.send_time);
    });

    console.log(`⏰ Hourly check at ${currentHour}:00 - sent to ${dueNow.length} of ${subscribers.length} subscribers`);
    res.json({ success: true, hour: currentHour, sentTo: dueNow.length, totalSubscribers: subscribers.length });
  });
});

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
app.post('/api/test-email', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.json({ success: false, error: 'Email required' });
  }

  try {
    await sendEmail(email, 'Test Email - VTU News Agent', '<h1>Test Successful!</h1><p>Your VTU News Agent is working correctly.</p>');
    console.log(`✅ Test email sent to ${email}`);
    res.json({ success: true, message: `Test email sent to ${email}` });
  } catch (err) {
    console.error('Test email error:', err.response?.data || err.message);
    res.json({ success: false, error: err.response?.data?.message || err.message });
  }
});

// Serve HTML
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>VTU News Agent</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --owner-primary: #4f46e5;
      --owner-primary-dark: #4338ca;
      --owner-bg: #eef2ff;
      --sub-primary: #0d9488;
      --sub-primary-dark: #0f766e;
      --sub-bg: #f0fdfa;
      --danger: #dc2626;
      --text-dark: #1e293b;
      --text-muted: #64748b;
      --border: #e2e8f0;
      --surface: #ffffff;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Inter', Arial, sans-serif; background: #f8fafc; color: var(--text-dark); }
    .hidden { display: none !important; }

    /* ===== LOGIN / SIGNUP ===== */
    .auth-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #4f46e5 0%, #0d9488 100%); padding: 20px; }
    .auth-card { background: var(--surface); border-radius: 16px; padding: 40px; max-width: 420px; width: 100%; box-shadow: 0 20px 50px rgba(0,0,0,0.2); }
    .auth-logo { text-align: center; font-size: 40px; margin-bottom: 8px; }
    .auth-title { text-align: center; font-size: 22px; font-weight: 700; margin-bottom: 4px; }
    .auth-sub { text-align: center; font-size: 13px; color: var(--text-muted); margin-bottom: 28px; }
    .input { width: 100%; padding: 13px 14px; margin: 8px 0; border: 1.5px solid var(--border); border-radius: 10px; font-size: 14px; font-family: inherit; transition: border-color .15s; }
    .input:focus { outline: none; border-color: var(--owner-primary); }
    label.field-label { font-size: 12px; color: var(--text-muted); font-weight: 600; display: block; margin: 14px 0 2px; }
    .btn { width: 100%; padding: 13px; border: none; border-radius: 10px; cursor: pointer; font-weight: 600; font-size: 14px; font-family: inherit; margin-top: 14px; transition: transform .1s, opacity .15s; }
    .btn:hover { opacity: 0.92; }
    .btn:active { transform: scale(0.98); }
    .btn-primary { background: var(--owner-primary); color: white; }
    .message { text-align: center; margin: 14px 0 0; font-size: 13px; font-weight: 500; min-height: 18px; }
    .success { color: #059669; }
    .error { color: var(--danger); }
    .switch-line { text-align: center; font-size: 13px; margin-top: 20px; color: var(--text-muted); }
    .switch-line a { color: var(--owner-primary); font-weight: 600; text-decoration: none; }

    /* ===== SHARED PORTAL CHROME ===== */
    .topbar { padding: 16px 28px; display: flex; align-items: center; justify-content: space-between; color: white; }
    .topbar-title { font-size: 18px; font-weight: 700; display: flex; align-items: center; gap: 10px; }
    .topbar-badge { background: rgba(255,255,255,0.2); padding: 3px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; }
    .logout-btn { background: rgba(255,255,255,0.15); color: white; border: none; padding: 9px 18px; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 13px; }
    .logout-btn:hover { background: rgba(255,255,255,0.28); }
    .portal-body { max-width: 1000px; margin: 0 auto; padding: 28px 20px 60px; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 22px; margin-bottom: 20px; }
    .card h3 { font-size: 15px; font-weight: 700; margin-bottom: 16px; }
    .section-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); margin: 28px 0 12px; }
    .section-label:first-child { margin-top: 0; }

    /* ===== OWNER PORTAL ===== */
    #ownerTopbar { background: linear-gradient(135deg, var(--owner-primary), #6366f1); }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 14px; margin-bottom: 24px; }
    .stat-card { background: var(--owner-bg); border-radius: 12px; padding: 18px; text-align: center; }
    .stat-value { font-size: 26px; font-weight: 800; color: var(--owner-primary); }
    .stat-label { font-size: 11px; color: var(--text-muted); margin-top: 4px; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 12px; text-align: left; font-size: 13px; }
    th { background: var(--owner-bg); color: var(--owner-primary-dark); font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; }
    tr:not(:last-child) td { border-bottom: 1px solid var(--border); }
    .remove-btn { background: #fee2e2; color: var(--danger); border: none; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 12px; }
    .remove-btn:hover { background: #fecaca; }
    .btn-owner { background: var(--owner-primary); color: white; }
    .btn-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .setup-alert { background: #fffbeb; border: 1px solid #fde68a; border-radius: 10px; padding: 14px 16px; font-size: 12.5px; color: #92400e; margin-bottom: 20px; line-height: 1.6; }

    /* ===== SUBSCRIBER PORTAL ===== */
    #subTopbar { background: linear-gradient(135deg, var(--sub-primary), #14b8a6); }
    .profile-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 14px; }
    .profile-time { font-size: 22px; font-weight: 800; color: var(--sub-primary-dark); }
    .btn-sub { background: var(--sub-primary); color: white; width: auto; padding: 10px 20px; margin-top: 0; }
    .filter-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 18px; }
    .filter-chip { border: 1.5px solid var(--border); background: white; padding: 7px 14px; border-radius: 20px; cursor: pointer; font-size: 12.5px; font-weight: 600; color: var(--text-muted); }
    .filter-chip.active { background: var(--sub-primary); border-color: var(--sub-primary); color: white; }
    .news-item { padding: 16px 0; border-bottom: 1px solid var(--border); }
    .news-item:last-child { border-bottom: none; }
    .news-meta { font-size: 11px; color: var(--text-muted); font-weight: 600; margin-bottom: 6px; }
    .news-title { font-size: 14.5px; font-weight: 700; margin-bottom: 6px; }
    .news-content { font-size: 13px; color: var(--text-muted); line-height: 1.6; }
    .empty-state { text-align: center; padding: 40px 20px; color: var(--text-muted); font-size: 13px; }
  </style>
</head>
<body>

  <!-- ============ LOGIN / SIGNUP ============ -->
  <div id="authWrap" class="auth-wrap">
    <div class="auth-card">
      <div class="auth-logo">📰</div>
      <div class="auth-title" id="formTitle">Welcome back</div>
      <div class="auth-sub" id="formSub">Login to your VTU News Agent account</div>

      <label class="field-label">Email</label>
      <input type="email" id="email" class="input" placeholder="you@example.com" />

      <label class="field-label">Password</label>
      <input type="password" id="password" class="input" placeholder="••••••••" />

      <div id="signupExtra" class="hidden">
        <label class="field-label">Preferred daily news time</label>
        <input type="time" id="signupTime" class="input" value="07:00" />
      </div>

      <button class="btn btn-primary" id="primaryBtn" onclick="login()">Login</button>
      <div class="message" id="message"></div>

      <p class="switch-line">
        <span id="toggleText">Don't have an account?</span>
        <a href="#" onclick="toggleMode(); return false;" id="toggleLink">Sign up</a>
      </p>
    </div>
  </div>

  <!-- ============ OWNER PORTAL ============ -->
  <div id="ownerPortal" class="hidden">
    <div class="topbar" id="ownerTopbar">
      <div class="topbar-title">📰 VTU News Agent <span class="topbar-badge">OWNER</span></div>
      <button class="logout-btn" onclick="logout()">Logout</button>
    </div>
    <div class="portal-body">

      <div class="setup-alert">
        ⚡ <strong>Delivery tip:</strong> free hosting can go idle. For reliable on-time emails, add an external
        pinger (e.g. cron-job.org) hitting <code>/api/hourly-check</code> every hour, and set the <code>TZ</code>
        environment variable (e.g. <code>Asia/Kolkata</code>) on your host so send times match your local clock.
      </div>

      <div class="stats-grid">
        <div class="stat-card"><div class="stat-value" id="subscriber-count">0</div><div class="stat-label">Active Subscribers</div></div>
        <div class="stat-card"><div class="stat-value" id="email-count">—</div><div class="stat-label">Last Send Batch</div></div>
      </div>

      <div class="section-label">Subscribers</div>
      <div class="card">
        <table id="subscriberTable">
          <tr><th>Email</th><th>Send Time</th><th>Joined</th><th></th></tr>
        </table>
      </div>

      <div class="section-label">Add Subscriber Manually</div>
      <div class="card">
        <input type="email" id="newEmail" class="input" placeholder="Email" />
        <input type="password" id="newPassword" class="input" placeholder="Password" />
        <input type="time" id="newTime" class="input" value="07:00" />
        <button class="btn btn-owner" onclick="addSubscriber()">Add Subscriber</button>
      </div>

      <div class="section-label">Quick Actions</div>
      <div class="card">
        <div class="btn-grid">
          <button class="btn btn-owner" onclick="sendTestEmail()">Send Test Email to Me</button>
          <button class="btn btn-owner" onclick="sendNow()">Send Digest to Everyone Now</button>
        </div>
      </div>

      <div class="message" id="ownerMessage"></div>
    </div>
  </div>

  <!-- ============ SUBSCRIBER PORTAL ============ -->
  <div id="subPortal" class="hidden">
    <div class="topbar" id="subTopbar">
      <div class="topbar-title">📰 VTU News Agent <span class="topbar-badge">SUBSCRIBER</span></div>
      <button class="logout-btn" onclick="logout()">Logout</button>
    </div>
    <div class="portal-body">

      <div class="card">
        <div class="profile-row">
          <div>
            <div style="font-size:12px;color:var(--text-muted);font-weight:600;margin-bottom:4px;">YOUR DAILY DIGEST ARRIVES AT</div>
            <div class="profile-time" id="myTimeDisplay">--:--</div>
          </div>
          <div style="display:flex; gap:8px; align-items:center;">
            <input type="time" id="myTimeInput" class="input" style="width:auto;margin:0;" />
            <button class="btn btn-sub" onclick="updateMyTime()">Save</button>
          </div>
        </div>
      </div>

      <div class="section-label">Latest News</div>
      <div class="filter-row" id="filterRow">
        <div class="filter-chip active" data-cat="all" onclick="filterNews('all')">All</div>
        <div class="filter-chip" data-cat="VTU" onclick="filterNews('VTU')">🎓 VTU</div>
        <div class="filter-chip" data-cat="AI" onclick="filterNews('AI')">🤖 AI</div>
        <div class="filter-chip" data-cat="Development" onclick="filterNews('Development')">💻 Dev</div>
        <div class="filter-chip" data-cat="Security" onclick="filterNews('Security')">🔒 Security</div>
      </div>
      <div class="card" id="newsFeed">
        <div class="empty-state">Loading news…</div>
      </div>

      <div class="message" id="subMessage"></div>
    </div>
  </div>

  <script>
    let isSignupMode = false;
    let allNewsItems = [];

    function toggleMode() {
      isSignupMode = !isSignupMode;
      document.getElementById('formTitle').innerText = isSignupMode ? 'Create your account' : 'Welcome back';
      document.getElementById('formSub').innerText = isSignupMode ? 'Join and get daily news in your inbox' : 'Login to your VTU News Agent account';
      document.getElementById('primaryBtn').innerText = isSignupMode ? 'Create Account' : 'Login';
      document.getElementById('primaryBtn').onclick = isSignupMode ? signup : login;
      document.getElementById('signupExtra').classList.toggle('hidden', !isSignupMode);
      document.getElementById('toggleText').innerText = isSignupMode ? 'Already have an account?' : "Don't have an account?";
      document.getElementById('toggleLink').innerText = isSignupMode ? 'Login' : 'Sign up';
      document.getElementById('message').innerText = '';
    }

    function signup() {
      const email = document.getElementById('email').value;
      const password = document.getElementById('password').value;
      const sendTime = document.getElementById('signupTime').value;
      if (!email || !password) return showMessage('Please enter email and password', 'error');

      fetch('/api/signup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, sendTime })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          showMessage('Account created! Logging you in...', 'success');
          setTimeout(() => { isSignupMode = false; login(); }, 900);
        } else showMessage(data.error, 'error');
      })
      .catch(err => showMessage('Error: ' + err.message, 'error'));
    }

    function login() {
      const email = document.getElementById('email').value;
      const password = document.getElementById('password').value;
      if (!email || !password) return showMessage('Please enter email and password', 'error');

      fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          localStorage.setItem('token', data.token);
          localStorage.setItem('isOwner', data.isOwner ? '1' : '0');
          localStorage.setItem('email', email);
          enterPortal();
        } else showMessage('Invalid credentials', 'error');
      })
      .catch(err => showMessage('Error: ' + err.message, 'error'));
    }

    function logout() { localStorage.clear(); location.reload(); }

    function enterPortal() {
      document.getElementById('authWrap').classList.add('hidden');
      const isOwner = localStorage.getItem('isOwner') === '1';
      if (isOwner) {
        document.getElementById('ownerPortal').classList.remove('hidden');
        loadOwnerDashboard();
      } else {
        document.getElementById('subPortal').classList.remove('hidden');
        loadSubscriberPortal();
      }
    }

    /* ===== OWNER FUNCTIONS ===== */
    function loadOwnerDashboard() {
      const token = localStorage.getItem('token');
      fetch('/api/subscribers', { headers: { 'Authorization': token } })
      .then(r => r.json())
      .then(data => {
        document.getElementById('subscriber-count').innerText = data.length || 0;
        const table = document.getElementById('subscriberTable');
        table.innerHTML = '<tr><th>Email</th><th>Send Time</th><th>Joined</th><th></th></tr>';
        data.forEach(sub => {
          table.innerHTML += \`<tr>
            <td>\${sub.email}</td>
            <td>\${sub.send_time}</td>
            <td>\${new Date(sub.created_at).toLocaleDateString()}</td>
            <td><button class="remove-btn" onclick="deleteSubscriber('\${sub.email}')">Remove</button></td>
          </tr>\`;
        });
      });
    }

    function addSubscriber() {
      const email = document.getElementById('newEmail').value;
      const password = document.getElementById('newPassword').value;
      const time = document.getElementById('newTime').value;
      if (!email || !password) return showOwnerMessage('Please enter email and password', 'error');

      fetch('/api/subscribers?sendTime=' + time, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          showOwnerMessage('Subscriber added!', 'success');
          document.getElementById('newEmail').value = '';
          document.getElementById('newPassword').value = '';
          loadOwnerDashboard();
        } else showOwnerMessage(data.error, 'error');
      });
    }

    function deleteSubscriber(email) {
      const token = localStorage.getItem('token');
      fetch('/api/subscribers/' + email, { method: 'DELETE', headers: { 'Authorization': token } })
      .then(r => r.json())
      .then(() => { showOwnerMessage('Subscriber removed', 'success'); loadOwnerDashboard(); });
    }

    function sendTestEmail() {
      const email = localStorage.getItem('email');
      fetch('/api/test-email', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      })
      .then(r => r.json())
      .then(data => showOwnerMessage(data.message || data.error, data.success ? 'success' : 'error'));
    }

    function sendNow() {
      fetch('/api/send-digest', { method: 'POST' })
      .then(r => r.json())
      .then(data => {
        showOwnerMessage(data.message || data.error, data.success ? 'success' : 'error');
        if (data.success) document.getElementById('email-count').innerText = data.message.match(/\\d+/) || '0';
      });
    }

    function showOwnerMessage(msg, type) {
      const el = document.getElementById('ownerMessage');
      el.innerText = msg; el.className = 'message ' + type;
    }

    /* ===== SUBSCRIBER FUNCTIONS ===== */
    function loadSubscriberPortal() {
      const token = localStorage.getItem('token');
      fetch('/api/my-profile', { headers: { 'Authorization': token } })
      .then(r => r.json())
      .then(profile => {
        document.getElementById('myTimeDisplay').innerText = profile.send_time || '--:--';
        document.getElementById('myTimeInput').value = profile.send_time || '07:00';
      });
      loadNews();
    }

    function updateMyTime() {
      const token = localStorage.getItem('token');
      const sendTime = document.getElementById('myTimeInput').value;
      fetch('/api/my-time', {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': token },
        body: JSON.stringify({ sendTime })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          document.getElementById('myTimeDisplay').innerText = sendTime;
          showSubMessage('Delivery time updated!', 'success');
        } else showSubMessage(data.error, 'error');
      });
    }

    function loadNews() {
      fetch('/api/news')
      .then(r => r.json())
      .then(data => {
        allNewsItems = data || [];
        renderNews('all');
      });
    }

    function renderNews(category) {
      const feed = document.getElementById('newsFeed');
      const items = category === 'all' ? allNewsItems : allNewsItems.filter(n => (n.category || '').includes(category));

      if (!items.length) {
        feed.innerHTML = '<div class="empty-state">No news yet. Check back after the next digest is sent.</div>';
        return;
      }

      feed.innerHTML = items.map(item => \`
        <div class="news-item">
          <div class="news-meta">\${new Date(item.created_at).toLocaleDateString()} • \${item.category || 'General'}</div>
          <div class="news-title">\${item.title || ''}</div>
          <div class="news-content">\${(item.content || '').substring(0, 200)}</div>
        </div>
      \`).join('');
    }

    function filterNews(cat) {
      document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      document.querySelector(\`[data-cat="\${cat}"]\`).classList.add('active');
      renderNews(cat);
    }

    function showSubMessage(msg, type) {
      const el = document.getElementById('subMessage');
      el.innerText = msg; el.className = 'message ' + type;
    }

    function showMessage(msg, type) {
      const el = document.getElementById('message');
      el.innerText = msg; el.className = 'message ' + type;
    }

    // Resume session
    if (localStorage.getItem('token')) enterPortal();
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

  setTimeout(() => { scheduleAllDigests(); }, 2000);
});
