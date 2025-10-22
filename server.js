/**
 * youtube-batch-downloader - Express server
 * - POST /api/download  accepts { links: [ ... ] }
 * - writes downloaded files to ./downloads
 * - serves frontend from ./frontend and downloads at /downloads
 *
 * Requires yt-dlp installed and available on PATH.
 */

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 5000;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const FRONTEND_DIR = path.join(__dirname, 'frontend');

// ensure downloads directory exists
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(morgan('dev'));

// serve frontend static files
app.use('/', express.static(FRONTEND_DIR));

// serve downloads statically
app.use('/downloads', express.static(DOWNLOADS_DIR));

/**
 * runYtDlp(link) -> Promise resolving to result object
 */
function runYtDlp(link) {
  return new Promise((resolve) => {
    const jobId = uuidv4();
    // output template - prefix files with jobId so we can locate them
    const outTemplate = path.join(DOWNLOADS_DIR, `${jobId} - %(title)s.%(ext)s`);

    const args = [
      '--no-progress',
      '--no-warnings',
      '-o',
      outTemplate,
      link
    ];

    const child = spawn('yt-dlp', args);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });

    child.on('error', err => {
      // e.g., yt-dlp not found
      resolve({ ok: false, err: (err && err.message) || 'yt-dlp spawn error', stdout, stderr });
    });

    child.on('close', code => {
      let found = null;
      try {
        const files = fs.readdirSync(DOWNLOADS_DIR);
        const prefix = `${jobId} - `;
        const candidates = files.filter(f => f.startsWith(prefix) && !f.endsWith('.part'));
        if (candidates.length > 0) {
          // choose largest (most likely main video file)
          candidates.sort((a, b) => {
            const sa = fs.statSync(path.join(DOWNLOADS_DIR, a)).size;
            const sb = fs.statSync(path.join(DOWNLOADS_DIR, b)).size;
            return sb - sa;
          });
          found = candidates[0];
        }
      } catch (e) {
        // ignore
      }

      const ok = code === 0 && !!found;
      resolve({ ok, exitCode: code, filename: found ? `/downloads/${encodeURIComponent(found)}` : null, stdout, stderr });
    });
  });
}

/**
 * POST /api/download
 * Body: { links: [ "https://...", ... ] }
 *
 * Processes links sequentially and returns results array.
 */
app.post('/api/download', async (req, res) => {
  try {
    const links = Array.isArray(req.body.links) ? req.body.links.map(String).filter(Boolean) : [];
    if (links.length === 0) {
      return res.status(400).json({ message: 'Provide an array of youtube links in "links"' });
    }

    const MAX = 15;
    if (links.length > MAX) return res.status(400).json({ message: `Max ${MAX} links at once` });

    const results = [];
    for (const link of links) {
      if (!/youtu/i.test(link)) {
        results.push({ link, ok: false, message: 'Basic validation failed: not a YouTube link' });
        continue;
      }
      // mark started
      results.push({ link, status: 'started' });
      const r = await runYtDlp(link);
      if (r.ok) {
        results[results.length - 1] = { link, ok: true, file: r.filename };
      } else {
        results[results.length - 1] = { link, ok: false, error: r.stderr || r.stdout || `exitCode ${r.exitCode}` };
      }
    }

    return res.json({ results });
  } catch (err) {
    console.error('Error in /api/download:', err);
    return res.status(500).json({ message: err.message || 'Internal server error' });
  }
});

// ping
app.get('/api/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// SPA fallback: return index.html if exists
app.get('*', (req, res) => {
  const indexPath = path.join(FRONTEND_DIR, 'index.html');
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  return res.status(404).send('Not found');
});

app.listen(PORT, () => {
  console.log(`Server listening: http://localhost:${PORT}`);
  console.log(`Downloads directory: ${DOWNLOADS_DIR}`);
});
