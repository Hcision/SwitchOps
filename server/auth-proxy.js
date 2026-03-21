/* ============================================================
 *  SwitchOps Auth Proxy
 *  --------------------
 *  A lightweight Express server that proxies Salesforce OAuth
 *  token exchanges and REST / Bulk API calls so the browser
 *  never talks to Salesforce directly (no CORS issues).
 *
 *  Run:  node server/auth-proxy.js
 *  Env:  PORT, FRONTEND_ORIGIN, SF_OAUTH_CLIENT_SECRET,
 *        SF_OAUTH_ALLOWED_HOSTS, SF_API_ALLOWED_HOST_SUFFIXES
 * ============================================================ */

"use strict";

const express = require("express");
const { URL } = require("url");

/* ---- configuration ---------------------------------------- */

const PORT = parseInt(process.env.PORT, 10) || 10000;

const FRONTEND_ORIGIN = (process.env.FRONTEND_ORIGIN || "").replace(/\/+$/, "");

const SF_OAUTH_CLIENT_SECRET = process.env.SF_OAUTH_CLIENT_SECRET || "";

const OAUTH_ALLOWED_HOSTS = (
  process.env.SF_OAUTH_ALLOWED_HOSTS ||
  "login.salesforce.com,test.salesforce.com"
)
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

const API_ALLOWED_SUFFIXES = (
  process.env.SF_API_ALLOWED_HOST_SUFFIXES ||
  "salesforce.com,force.com,salesforce.mil"
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/* ---- helpers ---------------------------------------------- */

/**
 * Return true when `hostname` is in the explicit allow-list
 * OR ends with one of the allowed suffixes (dot-delimited).
 */
function isAllowedOAuthHost(hostname) {
  const h = hostname.toLowerCase();
  if (OAUTH_ALLOWED_HOSTS.includes(h)) return true;
  // Accept custom domains that end in an allowed suffix
  // e.g. mycompany.my.salesforce.com
  return API_ALLOWED_SUFFIXES.some(
    (suffix) => h === suffix || h.endsWith("." + suffix)
  );
}

/**
 * Return true when `hostname` ends with one of the allowed
 * API host suffixes (e.g. .salesforce.com, .force.com, .salesforce.mil).
 */
function isAllowedApiHost(hostname) {
  const h = hostname.toLowerCase();
  return API_ALLOWED_SUFFIXES.some(
    (suffix) => h === suffix || h.endsWith("." + suffix)
  );
}

/**
 * Build a deterministic, human-readable request log line.
 */
function logRequest(method, url, status, durationMs) {
  const ts = new Date().toISOString();
  console.log(`${ts}  ${method} ${url} -> ${status} (${durationMs}ms)`);
}

/* ---- app -------------------------------------------------- */

const app = express();

/* --- global CORS middleware -------------------------------- */

app.use((req, res, next) => {
  const origin = FRONTEND_ORIGIN || req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type,x-sf-instance-url,x-sf-access-token,Accept,Sforce-Call-Options"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

/* --- body parsers ------------------------------------------ */

// JSON bodies up to 50 MB (Bulk API / metadata deploy payloads)
app.use(express.json({ limit: "50mb" }));
// URL-encoded bodies (unlikely, but harmless to support)
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
// Raw / binary bodies (e.g. zipped metadata deploy)
app.use(
  express.raw({
    type: [
      "application/zip",
      "application/octet-stream",
      "application/xml",
      "text/xml",
      "text/csv",
    ],
    limit: "50mb",
  })
);

/* ============================================================
 *  POST /oauth/token  –  Salesforce OAuth token exchange
 * ============================================================ */

app.post("/oauth/token", async (req, res) => {
  const start = Date.now();

  try {
    const { loginBase, clientId, code, redirectUri, codeVerifier } = req.body;

    /* --- validate inputs ----------------------------------- */

    if (!loginBase || !clientId || !code || !redirectUri) {
      logRequest("POST", "/oauth/token", 400, Date.now() - start);
      return res.status(400).json({
        error: "Missing required fields: loginBase, clientId, code, redirectUri",
      });
    }

    // loginBase may arrive as just a hostname ("login.salesforce.com") or
    // a full URL ("https://login.salesforce.com").  Normalise to hostname.
    let hostname;
    try {
      hostname = loginBase.includes("://")
        ? new URL(loginBase).hostname
        : new URL("https://" + loginBase).hostname;
    } catch {
      logRequest("POST", "/oauth/token", 400, Date.now() - start);
      return res.status(400).json({ error: "Invalid loginBase URL" });
    }

    if (!isAllowedOAuthHost(hostname)) {
      logRequest("POST", "/oauth/token", 403, Date.now() - start);
      return res.status(403).json({
        error: `OAuth host "${hostname}" is not in the allow-list`,
      });
    }

    const tokenUrl = `https://${hostname}/services/oauth2/token`;

    /* --- build form body ----------------------------------- */

    const buildFormParams = (grantType) => {
      const params = new URLSearchParams();
      params.set("grant_type", grantType);
      params.set("client_id", clientId);
      params.set("code", code);
      params.set("redirect_uri", redirectUri);
      if (codeVerifier) {
        params.set("code_verifier", codeVerifier);
      }
      if (SF_OAUTH_CLIENT_SECRET) {
        params.set("client_secret", SF_OAUTH_CLIENT_SECRET);
      }
      return params;
    };

    /* --- attempt token exchange ----------------------------- */

    // Try standard grant type first
    let sfRes = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: buildFormParams("authorization_code").toString(),
    });

    // If the standard grant type fails, fall back to PKCE-specific type
    if (!sfRes.ok) {
      const errorBody = await sfRes.text();
      // Only retry with alternate grant type if the error suggests wrong grant type
      if (
        errorBody.includes("unsupported_grant_type") ||
        errorBody.includes("invalid_grant")
      ) {
        sfRes = await fetch(tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: buildFormParams("authorization_code_pkce").toString(),
        });
      } else {
        // Return the original error as-is
        logRequest("POST", "/oauth/token", sfRes.status, Date.now() - start);
        res.setHeader("Content-Type", "application/json");
        return res.status(sfRes.status).send(errorBody);
      }
    }

    /* --- forward response ---------------------------------- */

    const responseBody = await sfRes.text();
    logRequest("POST", "/oauth/token", sfRes.status, Date.now() - start);

    res.setHeader("Content-Type", "application/json");
    return res.status(sfRes.status).send(responseBody);
  } catch (err) {
    console.error("OAuth token exchange error:", err);
    logRequest("POST", "/oauth/token", 502, Date.now() - start);
    return res.status(502).json({
      error: "Failed to contact Salesforce token endpoint",
      detail: err.message,
    });
  }
});

