# SwitchOps — HBK Salesforce Ops Toolkit

A single-page application providing 12 operational tools for managing HBK's Salesforce org. All Salesforce data stays between your browser and your org — routed through a lightweight auth proxy to eliminate CORS issues. No external analytics, no telemetry.

## Features

### Metadata Intelligence
1. **Flow Dependency Graph** — Interactive graph visualization of all Salesforce Flows and their dependencies (subflows, Apex calls, object triggers)
4. **Validation Rule Explorer** — Browse, search, and simulate validation rules with plain-English formula translation
6. **Custom Metadata Console** — Visual grid editor for custom metadata types with deployment package generation
7. **Deployment Impact Analyzer** — Paste git diff paths, see full dependency tree and blast radius
10. **Field Lineage Tracker** — Trace field value propagation across objects through flows and Apex

### Operations & Monitoring
2. **SAP Integration Health Monitor** — Real-time dashboard of SAP/enosix integration health with trend charts
8. **Work Order Lifecycle Tracker** — Visual swimlane view of Work Order, Case, Asset, and Service Appointment chains
9. **Automation Switch Control Center** — Granular flow enable/disable with presets and audit logging

### Access & Security
3. **Permission Set Mapper** — Matrix view of permission sets, user lookup, compare, and unused detection

### Sales & Quoting
5. **Quote Completeness Checker** — Deep audit of CPQ Quotes with weighted scoring across header, lines, approval, and SAP readiness

### Data Loaders
11. **FSL Data Loader** — Excel/CSV upload wizard for Field Service Lightning data (WorkType, ServiceTerritory, etc.)
12. **CPQ Product Loader** — Excel/CSV upload wizard for CPQ product structures (Product2, Features, Options, Rules)

## Architecture

```
Browser (SPA)  ──>  Auth Proxy (Node.js)  ──>  Salesforce APIs
                    - Token exchange           - REST API
                    - API forwarding           - Tooling API
                    - CORS headers             - Composite API
```

The auth proxy eliminates CORS issues by forwarding all Salesforce API calls server-to-server. The proxy never stores tokens or data — it only relays requests.

## Security

- **Data flows only to your Salesforce org** — via the auth proxy (no data stored on proxy)
- **Token in memory only** — closing the tab wipes the session
- **No analytics, tracking, or telemetry**
- **Client secret stays server-side** — never exposed to the browser
- **All libraries bundled** — works air-gapped after initial load

## Tech Stack

- **React 19** + TypeScript
- **Vite** for build tooling with code splitting per tool
- **Tailwind CSS v4** with dark mode
- **ReactFlow** for graph visualization
- **TanStack Table** for data tables with sort, filter, column visibility, export
- **SheetJS (xlsx)** for Excel parsing (in-browser)
- **JSZip** for deployment package generation
- **Zustand** for state management
- **jsPDF** for PDF export

## Prerequisites

- Node.js 18+ and npm
- A Salesforce Connected App (see setup guide below)

## Local Development

```bash
git clone https://github.com/<your-username>/switchOps.git
cd switchOps

# 1. Install frontend dependencies
npm install

# 2. Install proxy dependencies
cd server && npm install && cd ..

# 3. Configure environment
cp .env.example .env
# Edit .env:
#   VITE_SF_CLIENT_ID=<your Connected App Consumer Key>
#   VITE_SF_REDIRECT_URI=http://localhost:5173/callback
#   VITE_SF_AUTH_PROXY_URL=http://localhost:10000

# 4. Start the auth proxy (in a separate terminal)
cd server && FRONTEND_ORIGIN=http://localhost:5173 node auth-proxy.js

# 5. Start the frontend
npm run dev
# Opens at http://localhost:5173
```

## Build

```bash
npm run build
# Produces dist/ folder (~2MB) with static HTML/JS/CSS
```

## Salesforce Connected App Setup

1. In Salesforce Setup, go to **App Manager** > **New Connected App**
2. Fill in:
   - **Connected App Name**: SwitchOps
   - **API Name**: SwitchOps
   - **Contact Email**: your admin email
3. Under **API (Enable OAuth Settings)**:
   - Check **Enable OAuth Settings**
   - **Callback URL**: Add all of these:
     - `http://localhost:5173/callback` (local dev)
     - `https://switchops.onrender.com/callback` (production)
   - **Selected OAuth Scopes**: `Access the identity URL service (id, profile, email, address, phone)`, `Manage user data via APIs (api)`, `Perform requests at any time (refresh_token, offline_access)`
   - **Require Proof Key for Code Exchange (PKCE)**: Check this
   - **Require Secret for Web Server Flow**: Uncheck (or leave checked if you set `SF_OAUTH_CLIENT_SECRET` on the proxy)
4. Save. Copy the **Consumer Key** (this is `VITE_SF_CLIENT_ID`) and optionally the **Consumer Secret** (this is `SF_OAUTH_CLIENT_SECRET` for the proxy)
5. **No CORS setup needed** — the auth proxy handles all API calls server-to-server

## Hosting on Render

The app deploys as **two Render services** (defined in `render.yaml`):

### Option A: Deploy via render.yaml (recommended)

1. Go to Render Dashboard > **New** > **Blueprint**
2. Connect your GitHub repo and select `switchOps`
3. Render reads `render.yaml` and creates both services automatically
4. Set the environment variables for each service (see below)

### Option B: Deploy manually

#### Service 1: Auth Proxy (Web Service)

