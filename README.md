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

5. **Start the server**
   ```bash
   # Development mode with hot reload
   npm run dev
   
   # Production mode
   npm start
   ```

6. **Verify health**
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

### Base URL
```
http://localhost:3000/api/v1
```

### Authentication

Most endpoints require JWT authentication. Include the token in the Authorization header:

```
Authorization: Bearer <your-jwt-token>
```

### Endpoints

#### Authentication

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
|----------|-------------|---------|
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

See `src/db/schema.sql` for the complete schema definition.

## 🧪 Testing

```bash
# Run tests (when implemented)
npm test

# Run linter (when configured)
npm run lint
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

```
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

**Built with ❤️ for self-hosted productivity**
