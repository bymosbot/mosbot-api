# Database Constraints Guide

This guide documents the database-level constraints added to the Mosbot API for enhanced data integrity.

## Overview

Database constraints provide defense-in-depth by enforcing data validation rules at the database level, complementing application-level validation. These constraints ensure data integrity even if:

- Application validation is bypassed
- Direct database access occurs
- Migration scripts insert data
- Bugs in application code exist

## Constraint Categories

### 1. Tags Array Constraints

Enforces validation rules for task tags that align with application validation in `src/utils/tags.js`.

#### Maximum Array Length

```sql
ALTER TABLE tasks
ADD CONSTRAINT check_tags_array_length
CHECK (
  tags IS NULL OR
  array_length(tags, 1) IS NULL OR
  array_length(tags, 1) <= 20
);
```

**Purpose**: Limits tasks to a maximum of 20 tags.

**Error Example**:

```text
ERROR: new row for relation "tasks" violates check constraint "check_tags_array_length"
```

#### Individual Tag Length

```sql
ALTER TABLE tasks
ADD CONSTRAINT check_tags_element_length
CHECK (validate_tags_length(tags));
```

**Purpose**: Ensures each tag is 50 characters or less.

**Implementation**: Uses the `validate_tags_length()` function to iterate through all tags.

#### Lowercase Enforcement

```sql
ALTER TABLE tasks
ADD CONSTRAINT check_tags_lowercase
CHECK (validate_tags_lowercase(tags));
```

**Purpose**: Ensures all tags are lowercase for consistency.

**Rationale**: Prevents case-sensitivity issues and duplicate tags with different cases.

#### No Empty Tags

```sql
ALTER TABLE tasks
ADD CONSTRAINT check_tags_not_empty
CHECK (validate_tags_not_empty(tags));
```

**Purpose**: Prevents empty or whitespace-only tags.

### 2. Email Format Validation

```sql
ALTER TABLE users
ADD CONSTRAINT check_email_format
CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$');
```

**Purpose**: Basic email format validation using regex.

**Note**: This is a basic check. Application-level validation should perform more comprehensive email validation.

### 3. Task Status and Timestamp Consistency

#### done_at with Status

```sql
ALTER TABLE tasks
ADD CONSTRAINT check_done_at_with_status
CHECK (
  (status = 'DONE' AND done_at IS NOT NULL) OR
  (status != 'DONE' AND done_at IS NULL)
);
```

**Purpose**: Ensures `done_at` is set if and only if status is 'DONE'.

**Business Rule**: A task can only have a completion timestamp when marked as done.

#### archived_at with Status

```sql
ALTER TABLE tasks
ADD CONSTRAINT check_archived_at_with_status
CHECK (
  (status = 'ARCHIVE' AND archived_at IS NOT NULL) OR
  (status != 'ARCHIVE' AND archived_at IS NULL)
);
```

**Purpose**: Ensures `archived_at` is set if and only if status is 'ARCHIVE'.

**Business Rule**: A task can only have an archive timestamp when marked as archived.

### 4. Date Range Validation

#### done_at After created_at

```sql
ALTER TABLE tasks
ADD CONSTRAINT check_done_at_after_created
CHECK (
  done_at IS NULL OR
  done_at >= created_at
);
```

**Purpose**: Tasks cannot be completed before they are created.

#### archived_at After created_at

```sql
ALTER TABLE tasks
ADD CONSTRAINT check_archived_at_after_created
CHECK (
  archived_at IS NULL OR
  archived_at >= created_at
);
```

**Purpose**: Tasks cannot be archived before they are created.

#### Reasonable due_date

```sql
ALTER TABLE tasks
ADD CONSTRAINT check_due_date_reasonable
CHECK (
  due_date IS NULL OR
  due_date >= '2020-01-01'::timestamp
);
```

**Purpose**: Prevents accidental entry of dates in the distant past.

**Note**: The 2020-01-01 threshold can be adjusted based on business requirements.

### 5. String Length Validation

#### Non-Empty Task Title

```sql
ALTER TABLE tasks
ADD CONSTRAINT check_title_not_empty
CHECK (trim(title) != '');
```

**Purpose**: Every task must have a meaningful title (not just whitespace).

#### Non-Empty User Name

```sql
ALTER TABLE users
ADD CONSTRAINT check_name_not_empty
CHECK (trim(name) != '');
```

