# Contributing to MosBot API

Thank you for your interest in contributing to MosBot API! This document provides guidelines and instructions for contributing.

## 🌳 Branching Strategy

- **`master`** - Production-ready code
- **`develop`** - Main development branch
- **`feature/*`** - Feature branches (e.g., `feature/add-notifications`)
- **`bugfix/*`** - Bug fix branches (e.g., `bugfix/fix-auth-token`)
- **`hotfix/*`** - Emergency production fixes

## 🔄 Workflow

1. **Never commit directly to `master` or `develop`**
2. Always create a feature branch from `develop`
3. Make your changes in the feature branch
4. Open a Pull Request to `develop` branch
5. Wait for review and approval
6. Merge after approval

## 📝 Creating a Feature Branch

```bash
# Fetch latest changes
git checkout develop
git pull origin develop

# Create feature branch
git checkout -b feature/your-feature-name

# Make your changes
# ...

# Commit your changes
git add .
git commit -m "feat: add your feature description"

# Push to remote
git push origin feature/your-feature-name
```

## 📋 Pull Request Guidelines

### Title Format
Use conventional commit format in PR title:
- `feat: Add new feature`
- `fix: Fix bug in authentication`
- `docs: Update API documentation`
- `refactor: Refactor task routes`
- `test: Add tests for user service`
- `chore: Update dependencies`

### Description Template
```markdown
## Description
Brief description of what this PR does.

## Changes
- Change 1
- Change 2
- Change 3

## Testing
- [ ] Tested locally
- [ ] Added/updated tests
- [ ] Manual testing steps performed

## Related Issues
Closes #123
```

## 🧪 Testing

Before submitting a PR:

1. **Run tests** (when available)
   ```bash
   npm test
   ```

2. **Test manually**
   ```bash
   # Start the development server
   npm run dev
   
   # Test key endpoints
   curl http://localhost:3000/health
   ```

3. **Check for linting errors** (when configured)
   ```bash
   npm run lint
   ```

## 📐 Code Style

- Use **2 spaces** for indentation
- Use **meaningful variable names**
- Add **comments** for complex logic
- Follow **existing code patterns**
- Keep functions **small and focused**
- Use **async/await** instead of callbacks

### Example

```javascript
// Good
async function getUserById(userId) {
  const result = await pool.query(
    'SELECT id, name, email FROM users WHERE id = $1',
    [userId]
  );
  
  if (result.rows.length === 0) {
    throw new Error('User not found');
  }
  
  return result.rows[0];
}

// Bad
function getUser(id, callback) {
  pool.query('SELECT * FROM users WHERE id = ' + id, (err, res) => {
    if (err) callback(err);
    else callback(null, res.rows[0]);
  });
}
```

## 🔒 Security Guidelines

1. **Never commit secrets** - Use environment variables
2. **Use parameterized queries** - Prevent SQL injection
3. **Hash passwords** - Always use bcrypt
4. **Validate input** - Check all user input
5. **Use HTTPS** - In production environments
6. **Rate limit** - Protect against abuse

## 📁 Project Structure

When adding new features, follow the existing structure:

```
src/
├── db/              # Database-related files
│   ├── pool.js      # Connection pool
│   ├── migrate.js   # Migration runner
│   └── schema.sql   # Schema definition
├── routes/          # Route handlers
│   ├── auth.js      # Authentication
│   ├── tasks.js     # Task endpoints
│   ├── users.js     # User endpoints
│   └── activity.js  # Activity endpoints
└── index.js         # Main app file
```

## 🐛 Reporting Bugs

1. **Check existing issues** first
2. **Create a new issue** with:
   - Clear title
   - Detailed description
   - Steps to reproduce
   - Expected vs actual behavior
   - Environment details (Node version, OS, etc.)

## 💡 Suggesting Features

1. **Check existing issues** first
2. **Create a feature request** with:
   - Clear title
   - Problem statement
   - Proposed solution
   - Alternative solutions considered
   - Additional context

## 🚀 Release Process

1. Features merged to `develop`
2. Create release branch from `develop`
3. Test thoroughly
4. Merge to `master`
5. Tag release with version
6. Deploy to production

## ⚖️ License

By contributing, you agree that your contributions will be licensed under the MIT License.

## 🙏 Thank You!

Your contributions make MosBot better for everyone!
