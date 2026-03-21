// ---------------------------------------------------------------------------
// Salesforce Authentication & REST API Service
// ---------------------------------------------------------------------------
// PKCE OAuth 2.0 flow with in-memory token storage.
// All credentials are held in module-scoped variables - nothing is persisted
// to localStorage, sessionStorage, or cookies.
// ---------------------------------------------------------------------------

import type { AuthState } from '@/services/store';

const API_VERSION = 'v62.0';

const SF_CLIENT_ID = import.meta.env.VITE_SF_CLIENT_ID as string;
const SF_CALLBACK_URL = import.meta.env.VITE_SF_CALLBACK_URL as string;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SalesforceRecord {
  Id?: string;
  attributes?: {
    type: string;
    url: string;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface SalesforceQueryResult<T extends SalesforceRecord = SalesforceRecord> {
  totalSize: number;
  done: boolean;
  records: T[];
  nextRecordsUrl?: string;
}

export interface SalesforceDescribeResult {
  name: string;
  label: string;
  labelPlural: string;
  keyPrefix: string;
  fields: SalesforceFieldDescribe[];
  recordTypeInfos: SalesforceRecordTypeInfo[];
  childRelationships: SalesforceChildRelationship[];
  [key: string]: unknown;
}

export interface SalesforceFieldDescribe {
  name: string;
  label: string;
  type: string;
  length: number;
  nillable: boolean;
  createable: boolean;
  updateable: boolean;
  referenceTo: string[];
  relationshipName: string | null;
  picklistValues: SalesforcePicklistValue[];
  [key: string]: unknown;
}

export interface SalesforcePicklistValue {
  active: boolean;
  defaultValue: boolean;
  label: string;
  value: string;
}

export interface SalesforceRecordTypeInfo {
  available: boolean;
  defaultRecordTypeMapping: boolean;
  developerName: string;
  master: boolean;
  name: string;
  recordTypeId: string;
}

export interface SalesforceChildRelationship {
  childSObject: string;
  field: string;
  relationshipName: string | null;
}

export interface SalesforceCompositeRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  referenceId: string;
  body?: Record<string, unknown>;
}

export interface SalesforceCompositeResponse {
  compositeResponse: Array<{
    body: unknown;
    httpHeaders: Record<string, string>;
    httpStatusCode: number;
    referenceId: string;
  }>;
}

export interface SalesforceApiLimits {
  [limitName: string]: {
    Max: number;
    Remaining: number;
  };
}

export interface SalesforceErrorBody {
  message: string;
  errorCode: string;
  fields?: string[];
}

export interface SalesforceTokenResponse {
  access_token: string;
  instance_url: string;
  id: string;
  token_type: string;
  issued_at: string;
  signature: string;
  scope?: string;
  /** Parsed Salesforce User Id (from the identity URL). */
  userId: string;
  /** Convenience alias for `instance_url`. */
  instanceUrl: string;
  /** Whether the org appears to be a sandbox environment. */
  isSandbox: boolean;
}

// ---------------------------------------------------------------------------
// Custom Error
// ---------------------------------------------------------------------------

export class SalesforceError extends Error {
  public readonly statusCode: number;
  public readonly errorCode: string;
  public readonly fields: string[];
  public readonly rawBody: unknown;

  constructor(
    message: string,
    statusCode: number,
    errorCode: string,
    fields: string[] = [],
    rawBody?: unknown,
  ) {
    super(message);
    this.name = 'SalesforceError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.fields = fields;
    this.rawBody = rawBody;
  }
}

// ---------------------------------------------------------------------------
// In-memory credential store (module-scoped, never persisted)
// ---------------------------------------------------------------------------

let _accessToken: string | null = null;
let _instanceUrl: string | null = null;
let _codeVerifier: string | null = null;

// ---------------------------------------------------------------------------
// PKCE Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically random code verifier (43-128 chars, URL-safe).
 */
export function generateCodeVerifier(): string {
  const array = new Uint8Array(64);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

/**
 * Derive the S256 code challenge from a code verifier.
 */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * Base64-URL encode (no padding) per RFC 7636.
 */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// OAuth Flow
// ---------------------------------------------------------------------------

/**
 * Kick off the Salesforce PKCE login flow.
 *
 * Generates a PKCE code verifier, stores it in memory for later exchange,
 * and redirects the browser to the Salesforce authorization endpoint.
 *
 * @param isSandbox - If true, uses `test.salesforce.com`; otherwise `login.salesforce.com`.
 */
export async function initiateLogin(isSandbox: boolean): Promise<void> {
  const verifier = generateCodeVerifier();
  _codeVerifier = verifier;

  const challenge = await generateCodeChallenge(verifier);

  const baseUrl = isSandbox
    ? 'https://test.salesforce.com'
    : 'https://login.salesforce.com';

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: SF_CLIENT_ID,
    redirect_uri: SF_CALLBACK_URL,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'api refresh_token',
  });

  window.location.href = `${baseUrl}/services/oauth2/authorize?${params.toString()}`;
}