**Purpose**: Every user must have a name (not just whitespace).

## Validation Functions

### validate_tags_length(tags TEXT[])

Validates that all tags in the array are 50 characters or less.

```sql
CREATE OR REPLACE FUNCTION validate_tags_length(tags TEXT[])
RETURNS BOOLEAN AS $$
BEGIN
  IF tags IS NULL THEN
    RETURN TRUE;
  END IF;
  
  FOR i IN 1..array_length(tags, 1) LOOP
    IF length(tags[i]) > 50 THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
```

### validate_tags_lowercase(tags TEXT[])

Validates that all tags are lowercase.

```sql
CREATE OR REPLACE FUNCTION validate_tags_lowercase(tags TEXT[])
RETURNS BOOLEAN AS $$
BEGIN
  IF tags IS NULL THEN
    RETURN TRUE;
  END IF;
  
  FOR i IN 1..array_length(tags, 1) LOOP
    IF tags[i] != lower(tags[i]) THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
```

### validate_tags_not_empty(tags TEXT[])

Validates that no tags are empty or whitespace-only.

```sql
CREATE OR REPLACE FUNCTION validate_tags_not_empty(tags TEXT[])
RETURNS BOOLEAN AS $$
BEGIN
  IF tags IS NULL THEN
    RETURN TRUE;
  END IF;
  
  FOR i IN 1..array_length(tags, 1) LOOP
    IF trim(tags[i]) = '' THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
```

## Schema Integration

All database constraints are integrated into the main schema file (`src/db/schema.sql`) and are applied automatically when you run the database migration.

### Applying Schema with Constraints

```bash
# Run the standard migration (includes all constraints)
npm run migrate
```

### Testing Constraints

```bash
# Run constraint tests to verify all constraints are working
node src/db/test-constraints.js
```

### Fresh Database Setup

```bash
# Reset database and apply schema with constraints
npm run db:reset
```

## Error Handling

### Application-Level Handling

When a constraint violation occurs, PostgreSQL returns error code `23514` (check_violation). Your application should handle these errors gracefully:

```javascript
try {
  await pool.query(
    'INSERT INTO tasks (title, status, reporter_id, tags) VALUES ($1, $2, $3, $4)',
    [title, status, reporterId, tags]
  );
} catch (error) {
  if (error.code === '23514') {
    // Check constraint violation
    return res.status(400).json({
      error: 'Data validation failed',
      message: 'The provided data does not meet database constraints'
    });
  }
  throw error;
}
```

### Common Error Codes

- `23514`: Check constraint violation
- `23505`: Unique constraint violation
- `23503`: Foreign key constraint violation
- `23502`: NOT NULL constraint violation

## Best Practices

1. **Application Validation First**: Always validate data at the application level before sending to the database. Database constraints are a safety net, not the primary validation mechanism.

2. **Consistent Validation**: Ensure application validation rules match database constraints to provide better user feedback.

3. **Graceful Error Handling**: Convert database constraint errors into user-friendly messages.

4. **Testing**: Test both valid and invalid data to ensure constraints work as expected.

5. **Documentation**: Keep constraint documentation up-to-date when adding or modifying constraints.

## Performance Considerations

- **IMMUTABLE Functions**: All validation functions are marked as `IMMUTABLE`, allowing PostgreSQL to optimize their execution.

- **Index Usage**: Constraints don't prevent index usage. The GIN index on `tags` column remains effective.

- **Insert/Update Performance**: Constraint checks add minimal overhead (typically < 1ms per operation).

## Maintenance

### Adding New Constraints

1. Create a new migration file with a sequential number
2. Add the constraint with a descriptive name
3. Include verification tests in the migration
4. Create a corresponding rollback script
5. Update this documentation

### Modifying Existing Constraints

1. Create a migration to drop the old constraint
2. Add the new constraint in the same migration
3. Test thoroughly with existing data
4. Update documentation

### Removing Constraints

1. Create a migration to drop the constraint
2. Update application code if it relies on the constraint
3. Update documentation

## Related Documentation

- [Migration Guide](./migration-guide.md)
- [Database Schema](../src/db/schema.sql)
- [Tags Utility](../src/utils/tags.js)

## Support

For questions or issues related to database constraints, please:

1. Check the error message and constraint name
2. Review this documentation
3. Check application validation logic
4. Open an issue with reproduction steps
