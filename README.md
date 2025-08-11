# Ceph RGW S3 Multi-Site UI

A modern, single-page web application for managing objects in a Ceph RGW multi-site environment. This UI provides a clear, intuitive interface for browsing, managing, and verifying the replication status of objects across different geographic zones.

## Features

- **Multi-Zone Management**: Seamlessly switch between configured Ceph RGW zones.
- **Folder Navigation**: Intuitive breadcrumb-based navigation for exploring object prefixes.
- **Object Operations**:
    - **Upload**: Upload files directly to any zone, with support for large files.
    - **Download**: Download the latest version of an object.
    - **Delete**: Delete objects, which creates a `DeleteMarker` in versioned buckets.
- **Auto Refresh**: An optional, live-polling feature that automatically refreshes the file list and replication statuses every 10 seconds.
- **Secure Authentication**: Integrated with OpenID Connect (OIDC) for secure user login.
- **Resilient UI**: Gracefully handles session token expiration during long operations or periods of inactivity.

## Architecture

The application is composed of two main parts:

- **Backend**: A lightweight API server built with **FastAPI** (Python) that communicates with the Ceph RGW S3 endpoints.
- **Frontend**: A dependency-free, modern **Vanilla JavaScript** single-page application that interacts with the backend API.

---

## Setup and Configuration

### Prerequisites

- Python 3.8+
- An OIDC provider (like Keycloak, Okta, etc.) for authentication.
- Access to two or more Ceph RGW S3 endpoints in a multi-site configuration.

### 1. Backend Setup

The backend server handles authentication and all S3 operations.

a. **Install dependencies**:
```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

b. **Configure environment variables**:

Create a `.env` file in the `backend/` directory by copying the example:
```bash
cp .env.example .env
```

Now, edit the `.env` file with your specific environment details:

```ini
# backend/.env

# S3 Configuration
# A comma-separated list of zone_name=endpoint_url pairs.
S3_ZONES=zone1=http://ceph-rgw-zone1:8000,zone2=http://ceph-rgw-zone2:8000

# The default bucket to display in the UI.
DEFAULT_BUCKET=my-replicated-bucket

# OIDC Authentication Configuration
# The discovery URL for your OIDC provider.
OIDC_ISSUER_URL=https://your-keycloak-server/realms/my-realm
OIDC_CLIENT_ID=my-client-id
OIDC_CLIENT_SECRET=your-client-secret
```

c. **Run the backend server**:
```bash
uvicorn backend.app:app --reload
```
The API will be available at `http://127.0.0.1:8000`.

### 2. Frontend Setup

The frontend is a set of static files that can be served by any web server.

a. **Configure the frontend**:

Create a `frontend/js/config.js` file by copying the example:
```bash
cp frontend/js/config.js.example frontend/js/config.js
```

Now, edit `frontend/js/config.js` to point to your backend API and to configure your OIDC client settings. The `redirect_uri` must match what is configured in your OIDC provider.

```javascript
// frontend/js/config.js
export const API_BASE = 'http://127.0.0.1:8000';

export const OIDC_CONFIG = {
    authority: 'https://your-keycloak-server/realms/my-realm', // Same as OIDC_ISSUER_URL in backend
    client_id: 'my-client-id', // Same as OIDC_CLIENT_ID in backend
    redirect_uri: 'http://localhost:8080/', // The URL where this app is running
    scope: 'openid profile email',
    response_type: 'code',
};
```

c. **Serve the frontend files**:

You can use a simple Python web server for development. From the project's root directory:

```bash
python3 -m http.server 8080 --directory frontend
```

Now, open your browser and navigate to `http://localhost:8080`.