/**
 * Exchange the authorization code (from the callback URL) for an access token.
 *
 * Reads the `code` query parameter from the current URL, sends it to the
 * Salesforce token endpoint together with the stored PKCE verifier, and
 * stores the resulting access token and instance URL in memory.
 *
 * @returns The token response from Salesforce.
 * @throws {SalesforceError} If the code exchange fails.
 */
export async function handleCallback(): Promise<SalesforceTokenResponse> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');

  if (!code) {
    throw new SalesforceError(
      'No authorization code found in callback URL',
      400,
      'MISSING_AUTH_CODE',
    );
  }

  if (!_codeVerifier) {
    throw new SalesforceError(
      'No PKCE code verifier found. Did the login flow start in this session?',
      400,
      'MISSING_CODE_VERIFIER',
    );
  }

  // Determine token endpoint: prefer the instance from the issuer hint
  // embedded in the state, but fall back to login.salesforce.com.
  const tokenUrl = 'https://login.salesforce.com/services/oauth2/token';

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: SF_CLIENT_ID,
    redirect_uri: SF_CALLBACK_URL,
    code,
    code_verifier: _codeVerifier,
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new SalesforceError(
      (errorBody as Record<string, string>)?.error_description ??
        'Token exchange failed',
      response.status,
      (errorBody as Record<string, string>)?.error ?? 'TOKEN_EXCHANGE_ERROR',
      [],
      errorBody,
    );
  }

  const rawToken = (await response.json()) as Omit<
    SalesforceTokenResponse,
    'userId' | 'instanceUrl' | 'isSandbox'
  >;

  _accessToken = rawToken.access_token;
  _instanceUrl = rawToken.instance_url;
  _codeVerifier = null; // no longer needed

  // Parse the user Id from the identity URL (last segment).
  // The `id` field looks like: https://login.salesforce.com/id/00Dxx.../005xx...
  const idSegments = rawToken.id.split('/');
  const userId = idSegments[idSegments.length - 1] ?? '';

  const isSandbox =
    rawToken.instance_url.includes('.sandbox.') ||
    rawToken.instance_url.includes('.cs') ||
    rawToken.instance_url.includes('test.salesforce.com');

  const tokenData: SalesforceTokenResponse = {
    ...rawToken,
    userId,
    instanceUrl: rawToken.instance_url,
    isSandbox,
  };

  return tokenData;
}

// ---------------------------------------------------------------------------
// High-level login (used by useAuth hook)
// ---------------------------------------------------------------------------

interface SalesforceUserInfo {
  display_name: string;
  organization_id: string;
}

/**
 * Complete login flow: exchange the callback code for tokens, fetch the
 * user's identity, and return an `AuthState` ready for the store.
 *
 * The hook layer (`useAuth`) calls this after the OAuth redirect lands on
 * the callback URL.
 */
