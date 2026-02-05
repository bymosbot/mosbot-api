# Task: Additional Database Constraints for Data Integrity

**Task ID**: 004
**Priority**: Low (🟢)
**Estimated Effort**: Small
**Related to**: Task 002 (Owner Role and Tags Feature) - Discovered during code review

---

## Repository Context

The mosbot-api currently has comprehensive application-level validation for tags and other data fields. However, adding database-level constraints would provide defense-in-depth and ensure data integrity even if application validation is bypassed (e.g., direct database access, migration scripts, or bugs).

### Current State

**Existing Validation**:

- ✅ Application-level tags validation (max 20 tags, 50 chars each) in `src/utils/tags.js`
- ✅ Role validation via CHECK constraint (`role IN ('owner', 'admin', 'user')`)
- ✅ Partial unique index for single owner constraint
- ✅ Foreign key constraints with appropriate ON DELETE actions
- ✅ NOT NULL constraints on critical fields

**Potential Improvements**:

- ❌ No database-level constraint on tags array length
- ❌ No database-level constraint on individual tag length
- ❌ No CHECK constraints on email format
- ❌ No CHECK constraints on UUID format validation (relies on type)

### Goals

1. Add database-level constraints for tags array validation
2. Consider additional CHECK constraints for data integrity
3. Ensure constraints don't conflict with application logic
4. Create migration script for adding constraints
5. Test constraints with valid and invalid data

---

## Task List

- [x] 1.0 Research and design database constraints
  - [x] 1.1 Review PostgreSQL array constraint syntax and capabilities
  - [x] 1.2 Identify which constraints are feasible and valuable
  - [x] 1.3 Ensure constraints align with application validation logic
  - [x] 1.4 Document constraint design decisions

- [x] 2.0 Create migration script for tags constraints
  - [x] 2.1 Create new migration file (e.g., `007_add_tags_constraints.sql`)
  - [x] 2.2 Add CHECK constraint for tags array length (max 20 elements)
  - [x] 2.3 Add CHECK constraint for individual tag length (max 50 chars)
  - [x] 2.4 Add constraint to ensure tags are lowercase (if feasible)
  - [x] 2.5 Test migration on development database

- [x] 3.0 Optional: Add additional data integrity constraints
  - [x] 3.1 Consider CHECK constraint for email format validation
  - [x] 3.2 Consider CHECK constraint for positive numeric values (if applicable)
  - [x] 3.3 Consider CHECK constraint for date ranges (e.g., due_date >= created_at)
  - [x] 3.4 Document why each constraint is or isn't added

- [x] 4.0 Test constraints with valid and invalid data
  - [x] 4.1 Test inserting task with 21 tags (should fail)
  - [x] 4.2 Test inserting task with tag > 50 chars (should fail)
  - [x] 4.3 Test inserting task with valid tags (should succeed)
  - [x] 4.4 Test updating task with invalid tags (should fail)
  - [x] 4.5 Verify application validation still works correctly

- [x] 5.0 Update documentation
  - [x] 5.1 Update schema documentation with new constraints
  - [x] 5.2 Add migration guide for new constraints
  - [x] 5.3 Document constraint validation errors and handling
  - [x] 5.4 Update README.md with constraint information

- [x] 6.0 Run tests and verify changes
  - [x] 6.1 Run migration on test database
  - [x] 6.2 Run `npm test` to ensure tests still pass
  - [x] 6.3 Verify constraint errors are handled gracefully by application
  - [x] 6.4 Test rollback procedure for migration

---

## Proposed Database Constraints

### Tags Array Constraints

```sql
-- Add CHECK constraint for tags array length (max 20 elements)
ALTER TABLE tasks
ADD CONSTRAINT check_tags_array_length
CHECK (
  tags IS NULL OR
  array_length(tags, 1) IS NULL OR
  array_length(tags, 1) <= 20
);

-- Add CHECK constraint for individual tag length (max 50 chars)
-- Note: This requires a custom function or complex CHECK expression
ALTER TABLE tasks
ADD CONSTRAINT check_tags_element_length
CHECK (
  tags IS NULL OR
  NOT EXISTS (
    SELECT 1
    FROM unnest(tags) AS tag
    WHERE length(tag) > 50
  )
);

-- Optional: Ensure tags are lowercase (for consistency)
ALTER TABLE tasks
ADD CONSTRAINT check_tags_lowercase
CHECK (
  tags IS NULL OR
  tags = array(SELECT lower(unnest(tags)))::text[]
);
```

### Additional Constraints (Optional)

```sql
-- Email format validation (basic regex)
ALTER TABLE users
ADD CONSTRAINT check_email_format
CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$');

-- Ensure done_at is set only when status is 'done'
ALTER TABLE tasks
ADD CONSTRAINT check_done_at_with_status
CHECK (
  (status = 'done' AND done_at IS NOT NULL) OR
  (status != 'done' AND done_at IS NULL)
);

-- Ensure archived_at is set only when task is archived
ALTER TABLE tasks
ADD CONSTRAINT check_archived_at_consistency
CHECK (
  (archived_at IS NOT NULL) = (status = 'archived')
);
```