1. Render Dashboard > **New** > **Web Service**
2. Connect `switchOps` repo
3. Configure:
   - **Name**: `switchops-auth-proxy`
   - **Runtime**: Node
   - **Build Command**: `cd server && npm ci`
   - **Start Command**: `cd server && npm start`
4. **Environment Variables**:
   - `FRONTEND_ORIGIN` = `https://switchops.onrender.com`
   - `SF_OAUTH_CLIENT_SECRET` = your Connected App Consumer Secret (optional but recommended)
   - `SF_OAUTH_ALLOWED_HOSTS` = `login.salesforce.com,test.salesforce.com`
   - `SF_API_ALLOWED_HOST_SUFFIXES` = `salesforce.com,force.com,salesforce.mil`

#### Service 2: Frontend (Static Site)

1. Render Dashboard > **New** > **Static Site**
2. Connect `switchOps` repo
3. Configure:
   - **Name**: `switchops`
   - **Build Command**: `npm ci && npm run build`
   - **Publish Directory**: `dist`
4. **Environment Variables**:
   - `VITE_SF_CLIENT_ID` = your Connected App Consumer Key
   - `VITE_SF_REDIRECT_URI` = `https://switchops.onrender.com/callback`
   - `VITE_SF_AUTH_PROXY_URL` = `https://switchops-auth-proxy.onrender.com`
5. Under **Redirects/Rewrites**, add: `/* -> /index.html` (rewrite) for SPA routing

### After Deployment

1. Add `https://switchops.onrender.com/callback` to your Connected App's Callback URLs in Salesforce
2. Visit `https://switchops.onrender.com` — you should see the login screen
3. **No CORS setup needed in Salesforce** — the proxy handles all API calls server-to-server

### Auto-Deploy
Render auto-deploys on every push to `main`. To disable: Render Dashboard > Settings > Auto-Deploy > toggle off.

### Custom Domain
1. Render Dashboard > switchops > Settings > Custom Domains > Add domain
2. Create CNAME DNS record pointing to `switchops.onrender.com`
3. Render auto-provisions SSL

### Troubleshooting

| Issue | Fix |
|-------|-----|
| Build failed | Run `npm run build` locally first to debug |
| OAuth redirect fails | Verify Callback URL matches exactly (including `/callback` path) |
| API calls fail | Check proxy logs on Render; verify `VITE_SF_AUTH_PROXY_URL` points to the proxy |
| Blank page after deploy | Verify Publish Directory is `dist` and SPA rewrite rule is set |
| Token expired | Click Disconnect and reconnect — tokens are memory-only |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+K` | Open global search |
| `Ctrl+1` to `Ctrl+9` | Jump to tool by number |
| `Ctrl+E` | Export current view |
| `Esc` | Close modal / search |

## Required Salesforce Permissions

The connected user needs:
- **API Enabled** permission
- **View Setup and Configuration** (for Tooling API metadata queries)
- Read access to all objects queried by each tool (see tool descriptions)
- For Tool 9 (Automation Switch): ability to activate/deactivate flows via Tooling API

## Per-Tool API Usage

| Tool | APIs Used | Key Objects |
|------|-----------|-------------|
| 1. Flow Graph | Tooling API | Flow, ApexClass |
| 2. SAP Monitor | REST API | ensxtx_SAP_Transact_Log__c, Error_Log__c, ensxtx_VC_Log__c |
| 3. Permission Mapper | REST API | PermissionSet, ObjectPermissions, FieldPermissions, User |
| 4. Validation Explorer | Tooling API | ValidationRule |
| 5. Quote Checker | REST API | SBQQ__Quote__c, SBQQ__QuoteLine__c, Account |
| 6. Metadata Console | Tooling API, REST API | Custom Metadata Types (*__mdt) |
| 7. Deploy Analyzer | Tooling API | MetadataComponentDependency |
| 8. WO Tracker | REST API | WorkOrder, WorkOrderLineItem, WorkStep, ServiceAppointment |
| 9. Automation Switch | Tooling API | Flow, Automation_Switch__c |
| 10. Field Lineage | Tooling API, REST API | MetadataComponentDependency, FieldDefinition |
| 11. FSL Loader | REST API, Composite API | WorkType, ServiceTerritory, ServiceResource, etc. |
| 12. CPQ Loader | REST API, Composite API | Product2, SBQQ__ProductFeature__c, SBQQ__ProductOption__c, etc. |

## Project Structure

```
src/
├── app/              # Tool config, routing
├── components/       # Shared UI (DataTable, Modal, Sidebar, TopBar, etc.)
├── hooks/            # Custom hooks (useSalesforce, useKeyboardShortcuts)
├── services/         # Salesforce API client, Zustand store
├── styles/           # Global CSS, Tailwind config
├── tools/            # 12 tool modules (lazy-loaded)
│   ├── tool-01-flow-graph/
│   ├── tool-02-sap-monitor/
│   ├── tool-03-permission-mapper/
│   ├── tool-04-validation-explorer/
│   ├── tool-05-quote-checker/
│   ├── tool-06-metadata-console/
│   ├── tool-07-deploy-analyzer/
│   ├── tool-08-workorder-tracker/
│   ├── tool-09-automation-switch/
│   ├── tool-10-field-lineage/
│   ├── tool-11-fsl-loader/
│   └── tool-12-cpq-loader/
└── utils/            # Parsers, helpers
```

## License

Internal HBK use only. Not for distribution.
