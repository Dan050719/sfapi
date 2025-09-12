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

// Retrieve custom object cust_Score by username (externalCode)
app.get('/api/score', async (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'username is required' });

  try {
    // Resolve the likely externalCode candidates: username and, if possible, userId
    const safeUsername = String(username).replace(/'/g, "''");
    let candidates = [safeUsername];
    try {
      const uUrl = `${BASE_URL}/odata/v2/User`;
      const uParams = {
        $format: 'json',
        $select: 'userId,username',
        $filter: `username eq '${safeUsername}'`
      };
      if (process.env.COMPANY_ID) uParams.company = process.env.COMPANY_ID;
      const uResp = await axios.get(uUrl, {
        params: uParams,
        headers: {
          Authorization: `Bearer ${SF_BEARER_TOKEN}`,
          Accept: 'application/json',
          ...(process.env.COMPANY_ID ? { 'Company-Id': process.env.COMPANY_ID } : {})
        },
        validateStatus: () => true,
        timeout: 10000
      });
      const uCType = String(uResp.headers['content-type'] || '');
      if (uCType.includes('application/json') && uResp.status >= 200 && uResp.status < 300) {
        const list = uResp.data?.d?.results ?? [];
        if (list.length) {
          const uid = String(list[0].userId || '').replace(/'/g, "''");
          if (uid && !candidates.includes(uid)) candidates.unshift(uid);
        }
      }
    } catch (_) {
      // If lookup fails, continue with username only
    }

    // Build OR filter across candidates
    const orFilter = candidates.map(v => `externalCode eq '${v}'`).join(' or ');
    const url = `${BASE_URL}/odata/v2/cust_Score`;
    const params = {
      $format: 'json',
      $filter: candidates.length > 1 ? `(${orFilter})` : orFilter,
      $select: [
        'externalCode','cust_Score','externalName','mdfSystemRecordStatus',
        'createdBy','createdDateTime','lastModifiedBy','lastModifiedDateTime'
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
      timeout: 15000
    });

    const ctype = String(resp.headers['content-type'] || '');
    if (!ctype.includes('application/json')) {
      return res.status(resp.status || 502).json({
        error: 'SuccessFactors returned non-JSON',
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
    if (!results.length) return res.json({ found: false, score: null });

    const s = results[0];
    const score = {
      externalCode: s.externalCode,
      score: s.cust_Score,
      externalName: s.externalName,
      mdfSystemRecordStatus: s.mdfSystemRecordStatus,
      createdBy: s.createdBy,
      createdDateTime: s.createdDateTime,
      lastModifiedBy: s.lastModifiedBy,
      lastModifiedDateTime: s.lastModifiedDateTime
    };
    return res.json({ found: true, score });
  } catch (err) {
    return res.status(500).json({
      error: 'Failed to query SuccessFactors (cust_Score)',
      details: err?.message || String(err)
    });
  }
});

// Update fields on custom object cust_Score by username (externalCode)
app.put('/api/score', async (req, res) => {
  try {
    const { username, updates } = req.body || {};
    if (!username) return res.status(400).json({ error: 'username is required' });
    if (!updates || typeof updates !== 'object') return res.status(400).json({ error: 'updates object is required' });

    // Allow-list fields for safety
    const allowed = new Set(['cust_Score', 'externalName', 'mdfSystemRecordStatus']);
    const body = {};
    for (const [k, v] of Object.entries(updates)) {
      if (allowed.has(k)) body[k] = v;
    }
    if (Object.keys(body).length === 0) {
      return res.status(400).json({ error: 'no allowed fields in updates' });
    }

    // Resolve the actual externalCode by looking up existing score by either userId or username
    let resolvedCode = null;
    try {
      const safeUsername = String(username).replace(/'/g, "''");
      // Try to fetch userId from User entity
      let candidates = [safeUsername];
      const uUrl = `${BASE_URL}/odata/v2/User`;
      const uParams = {
        $format: 'json',
        $select: 'userId,username',
        $filter: `username eq '${safeUsername}'`
      };
      if (process.env.COMPANY_ID) uParams.company = process.env.COMPANY_ID;
      const uResp = await axios.get(uUrl, {
        params: uParams,
        headers: {
          Authorization: `Bearer ${SF_BEARER_TOKEN}`,
          Accept: 'application/json',
          ...(process.env.COMPANY_ID ? { 'Company-Id': process.env.COMPANY_ID } : {})
        },
        validateStatus: () => true,
        timeout: 10000
      });
      const uCType = String(uResp.headers['content-type'] || '');
      if (uCType.includes('application/json') && uResp.status >= 200 && uResp.status < 300) {
        const list = uResp.data?.d?.results ?? [];
        if (list.length) {
          const uid = String(list[0].userId || '').replace(/'/g, "''");
          if (uid && !candidates.includes(uid)) candidates.unshift(uid);
        }
      }

      // Query score with OR of candidates to find the existing record's key
      const orFilter = candidates.map(v => `externalCode eq '${v}'`).join(' or ');
      const sUrl = `${BASE_URL}/odata/v2/cust_Score`;
      const sParams = {
        $format: 'json',
        $select: 'externalCode',
        $filter: candidates.length > 1 ? `(${orFilter})` : orFilter
      };
      if (process.env.COMPANY_ID) sParams.company = process.env.COMPANY_ID;
      const sResp = await axios.get(sUrl, {
        params: sParams,
        headers: {
          Authorization: `Bearer ${SF_BEARER_TOKEN}`,
          Accept: 'application/json',
          ...(process.env.COMPANY_ID ? { 'Company-Id': process.env.COMPANY_ID } : {})
        },
        validateStatus: () => true,
        timeout: 10000
      });
      const sCType = String(sResp.headers['content-type'] || '');
      if (sCType.includes('application/json') && sResp.status >= 200 && sResp.status < 300) {
        const sList = sResp.data?.d?.results ?? [];
        if (sList.length) {
          resolvedCode = sList[0].externalCode;
        }
      }
    } catch (_) {
      // If resolution fails, we will attempt update with provided username (may fail gracefully)
    }

    if (!resolvedCode) {
      return res.status(404).json({ error: 'score not found for username', details: 'No cust_Score record matched by username or userId' });
    }

    const updateUrl = `${BASE_URL}/odata/v2/cust_Score('${encodeURIComponent(String(resolvedCode))}')`;
    const params = {};
    if (process.env.COMPANY_ID) params.company = process.env.COMPANY_ID;

    const resp = await axios.post(updateUrl, body, {
      params,
      headers: {
        Authorization: `Bearer ${SF_BEARER_TOKEN}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-HTTP-Method': 'MERGE',
        'If-Match': '*',
        ...(Object.prototype.hasOwnProperty.call(body, 'externalName') ? { 'Accept-Language': process.env.DEFAULT_LOCALE || 'en-US' } : {}),
        ...(process.env.COMPANY_ID ? { 'Company-Id': process.env.COMPANY_ID } : {})
      },
      validateStatus: () => true,
      timeout: 30000
    });

    const ctype = String(resp.headers['content-type'] || '');
    if (resp.status < 200 || resp.status >= 300) {
      const details = ctype.includes('application/json') ? resp.data : { raw: typeof resp.data === 'string' ? resp.data.slice(0, 800) : '[non-string]' };
      return res.status(resp.status).json({ error: 'update failed', status: resp.status, details });
    }

    return res.json({ ok: true, externalCode: resolvedCode, updated: Object.keys(body) });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update cust_Score', details: err?.message || String(err) });
  }
});

// Create a new cust_Score record
app.post('/api/score', async (req, res) => {
  try {
    const { username, externalCode, externalName, cust_Score } = req.body || {};
    const inputCode = externalCode || username;
    if (!inputCode) return res.status(400).json({ error: 'externalCode or username is required' });

    // Validate and resolve externalCode against User (many MDFs reference User)
    let codeToUse = inputCode;
    let resolvedUser = null;
    try {
      const safeCode = String(inputCode).replace(/'/g, "''");
      const checkUrl = `${BASE_URL}/odata/v2/User`;
      const checkParams = {
        $format: 'json',
        $select: 'userId,username',
        $filter: `(userId eq '${safeCode}' or username eq '${safeCode}')`
      };
      if (process.env.COMPANY_ID) checkParams.company = process.env.COMPANY_ID;
      const checkResp = await axios.get(checkUrl, {
        params: checkParams,
        headers: {
          Authorization: `Bearer ${SF_BEARER_TOKEN}`,
          Accept: 'application/json',
          ...(process.env.COMPANY_ID ? { 'Company-Id': process.env.COMPANY_ID } : {})
        },
        validateStatus: () => true,
        timeout: 15000
      });

      const checkCType = String(checkResp.headers['content-type'] || '');
      if (!checkCType.includes('application/json')) {
        return res.status(checkResp.status || 502).json({
          error: 'SuccessFactors returned non-JSON during user validation',
          status: checkResp.status,
          contentType: checkCType,
          bodyPreview: typeof checkResp.data === 'string' ? checkResp.data.slice(0, 500) : '[non-string]'
        });
      }
      const uResults = checkResp.data?.d?.results ?? [];
      if (!uResults.length) {
        return res.status(400).json({
          error: 'Invalid externalCode',
          details: 'No matching User found for externalCode. Ensure it equals an existing userId or username.'
        });
      }
      resolvedUser = uResults[0];
      const src = (process.env.SCORE_EXTERNAL_CODE_SOURCE || 'userId').toLowerCase();
      codeToUse = src === 'username' ? (resolvedUser.username ?? inputCode) : (resolvedUser.userId ?? inputCode);
    } catch (preErr) {
      // If validation call fails due to SF issues, continue to let create fail with SF message
    }

    const body = {
      externalCode: codeToUse,
      ...(externalName != null ? { externalName } : {}),
      ...(cust_Score != null ? { cust_Score } : {})
    };
    const url = `${BASE_URL}/odata/v2/cust_Score`;
    const params = {};
    if (process.env.COMPANY_ID) params.company = process.env.COMPANY_ID;

    const resp = await axios.post(url, body, {
      params,
      headers: {
        Authorization: `Bearer ${SF_BEARER_TOKEN}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        // For localized fields like externalName, indicate the language variant being written
        ...(externalName ? { 'Accept-Language': process.env.DEFAULT_LOCALE || 'en-US' } : {}),
        ...(process.env.COMPANY_ID ? { 'Company-Id': process.env.COMPANY_ID } : {})
      },
      validateStatus: () => true,
      timeout: 30000
    });

    const ctype = String(resp.headers['content-type'] || '');
    if (!ctype.includes('application/json')) {
      return res.status(resp.status || 502).json({
        error: 'SuccessFactors returned non-JSON during create',
        status: resp.status,
        contentType: ctype,
        bodyPreview: typeof resp.data === 'string' ? resp.data.slice(0, 800) : '[non-string]'
      });
    }
    if (resp.status < 200 || resp.status >= 300) {
      return res.status(resp.status).json({ error: 'create failed', status: resp.status, details: resp.data });
    }

    // Success: SF often returns the created entity in d
    return res.json({ ok: true, created: resp.data?.d ?? null });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create cust_Score', details: err?.message || String(err) });
  }
});

// Create a new User record
app.post('/api/user', async (req, res) => {
  try {
    const payload = req.body || {};
    const username = payload.username;
    const userId = payload.userId ?? username;
    if (!username || !userId) return res.status(400).json({ error: 'username and userId are required' });

    const allowed = new Set([
      'userId','username','displayName','defaultFullName','email','status',
      'division','department','location','timeZone','defaultLocale'
    ]);
    const body = {};
    for (const [k, v] of Object.entries(payload)) {
      if (allowed.has(k) && v != null) body[k] = v;
    }
    // Ensure required identifiers are included
    body.userId = userId;
    body.username = username;

    const url = `${BASE_URL}/odata/v2/User`;
    const params = {};
    if (process.env.COMPANY_ID) params.company = process.env.COMPANY_ID;

    const resp = await axios.post(url, body, {
      params,
      headers: {
        Authorization: `Bearer ${SF_BEARER_TOKEN}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(process.env.COMPANY_ID ? { 'Company-Id': process.env.COMPANY_ID } : {})
      },
      validateStatus: () => true,
      timeout: 30000
    });

    const ctype = String(resp.headers['content-type'] || '');
    if (!ctype.includes('application/json')) {
      return res.status(resp.status || 502).json({
        error: 'SuccessFactors returned non-JSON during create',
        status: resp.status,
        contentType: ctype,
        bodyPreview: typeof resp.data === 'string' ? resp.data.slice(0, 800) : '[non-string]'
      });
    }
    if (resp.status < 200 || resp.status >= 300) {
      return res.status(resp.status).json({ error: 'create failed', status: resp.status, details: resp.data });
    }

    return res.json({ ok: true, created: resp.data?.d ?? null });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create user', details: err?.message || String(err) });
  }
});

// Update selected user fields by username
app.put('/api/user', async (req, res) => {
  try {
    const { username, updates } = req.body || {};
    if (!username) return res.status(400).json({ error: 'username is required' });
    if (!updates || typeof updates !== 'object') return res.status(400).json({ error: 'updates object is required' });

    // Whitelist fields that can be updated
    const allowed = new Set([
      'displayName','defaultFullName','email','status',
      'division','department','location','timeZone','defaultLocale'
    ]);
    const body = {};
    for (const [k, v] of Object.entries(updates)) {
      if (allowed.has(k)) body[k] = v;
    }
    if (Object.keys(body).length === 0) {
      return res.status(400).json({ error: 'no allowed fields in updates' });
    }

    // First, resolve userId for this username
    const findUrl = `${BASE_URL}/odata/v2/User`;
    const safeUsername = String(username).replace(/'/g, "''");
    const findParams = {
      $format: 'json',
      $filter: `username eq '${safeUsername}'`,
      $select: 'userId'
    };
    if (process.env.COMPANY_ID) findParams.company = process.env.COMPANY_ID;

    const findResp = await axios.get(findUrl, {
      params: findParams,
      headers: {
        Authorization: `Bearer ${SF_BEARER_TOKEN}`,
        Accept: 'application/json',
        ...(process.env.COMPANY_ID ? { 'Company-Id': process.env.COMPANY_ID } : {})
      },
      validateStatus: () => true,
      timeout: 15000
    });

    const findCtype = String(findResp.headers['content-type'] || '');
    if (!findCtype.includes('application/json')) {
      return res.status(findResp.status || 502).json({
        error: 'SuccessFactors returned non-JSON during lookup',
        status: findResp.status,
        contentType: findCtype,
        bodyPreview: typeof findResp.data === 'string' ? findResp.data.slice(0, 500) : '[non-string]'
      });
    }
    if (findResp.status < 200 || findResp.status >= 300) {
      return res.status(findResp.status).json({ error: 'lookup failed', details: findResp.data });
    }
    const userId = findResp.data?.d?.results?.[0]?.userId;
    if (!userId) return res.status(404).json({ error: 'user not found' });

    // Perform MERGE (partial update) on the User entity
    const safeUserId = String(userId).replace(/'/g, "''");
    const updateUrl = `${BASE_URL}/odata/v2/User('${encodeURIComponent(safeUserId)}')`;
    const updateParams = {};
    if (process.env.COMPANY_ID) updateParams.company = process.env.COMPANY_ID;

    const updResp = await axios.post(updateUrl, body, {
      params: updateParams,
      headers: {
        Authorization: `Bearer ${SF_BEARER_TOKEN}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-HTTP-Method': 'MERGE',
        'If-Match': '*',
        ...(process.env.COMPANY_ID ? { 'Company-Id': process.env.COMPANY_ID } : {})
      },
      validateStatus: () => true,
      timeout: 30000
    });

    const updCtype = String(updResp.headers['content-type'] || '');
    if (updResp.status < 200 || updResp.status >= 300) {
      // Try to surface JSON error details if present
      const details = updCtype.includes('application/json') ? updResp.data : { raw: typeof updResp.data === 'string' ? updResp.data.slice(0, 800) : '[non-string]' };
      return res.status(updResp.status).json({ error: 'update failed', status: updResp.status, details });
    }

    // Success: some responses are 204 No Content; standardize JSON success
    return res.json({ ok: true, userId, updated: Object.keys(body) });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update user', details: err?.message || String(err) });
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
