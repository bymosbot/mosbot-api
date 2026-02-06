# MosBot API

![CI/CD](https://github.com/mosufy/mosbot-api/workflows/CI%2FCD%20Pipeline/badge.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)

Self-hosted task management API backend for MosBot - A personal productivity system running on your own infrastructure.

## 🚀 Features

- **RESTful API** - Clean, predictable endpoints following REST principles
- **Task Management** - Full CRUD operations for tasks with status tracking
- **User Management** - User accounts with secure authentication
- **Activity Logging** - Track all activities and events
- **JWT Authentication** - Secure token-based authentication
- **PostgreSQL Database** - Reliable, production-ready data persistence
- **OpenClaw Integration** - Access OpenClaw workspace files via HTTP API
- **Kubernetes-Ready** - Production-grade K8s manifests with GitOps support
- **Docker Support** - Multi-stage builds for efficient containerization
- **Self-Hosted First** - No vendor lock-in, runs entirely on your infrastructure

## 📋 Prerequisites

- **Node.js** >= 18.0.0
- **PostgreSQL** >= 13
- **Docker** (optional, for containerized deployment)
- **Kubernetes** (optional, for K8s deployment)

## 🛠️ Installation

### Local Development

1. **Clone the repository**

   ```bash
   git clone https://github.com/mosufy/mosbot-api.git
   cd mosbot-api
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Configure environment**

   ```bash
   cp .env.example .env
   # Edit .env with your database credentials and configuration
   ```

4. **Run database migrations**

   ```bash
   npm run migrate
   ```

5. **Reset database (optional)**

   To force a complete reset of the database (drops all tables and re-runs migrations):

   ```bash
   npm run db:reset
   ```

   **Safety Features:**
   - **Development:** Requires typing "yes" to confirm
   - **Production:** Requires `--force` flag AND multiple confirmations:

     ```bash
     npm run db:reset -- --force
     ```

     You'll be prompted to:
     1. Type "RESET PRODUCTION" (all caps)
     2. Type the database name to confirm
   - **Production Detection:** Automatically detects production environments based on:
     - `NODE_ENV=production`
     - Database name containing "prod" or "production"
     - Database host that's not localhost

   **Warning:** This will delete all data in the database!

   **For Docker Compose users:** You can also reset by removing the PostgreSQL volume:

   ```bash
   docker-compose down -v
   docker-compose up -d
   npm run migrate
   ```

6. **Start the server**

   ```bash
   # Development mode with hot reload
   npm run dev
   
   # Production mode
   npm start
   ```

7. **Configure OpenClaw Integration (Optional)**

   The OpenClaw workspace integration is disabled by default in local development. To enable it:

   **Option A: Use port-forwarding** (recommended for testing)

   ```bash
   # In a separate terminal, port-forward the OpenClaw workspace service
   # Replace <openclaw-personal> with your OpenClaw namespace (e.g., agents, openclaw-personal)
   kubectl port-forward -n openclaw-personal svc/openclaw-workspace 8080:8080
   ```

   Then in your `.env` file:

   ```bash
   OPENCLAW_WORKSPACE_URL=http://localhost:8080
   ```

   **Option B: Disable** (default)

   Leave `OPENCLAW_WORKSPACE_URL` empty or unset in your `.env` file.

8. **Verify health**

   ```bash
   curl http://localhost:3000/health
   ```

## 🐳 Docker Deployment

### Build the image

```bash
docker build -t mosbot-api:latest .
```

### Run with Docker Compose

```bash
docker-compose up -d
```

### Push to registry

```bash
docker tag mosbot-api:latest ghcr.io/mosufy/mosbot-api:latest
docker push ghcr.io/mosufy/mosbot-api:latest
```

### Multi-platform build (Kubernetes / mixed architectures)

If you see **"no match for platform in manifest"** when pulling on a cluster, the image was built for a different CPU architecture (e.g. ARM64 on Apple Silicon) than the cluster nodes (often AMD64). Build and push a multi-platform image so both work:

```bash
# Create and use a buildx builder (once per machine)
docker buildx create --use 2>/dev/null || true

# Build for linux/amd64 and linux/arm64, then push
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/mosufy/mosbot-api:latest --push .
```

After this, `ghcr.io/mosufy/mosbot-api:latest` will have both variants; the cluster will pull the matching platform automatically.

## ☸️ Kubernetes Deployment

### Using Kustomize

The repository includes production-ready Kubernetes manifests using Kustomize.

1. **Create secrets**

   ```bash
   cd k8s/base
   cp secret.template.yaml secret.yaml
   # Edit secret.yaml with base64-encoded values
   ```

2. **Deploy to development**

   ```bash
   kubectl apply -k k8s/base
   ```

3. **Deploy to production**

   ```bash
   kubectl apply -k k8s/overlays/production
   ```

### GitOps with ArgoCD

This project follows the homelab-gitops pattern. To deploy with ArgoCD:

1. Add the manifests to your GitOps repository
2. Create an ArgoCD Application pointing to the manifests
3. ArgoCD will automatically sync and deploy changes

See `k8s/` directory for manifest structure.

## 📚 API Documentation

### OpenClaw Integration

#### Public API

- **Public API Contract**: [`docs/api/openclaw-public-api.md`](docs/api/openclaw-public-api.md) - Task management API for OpenClaw

#### Workspace Integration (Implementation Complete)

- **Quick Start**: [`docs/implementations/openclaw-workspace/quickstart.md`](docs/implementations/openclaw-workspace/quickstart.md) - Get workspace access running in 15 minutes
- **Integration Guide**: [`docs/implementations/openclaw-workspace/integration-guide.md`](docs/implementations/openclaw-workspace/integration-guide.md) - Complete technical guide
- **Architecture**: [`docs/implementations/openclaw-workspace/ARCHITECTURE_DIAGRAM.md`](docs/implementations/openclaw-workspace/ARCHITECTURE_DIAGRAM.md) - Visual diagrams
- **Implementation Summary**: [`docs/implementations/openclaw-workspace/IMPLEMENTATION_SUMMARY.md`](docs/implementations/openclaw-workspace/IMPLEMENTATION_SUMMARY.md) - Overview and roadmap
- **Setup Complete**: [`docs/implementations/openclaw-workspace/SETUP_COMPLETE.md`](docs/implementations/openclaw-workspace/SETUP_COMPLETE.md) - Deployment checklist

#### Design Proposals

- **Adapter Interface**: [`docs/proposals/adapter-interface-proposal.md`](docs/proposals/adapter-interface-proposal.md) - Generic adapter design proposal

### Operational Guides

- **Database Migrations**: [`docs/guides/migration-guide.md`](docs/guides/migration-guide.md) - How to run database migrations

### Base URL

```bash
http://localhost:3000/api/v1
```

### Authentication

Most endpoints require JWT authentication. Include the token in the Authorization header:

```bash
Authorization: Bearer <your-jwt-token>
```

### Endpoints

#### Authentication Endpoints

- **POST** `/api/v1/auth/register` - Register a new user
- **POST** `/api/v1/auth/login` - Login and receive JWT token
- **POST** `/api/v1/auth/verify` - Verify JWT token validity

#### Tasks

- **GET** `/api/v1/tasks` - List all tasks (supports filtering)
- **GET** `/api/v1/tasks/:id` - Get a single task
- **POST** `/api/v1/tasks` - Create a new task
- **PUT** `/api/v1/tasks/:id` - Update a task
- **PATCH** `/api/v1/tasks/:id` - Partial update a task
- **DELETE** `/api/v1/tasks/:id` - Delete a task

#### Users

- **GET** `/api/v1/users` - List all users
- **GET** `/api/v1/users/:id` - Get a single user
- **POST** `/api/v1/users` - Create a new user
- **PUT** `/api/v1/users/:id` - Update a user
- **PATCH** `/api/v1/users/:id` - Partial update a user
- **DELETE** `/api/v1/users/:id` - Delete a user

#### Activity Logs

- **GET** `/api/v1/activity` - List all activity logs
- **GET** `/api/v1/activity/:id` - Get a single activity log

#### OpenClaw Workspace

- **GET** `/api/v1/openclaw/workspace/files` - List workspace files
- **GET** `/api/v1/openclaw/workspace/files/content` - Read file content
- **POST** `/api/v1/openclaw/workspace/files` - Create file
- **PUT** `/api/v1/openclaw/workspace/files` - Update file
- **DELETE** `/api/v1/openclaw/workspace/files` - Delete file
- **GET** `/api/v1/openclaw/workspace/status` - Get workspace status
- **POST** `/api/v1/activity` - Create a new activity log
- **PUT** `/api/v1/activity/:id` - Update an activity log
- **PATCH** `/api/v1/activity/:id` - Partial update an activity log
- **DELETE** `/api/v1/activity/:id` - Delete an activity log

### Example Requests

#### Register a new user

```bash
curl -X POST http://localhost:3000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "name": "John Doe",
    "email": "john@example.com",
    "password": "securepassword123"
  }'
