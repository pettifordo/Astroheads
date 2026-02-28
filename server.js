const express = require('express');
const path    = require('path');
const fs      = require('fs');
const app     = express();
const PORT    = process.env.PORT || 3001;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0 }));

// ── High scores (in-memory + file persistence) ────────────────────────────────
const SCORES_FILE = path.join(__dirname, 'scores.json');
let highScores = [];
try {
  if (fs.existsSync(SCORES_FILE))
    highScores = JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8'));
} catch(e) { highScores = []; }

function saveScores() {
  try { fs.writeFileSync(SCORES_FILE, JSON.stringify(highScores)); } catch(e) {}
}

app.get('/api/scores', (req, res) => res.json(highScores));

app.post('/api/scores', (req, res) => {
  const { name, score, round } = req.body;
  if (!name || typeof score !== 'number') return res.status(400).json({ error: 'Invalid' });
  const initials = String(name).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3).padEnd(3, 'A');
  highScores.push({ name: initials, score: Math.floor(score), round: round || 1 });
  highScores.sort((a, b) => b.score - a.score);
  highScores = highScores.slice(0, 10);
  saveScores();
  res.json(highScores);
});

app.listen(PORT, () => console.log(`Astroheads running at http://localhost:${PORT}`));
