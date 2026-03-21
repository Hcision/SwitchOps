# SwitchOps — HBK Salesforce Ops Toolkit

A client-side single-page application providing 12 operational tools for managing HBK's Salesforce org. All data stays in the browser — no backend servers, no external services, no telemetry.

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

## Security

- **Zero external data transmission** — all data stays in the browser or goes directly to your Salesforce org
- **Token in memory only** — closing the tab wipes the session
- **No analytics, tracking, or telemetry**
- **No backend server** — pure static SPA
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
cp .env.example .env
# Edit .env with your Connected App Consumer Key and callback URL
npm install
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
   - **Require Secret for Web Server Flow**: **Uncheck** this
4. Save. Copy the **Consumer Key** — this is your `VITE_SF_CLIENT_ID`
5. Go to **Setup > Security > CORS**:
   - Add Allowed Origin: `http://localhost:5173`
   - Add Allowed Origin: `https://switchops.onrender.com`

## Hosting on Render (Static Site)

### Steps

1. **Create a Render account** at https://render.com (free tier works)

2. **Connect GitHub**: Dashboard > New > Static Site > Connect your GitHub account > Select `switchOps`

3. **Configure**:
   - **Name**: `switchops`
   - **Branch**: `main`
   - **Build Command**: `npm install && npm run build`
   - **Publish Directory**: `dist`

4. **Environment Variables** (under Environment tab):
   - `VITE_SF_CLIENT_ID` = your Connected App Consumer Key
   - `VITE_SF_CALLBACK_URL` = `https://switchops.onrender.com/callback`

5. **Deploy**: Render will build and deploy automatically

6. **Update Salesforce**:
   - Add `https://switchops.onrender.com/callback` to your Connected App's Callback URLs
   - Add `https://switchops.onrender.com` to CORS Allowed Origins in Salesforce Setup

7. **Verify**: Visit `https://switchops.onrender.com` — you should see the login screen

### Auto-Deploy
Render auto-deploys on every push to `main`. To disable: Render Dashboard > switchops > Settings > Auto-Deploy > toggle off.

### Custom Domain
1. Render Dashboard > switchops > Settings > Custom Domains > Add domain
2. Create CNAME DNS record pointing to `switchops.onrender.com`
3. Render auto-provisions SSL

### Troubleshooting

| Issue | Fix |
|-------|-----|
| Build failed | Run `npm run build` locally first to debug |
| OAuth redirect fails | Verify Callback URL matches exactly (including `/callback` path) |
| CORS errors | Add your domain to Salesforce Setup > Security > CORS |
| Blank page after deploy | Verify Publish Directory is `dist` |
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