export async function login(): Promise<AuthState> {
  const tokenData = await handleCallback();

  // Fetch user info from the identity URL returned in the token response
  const userInfo = await fetchJson<SalesforceUserInfo>(tokenData.id, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  // Determine sandbox vs production from the instance URL
  const isSandbox =
    tokenData.instance_url.includes('.sandbox.') ||
    tokenData.instance_url.includes('.cs') ||
    tokenData.instance_url.includes('test.salesforce.com');

  return {
    isAuthenticated: true,
    userName: userInfo.display_name ?? '',
    orgName: userInfo.organization_id ?? '',
    orgType: isSandbox ? 'sandbox' : 'production',
    instanceUrl: tokenData.instance_url,
  };
}

/**
 * Minimal typed fetch helper (used only during login, before sfRequest is
 * available, because we may not have stored credentials yet).
 */
async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Accept', 'application/json');
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new SalesforceError(
      (body as Record<string, string>)?.error_description ??
        `Request to ${url} failed`,
      res.status,
      (body as Record<string, string>)?.error ?? 'FETCH_ERROR',
      [],
      body,
    );
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Getters / State
// ---------------------------------------------------------------------------

/** Return the current access token or `null` if not authenticated. */
export function getAccessToken(): string | null {
  return _accessToken;
}

/** Return the Salesforce instance URL or `null` if not authenticated. */
export function getInstanceUrl(): string | null {
  return _instanceUrl;
}

/** Whether an active access token is held in memory. */
export function isAuthenticated(): boolean {
  return _accessToken !== null && _instanceUrl !== null;
}

/** Clear all in-memory authentication data. */
export function logout(): void {
  _accessToken = null;
  _instanceUrl = null;
  _codeVerifier = null;
}

/**
 * Manually set credentials (useful for refresh-token flows or tests).
 */
export function setCredentials(accessToken: string, instanceUrl: string): void {
  _accessToken = accessToken;
  _instanceUrl = instanceUrl;
}

// ---------------------------------------------------------------------------
// Base Request
// ---------------------------------------------------------------------------

/**
 * Make an authenticated request to the Salesforce REST API.
 *
 * Automatically prepends the instance URL and injects the `Authorization`
 * header. On a `401` response the in-memory credentials are cleared so the
 * UI can redirect the user to re-authenticate.
 *
 * @param path   - API path (e.g. `/services/data/v62.0/query?q=...`).
 * @param options - Standard `fetch` options (method, body, headers, etc.).
 * @returns The parsed JSON response.
 * @throws {SalesforceError} On non-2xx responses.
 */
export async function sfRequest<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  if (!_accessToken || !_instanceUrl) {
    throw new SalesforceError(
      'Not authenticated. Call initiateLogin() first.',
      401,
      'NOT_AUTHENTICATED',
    );
  }

  const url = `${_instanceUrl}${path}`;

  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${_accessToken}`);
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('Accept', 'application/json');

  const response = await fetch(url, { ...options, headers });

  // Handle 204 No Content (e.g. successful DELETE / PATCH)
  if (response.status === 204) {
    return undefined as T;
  }

  // Handle 401 - session expired / revoked
  if (response.status === 401) {
    logout();
    throw new SalesforceError(
      'Session expired or token revoked. Please log in again.',
      401,
      'SESSION_EXPIRED',
    );
  }

  const responseBody: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throwSalesforceError(response.status, responseBody);
  }

  return responseBody as T;
}

// ---------------------------------------------------------------------------
// Error Parsing
// ---------------------------------------------------------------------------

function throwSalesforceError(statusCode: number, body: unknown): never {
  // Salesforce typically returns an array of error objects.
  if (Array.isArray(body) && body.length > 0) {
    const first = body[0] as SalesforceErrorBody;
    throw new SalesforceError(
      first.message ?? 'Unknown Salesforce error',
      statusCode,
      first.errorCode ?? 'UNKNOWN_ERROR',
      first.fields ?? [],
      body,
    );
  }

  // Single error object (e.g. from Tooling API)
  if (body && typeof body === 'object' && 'message' in body) {
    const errObj = body as SalesforceErrorBody;
    throw new SalesforceError(
      errObj.message,
      statusCode,
      errObj.errorCode ?? 'UNKNOWN_ERROR',
      errObj.fields ?? [],
      body,
    );
  }

  throw new SalesforceError(
    `Salesforce request failed with status ${statusCode}`,
    statusCode,
    'UNKNOWN_ERROR',
    [],
    body,
  );
}

// ---------------------------------------------------------------------------
// SOQL Query
// ---------------------------------------------------------------------------

/**
 * Execute a SOQL query.  Returns the first page of results.
 */
export async function query<T extends SalesforceRecord = SalesforceRecord>(
  soql: string,
): Promise<SalesforceQueryResult<T>> {
  const path = `/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`;
  return sfRequest<SalesforceQueryResult<T>>(path);
}

/**
 * Execute a SOQL query and automatically follow `nextRecordsUrl` to fetch
 * every page of results.
 */
export async function queryAll<T extends SalesforceRecord = SalesforceRecord>(
  soql: string,
): Promise<SalesforceQueryResult<T>> {
  const firstPage = await query<T>(soql);

  const allRecords: T[] = [...firstPage.records];
  let nextUrl = firstPage.nextRecordsUrl;

  while (nextUrl) {
    const nextPage = await sfRequest<SalesforceQueryResult<T>>(nextUrl);
    allRecords.push(...nextPage.records);
    nextUrl = nextPage.nextRecordsUrl;
  }

  return {
    totalSize: firstPage.totalSize,
    done: true,
    records: allRecords,
  };
}

/**
 * Execute a SOQL query against the Tooling API.
 */
export async function toolingQuery<T extends SalesforceRecord = SalesforceRecord>(
  soql: string,
): Promise<SalesforceQueryResult<T>> {
  const path = `/services/data/${API_VERSION}/tooling/query?q=${encodeURIComponent(soql)}`;
  return sfRequest<SalesforceQueryResult<T>>(path);
}

/**
 * Alias for `query` - used by the `useSoql` hook.
 */
export async function querySoql<T = unknown>(soql: string): Promise<T> {
  const result = await query(soql);
  return result as T;
}

/**
 * Alias for `toolingQuery` - used by the `useToolingQuery` hook.
 */
export async function queryTooling<T = unknown>(soql: string): Promise<T> {
  const result = await toolingQuery(soql);
  return result as T;
}

// ---------------------------------------------------------------------------
// SObject CRUD
// ---------------------------------------------------------------------------

/**
 * Describe an SObject (fields, record types, child relationships, etc.).
 */
export async function describe(sobject: string): Promise<SalesforceDescribeResult> {
  const path = `/services/data/${API_VERSION}/sobjects/${encodeURIComponent(sobject)}/describe`;
  return sfRequest<SalesforceDescribeResult>(path);
}

/**
 * Retrieve a single record by Id.
 *
 * @param sobject - SObject API name (e.g. `Account`).
 * @param id      - The Salesforce record Id.
 * @param fields  - Optional list of fields to retrieve.
 */
export async function getRecord<T extends SalesforceRecord = SalesforceRecord>(
  sobject: string,
  id: string,
  fields?: string[],
): Promise<T> {
  let path = `/services/data/${API_VERSION}/sobjects/${encodeURIComponent(sobject)}/${encodeURIComponent(id)}`;
  if (fields && fields.length > 0) {
    path += `?fields=${fields.map(encodeURIComponent).join(',')}`;
  }
  return sfRequest<T>(path);
}

/**
 * Create a new SObject record.
 *
 * @returns The Salesforce response containing `id`, `success`, and `errors`.
 */
export async function createRecord(
  sobject: string,
  data: Record<string, unknown>,
): Promise<{ id: string; success: boolean; errors: SalesforceErrorBody[] }> {
  const path = `/services/data/${API_VERSION}/sobjects/${encodeURIComponent(sobject)}`;
  return sfRequest(path, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/**
 * Update an existing SObject record (PATCH).
 *
 * Salesforce returns `204 No Content` on success, so this resolves to
 * `undefined`.
 */
export async function updateRecord(
  sobject: string,
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  const path = `/services/data/${API_VERSION}/sobjects/${encodeURIComponent(sobject)}/${encodeURIComponent(id)}`;
  await sfRequest<void>(path, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

/**
 * Delete an SObject record.
 *
 * Salesforce returns `204 No Content` on success.
 */
export async function deleteRecord(sobject: string, id: string): Promise<void> {
  const path = `/services/data/${API_VERSION}/sobjects/${encodeURIComponent(sobject)}/${encodeURIComponent(id)}`;
  await sfRequest<void>(path, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Composite API
// ---------------------------------------------------------------------------

/**
 * Execute a Composite API request (up to 25 sub-requests in a single call).
 *
 * @param requests - Array of composite sub-requests.
 * @param allOrNone - If `true`, all sub-requests are rolled back on any failure.
 */
export async function composite(
  requests: SalesforceCompositeRequest[],
  allOrNone = false,
): Promise<SalesforceCompositeResponse> {
  const path = `/services/data/${API_VERSION}/composite`;
  return sfRequest<SalesforceCompositeResponse>(path, {
    method: 'POST',
    body: JSON.stringify({ allOrNone, compositeRequest: requests }),
  });
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Retrieve the current API usage limits for the org.
 *
 * Returns the raw limits map keyed by limit name (e.g. `DailyApiRequests`).
 */
export async function getApiLimits(): Promise<SalesforceApiLimits> {
  const path = `/services/data/${API_VERSION}/limits`;
  return sfRequest<SalesforceApiLimits>(path);
}