```

#### Login

```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "john@example.com",
    "password": "securepassword123"
  }'
```

#### Create a task

```bash
curl -X POST http://localhost:3000/api/v1/tasks \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-token>" \
  -d '{
    "title": "Complete API documentation",
    "summary": "Write comprehensive API docs for MosBot",
    "status": "IN PROGRESS",
    "priority": "High",
    "assignee_id": "<user-uuid>"
  }'
```

#### List tasks with filters

```bash
# Get all high priority tasks
curl http://localhost:3000/api/v1/tasks?priority=High

# Get tasks by status
curl http://localhost:3000/api/v1/tasks?status=IN%20PROGRESS

# Get tasks assigned to a specific user
curl http://localhost:3000/api/v1/tasks?assignee_id=<user-uuid>
```

## 🔧 Configuration

### Environment Variables

| Variable | Description | Default |
| -------- | ----------- | ------- |
| `PORT` | Server port | `3000` |
| `NODE_ENV` | Environment (development/production) | `development` |
| `DB_HOST` | PostgreSQL host | `localhost` |
| `DB_PORT` | PostgreSQL port | `5432` |
| `DB_NAME` | Database name | `mosbot` |
| `DB_USER` | Database user | `mosbot` |
| `DB_PASSWORD` | Database password | - |
| `JWT_SECRET` | JWT signing secret | - |
| `JWT_EXPIRES_IN` | JWT expiration time | `7d` |
| `CORS_ORIGIN` | Allowed CORS origins | `*` |

## 🗄️ Database Schema

The application uses PostgreSQL with the following main tables:

- **users** - User accounts and authentication
- **tasks** - Task management with status tracking
- **activity_logs** - Activity and event logging
- **task_logs** - Per-task history and audit trail

### Database Constraints

The database includes comprehensive constraints for data integrity:

- **Tags Validation**: Maximum 20 tags, 50 chars each, lowercase only, no empty tags
- **Email Format**: Basic email format validation
- **Status Consistency**: `done_at` and `archived_at` must align with task status
- **Date Validation**: Completion/archive dates must be after creation date
- **String Validation**: Non-empty titles and user names

All constraints are defined in `src/db/schema.sql` and applied automatically during migration.

**Test constraints**:

```bash
node src/db/test-constraints.js
```

See `docs/guides/database-constraints-guide.md` for detailed constraint documentation and `src/db/schema.sql` for the complete schema definition.

## 🧪 Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run linter
npm run lint

# Run linter with auto-fix
npm run lint:fix

# Run linter for CI/CD (fails on warnings)
npm run lint:check
```

