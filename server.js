import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ESM-safe __dirname resolution for serving index.html
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL;                  // e.g., https://apisalesdemo2.successfactors.eu
const SF_BEARER_TOKEN = process.env.SF_BEARER_TOKEN;    // short-lived token from your SAML flow

if (!BASE_URL) {
  console.error('Missing BASE_URL in .env');
  process.exit(1);
}
if (!SF_BEARER_TOKEN) {
  console.warn('Warning: SF_BEARER_TOKEN not set. /api/user will fail until provided.');
}

/**
 * GET /api/user?username=dshields_svc
 * Uses OData v2 with $format=json to avoid Atom XML.
 * Select only fields you care about to keep payload lean.
 */
app.get('/api/user', async (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'username is required' });

  try {
    const url = `${BASE_URL}/odata/v2/User`;
    const safeUsername = String(username).replace(/'/g, "''");
    const params = {
      $format: 'json',
      $filter: `username eq '${safeUsername}'`,
      $select: [
        'userId','username','displayName','defaultFullName','email','status',
        'division','department','location','timeZone','defaultLocale',
        'lastModifiedDateTime','lastModifiedWithTZ','assignmentUUID'
      ].join(',')
    };
    if (process.env.COMPANY_ID) params.company = process.env.COMPANY_ID;

    const resp = await axios.get(url, {
      params,
      headers: {
        Authorization: `Bearer ${SF_BEARER_TOKEN}`,
        Accept: 'application/json',
        ...(process.env.COMPANY_ID ? { 'Company-Id': process.env.COMPANY_ID } : {})
      },
      validateStatus: () => true,
      timeout: 30000
    });

    const ctype = String(resp.headers['content-type'] || '');
    if (!ctype.includes('application/json')) {
      return res.status(resp.status || 502).json({
        error: 'SuccessFactors returned non-JSON (likely token expired or wrong headers)',
        status: resp.status,
        contentType: ctype,
        bodyPreview: typeof resp.data === 'string' ? resp.data.slice(0, 500) : '[non-string]'
      });
    }

    if (resp.status < 200 || resp.status >= 300) {
      return res.status(resp.status).json({
        error: 'SuccessFactors error',
        status: resp.status,
        details: resp.data
      });
    }

    const results = resp.data?.d?.results ?? [];
    if (!results.length) return res.json({ found: false, user: null });

    const u = results[0];
    const user = {
      userId: u.userId,
      username: u.username,
      displayName: u.displayName || u.defaultFullName,
      email: u.email,
      status: u.status,
      division: u.division,
      department: u.department,
      location: u.location,
      timeZone: u.timeZone,
      defaultLocale: u.defaultLocale,
      assignmentUUID: u.assignmentUUID,
      lastModifiedDateTime: u.lastModifiedDateTime,
      lastModifiedWithTZ: u.lastModifiedWithTZ
    };
    return res.json({ found: true, user });
  } catch (err) {
    return res.status(500).json({
      error: 'Failed to query SuccessFactors',
      details: err?.message || String(err)
    });
  }
});

// Simple health check
app.get('/health', (req, res) => res.json({ ok: true }));

// Serve index.html at root for same-origin frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