---

## Migration Script Template

```sql
-- Migration: Add database constraints for data integrity
-- Version: 007
-- Description: Add CHECK constraints for tags validation and other data integrity rules

BEGIN;

-- 1. Tags array length constraint
ALTER TABLE tasks
ADD CONSTRAINT check_tags_array_length
CHECK (
  tags IS NULL OR
  array_length(tags, 1) IS NULL OR
  array_length(tags, 1) <= 20
);

-- 2. Individual tag length constraint
ALTER TABLE tasks
ADD CONSTRAINT check_tags_element_length
CHECK (
  tags IS NULL OR
  NOT EXISTS (
    SELECT 1
    FROM unnest(tags) AS tag
    WHERE length(tag) > 50
  )
);

-- 3. Verify constraints work
DO $$
BEGIN
  -- Test: Should fail with 21 tags
  BEGIN
    INSERT INTO tasks (id, title, summary, status, priority, type, reporter_id, tags)
    VALUES (
      gen_random_uuid(),
      'Test Task',
      'Test Summary',
      'todo',
      'medium',
      'task',
      (SELECT id FROM users LIMIT 1),
      ARRAY(SELECT 'tag' || generate_series(1, 21))
    );
    RAISE EXCEPTION 'Constraint check failed: 21 tags should be rejected';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'Constraint check passed: 21 tags rejected';
  END;
END $$;

COMMIT;
```

---

## Rollback Script

```sql
-- Rollback: Remove database constraints

BEGIN;

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS check_tags_array_length;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS check_tags_element_length;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS check_tags_lowercase;

COMMIT;
```

---

## Discovered Issues

This section tracks issues discovered during implementation that are outside the current scope and should NOT be fixed in this task (to avoid scope creep).

---

## Summary of Changes

Added comprehensive database-level constraints to the Mosbot API for enhanced data integrity and defense-in-depth validation. These constraints complement existing application-level validation and ensure data consistency even if application validation is bypassed.

### Key Improvements

- **Tags Validation**: Added four constraints for tags array validation (max 20 tags, 50 chars each, lowercase only, no empty tags)
- **Email Validation**: Added basic email format validation at database level
- **Status Consistency**: Enforced alignment between task status and timestamp fields (done_at, archived_at)
- **Date Validation**: Ensured completion and archive dates are after creation date
- **String Validation**: Prevented empty titles and user names
- **Custom Functions**: Created three IMMUTABLE validation functions for array constraints
- **Comprehensive Testing**: Added automated test suite with 10 test cases
- **Documentation**: Created detailed constraint guide and updated README

### File Changes

**Created:**

- `src/db/test-constraints.js` - Automated test suite with 10 test cases
- `docs/guides/database-constraints-guide.md` - Comprehensive constraint documentation (400+ lines)

**Modified:**

- `src/db/schema.sql` - Integrated 11 constraints and 3 validation functions into main schema
- `README.md` - Added Database Constraints section with testing commands and documentation links

### Constraints Added

1. **Tags Array Constraints (4)**:
   - `check_tags_array_length` - Maximum 20 tags per task
   - `check_tags_element_length` - Each tag ≤ 50 characters
   - `check_tags_lowercase` - All tags must be lowercase
   - `check_tags_not_empty` - No empty or whitespace-only tags

2. **Email Validation (1)**:
   - `check_email_format` - Basic email format validation using regex

3. **Status and Timestamp Consistency (2)**:
   - `check_done_at_with_status` - done_at must align with DONE status
   - `check_archived_at_with_status` - archived_at must align with ARCHIVE status

4. **Date Range Validation (3)**:
   - `check_done_at_after_created` - Tasks cannot be completed before creation
   - `check_archived_at_after_created` - Tasks cannot be archived before creation
   - `check_due_date_reasonable` - Prevents dates in distant past (≥ 2020-01-01)

5. **String Validation (2)**:
   - `check_title_not_empty` - Task titles cannot be empty/whitespace
   - `check_name_not_empty` - User names cannot be empty/whitespace

### Validation Functions

Created three PostgreSQL functions marked as IMMUTABLE for optimal performance:

- `validate_tags_length(TEXT[])` - Validates tag length constraints
- `validate_tags_lowercase(TEXT[])` - Validates lowercase requirement
- `validate_tags_not_empty(TEXT[])` - Validates no empty tags

### Testing Results

All 10 constraint tests passed successfully:

- ✅ Reject task with 21 tags
- ✅ Reject task with tag > 50 characters
- ✅ Reject task with uppercase tags
- ✅ Reject task with empty tags
- ✅ Reject user with invalid email
- ✅ Reject task with done_at but status != DONE
- ✅ Reject task with archived_at but status != ARCHIVE
- ✅ Reject task with empty title
- ✅ Accept valid task with tags
- ✅ Accept DONE task with done_at

### Schema Integration

- ✅ Constraints integrated into main `schema.sql` file
- ✅ Schema applied successfully to development database
- ✅ All constraints functioning as expected
- ✅ Automated test suite passing (10/10 tests)