## 🔒 Security

- **Password hashing** with bcrypt (10 salt rounds)
- **JWT tokens** for stateless authentication
- **SQL injection protection** via parameterized queries
- **Rate limiting** on API endpoints (100 requests per 15 minutes)
- **Helmet.js** for security headers
- **CORS configuration** for cross-origin protection
- **Non-root container** execution
- **Read-only root filesystem** support (with temp directory)

## 📦 Project Structure

```bash
mosbot-api/
├── src/
│   ├── db/
│   │   ├── pool.js           # Database connection pool
│   │   ├── migrate.js        # Migration runner
│   │   └── schema.sql        # Database schema
│   ├── routes/
│   │   ├── auth.js           # Authentication endpoints
│   │   ├── tasks.js          # Task CRUD endpoints
│   │   ├── users.js          # User CRUD endpoints
│   │   └── activity.js       # Activity log endpoints
│   └── index.js              # Express app entry point
├── k8s/
│   ├── base/                 # Base Kubernetes manifests
│   └── overlays/             # Environment-specific overlays
├── .github/
│   └── workflows/
│       └── ci.yml            # GitHub Actions CI/CD
├── Dockerfile                # Multi-stage Docker build
├── package.json              # Node.js dependencies
└── README.md                 # This file
```

## 🚦 CI/CD

The project includes a GitHub Actions workflow that:

1. **Lints and tests** code on every push and PR
2. **Builds and pushes** Docker images to GitHub Container Registry
3. **Scans for vulnerabilities** using Trivy
4. **Tags images** with branch name, commit SHA, and semantic versions

The workflow runs automatically on:

- Push to `develop` or `master` branches
- Pull requests to `develop` or `master` branches

## 🤝 Contributing

This is a personal project, but contributions are welcome!

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request to `develop` branch

**Important:** Never commit directly to the repository. Always create a feature branch and open a PR for review.

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🙏 Acknowledgments

- Built with [Express.js](https://expressjs.com/)
- Database powered by [PostgreSQL](https://www.postgresql.org/)
- Containerized with [Docker](https://www.docker.com/)
- Deployed on [Kubernetes](https://kubernetes.io/)
- Part of the MosBot ecosystem

## 📞 Support

For issues and questions:

- Open an issue on GitHub
- Check existing documentation
- Review the API examples above

## 🗺️ Roadmap

- [ ] Add comprehensive test coverage
- [ ] Implement WebSocket support for real-time updates
- [ ] Add task comments and attachments
- [ ] Implement task dependencies and subtasks
- [ ] Add task templates
- [ ] Implement notifications system
- [ ] Add API rate limiting per user
- [ ] Add API usage analytics
- [ ] Implement backup and restore functionality
- [ ] Add Prometheus metrics export

---

Built with ❤️ for self-hosted productivity.