/* ============================================================
 *  ALL /salesforce/*  –  Salesforce REST / Bulk API proxy
 * ============================================================ */

app.all("/salesforce/*", async (req, res) => {
  const start = Date.now();

  try {
    /* --- read & validate headers --------------------------- */

    const instanceUrl = (req.headers["x-sf-instance-url"] || "").replace(
      /\/+$/,
      ""
    );
    const accessToken = req.headers["x-sf-access-token"] || "";

    if (!instanceUrl || !accessToken) {
      logRequest(req.method, req.originalUrl, 400, Date.now() - start);
      return res.status(400).json({
        error:
          "Missing required headers: x-sf-instance-url and x-sf-access-token",
      });
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(instanceUrl);
    } catch {
      logRequest(req.method, req.originalUrl, 400, Date.now() - start);
      return res.status(400).json({ error: "Invalid x-sf-instance-url" });
    }

    if (!isAllowedApiHost(parsedUrl.hostname)) {
      logRequest(req.method, req.originalUrl, 403, Date.now() - start);
      return res.status(403).json({
        error: `API host "${parsedUrl.hostname}" is not in the allow-list`,
      });
    }

    /* --- build upstream URL -------------------------------- */

    // Strip the /salesforce prefix to get the real SF path
    // req.params[0] gives everything after /salesforce/
    const upstreamPath = "/" + req.params[0];
    // Preserve the original query string
    const qs = req.url.includes("?")
      ? req.url.slice(req.url.indexOf("?"))
      : "";
    const targetUrl = `${instanceUrl}${upstreamPath}${qs}`;

    /* --- build upstream headers ---------------------------- */

    const upstreamHeaders = {
      Authorization: `Bearer ${accessToken}`,
    };

    // Forward specific headers if present
    const forwardHeaders = ["content-type", "accept", "sforce-call-options"];
    for (const name of forwardHeaders) {
      if (req.headers[name]) {
        upstreamHeaders[name] = req.headers[name];
      }
    }

    /* --- build fetch options ------------------------------- */

    const fetchOpts = {
      method: req.method,
      headers: upstreamHeaders,
    };

    // Attach body for non-GET/HEAD requests
    if (req.method !== "GET" && req.method !== "HEAD") {
      // If body was parsed as JSON, re-serialise; otherwise use raw buffer
      if (Buffer.isBuffer(req.body)) {
        fetchOpts.body = req.body;
      } else if (req.body && typeof req.body === "object") {
        fetchOpts.body = JSON.stringify(req.body);
        // Ensure content-type is set when we serialise
        if (!upstreamHeaders["content-type"]) {
          upstreamHeaders["content-type"] = "application/json";
        }
      } else if (typeof req.body === "string") {
        fetchOpts.body = req.body;
      }
    }

    /* --- execute upstream request -------------------------- */

    const sfRes = await fetch(targetUrl, fetchOpts);

    /* --- stream response back to client -------------------- */

    logRequest(req.method, req.originalUrl, sfRes.status, Date.now() - start);

    // Forward Content-Type from Salesforce
    const ct = sfRes.headers.get("content-type");
    if (ct) {
      res.setHeader("Content-Type", ct);
    }

    // Forward Sforce-Limit-Info if present (useful for API usage tracking)
    const limitInfo = sfRes.headers.get("sforce-limit-info");
    if (limitInfo) {
      res.setHeader("Sforce-Limit-Info", limitInfo);
    }

    // Read the response body as a buffer and send
    const body = Buffer.from(await sfRes.arrayBuffer());
    return res.status(sfRes.status).send(body);
  } catch (err) {
    console.error("Salesforce API proxy error:", err);
    logRequest(req.method, req.originalUrl, 502, Date.now() - start);
    return res.status(502).json({
      error: "Failed to contact Salesforce API",
      detail: err.message,
    });
  }
});

/* ---- health check ----------------------------------------- */

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

/* ---- start ------------------------------------------------ */

app.listen(PORT, () => {
  console.log(`SwitchOps auth-proxy listening on port ${PORT}`);
  if (FRONTEND_ORIGIN) {
    console.log(`  CORS origin: ${FRONTEND_ORIGIN}`);
  } else {
    console.log("  CORS origin: * (FRONTEND_ORIGIN not set)");
  }
  console.log(
    `  OAuth allowed hosts: ${OAUTH_ALLOWED_HOSTS.join(", ")}`
  );
  console.log(
    `  API allowed suffixes: ${API_ALLOWED_SUFFIXES.join(", ")}`
  );
});
