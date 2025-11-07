/**
 * Minimal Internal Coding Agent (Node.js + Express)
 * - Accepts POST /tasks with JSON payload describing files to create/update
 * - Uses Octokit to create/update files in a target private repo
 * Security:
 * - Checks origin header against ALLOWED_ORIGINS
 * - Use HTTPS in production
 */

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const cors = require('cors');
const { Octokit } = require('@octokit/rest');

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const OWNER = process.env.TARGET_REPO_OWNER;
const REPO = process.env.TARGET_REPO_NAME;
const BRANCH = process.env.TARGET_BRANCH || 'main';
const TOKEN = process.env.AGENT_GITHUB_TOKEN;
const USER_AGENT = process.env.USER_AGENT || 'internal-coding-agent';

if (!OWNER || !REPO || !TOKEN) {
  console.error('Missing configuration. Set TARGET_REPO_OWNER, TARGET_REPO_NAME and AGENT_GITHUB_TOKEN.');
  process.exit(1);
}

const octokit = new Octokit({ auth: TOKEN, userAgent: USER_AGENT });

const app = express();
app.use(helmet());
app.use(bodyParser.json({ limit: '2mb' }));

// Basic CORS with allowed origins (for browser calls)
const corsOptions = {
  origin: function(origin, callback) {
    if (!origin) return callback(null, true); // allow server-to-server
    if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  }
};
app.use(cors(corsOptions));

// Simple origin check for server-to-server calls
function isOriginAllowed(req) {
  const origin = req.get('origin') || req.ip || '';
  if (ALLOWED_ORIGINS.length === 0) return true;
  return ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes(req.ip);
}

/**
 * Body schema:
 * {
 *   "files": [
 *     { "path": "src/newfile.js", "content": "base64 or plain text", "encoding": "utf-8" }
 *   ],
 *   "commitMessage": "Add generated files",
 *   "branch": "main" // optional
 * }
 */
app.post('/tasks', async (req, res) => {
  try {
    if (!isOriginAllowed(req)) {
      return res.status(403).json({ error: 'origin not allowed' });
    }

    const { files, commitMessage = 'Agent: generate files', branch = BRANCH } = req.body;
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'files array required' });
    }

    const results = [];
    for (const f of files) {
      if (!f.path || typeof f.content === 'undefined') {
        results.push({ path: f.path || null, status: 'skipped', reason: 'invalid file object' });
        continue;
      }

      // Get existing file to obtain sha (for updates)
      let sha;
      try {
        const getRes = await octokit.repos.getContent({
          owner: OWNER,
          repo: REPO,
          path: f.path,
          ref: branch
        });
        if (getRes && getRes.data && getRes.data.sha) {
          sha = getRes.data.sha;
        }
      } catch (err) {
        // file may not exist -> create
      }

      // Prepare content (expect plain text UTF-8 by default)
      const contentBuffer = Buffer.from(f.content, f.encoding === 'base64' ? 'base64' : 'utf8');
      const encoded = contentBuffer.toString('base64');

      try {
        const createRes = await octokit.repos.createOrUpdateFileContents({
          owner: OWNER,
          repo: REPO,
          path: f.path,
          message: commitMessage,
          content: encoded,
          branch,
          sha
        });
        results.push({ path: f.path, status: 'ok', commitSha: createRes.data.commit.sha });
      } catch (err) {
        results.push({ path: f.path, status: 'error', message: err.message });
      }
    }

    // Optionally: trigger workflow dispatch or other action (left as future extension)

    res.json({ ok: true, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'internal error' });
  }
});

app.get('/health', (req, res) => res.send({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Agent listening on port ${PORT}`);
});
