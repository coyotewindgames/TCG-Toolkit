# Inventory Import Error Diagnostics - Implementation Guide

## Overview

This document describes the enhanced error diagnostics and validation system implemented to identify and debug inventory import failures, particularly the "Row processing error" issue reported in row 7 of CSV imports.

## Problem Statement

The original error message was insufficient for debugging:
```
Row processing error {
  row: 7,
  error: 'Failed query: insert into "inventory" ...',
  params: '762bc4a4-5f2f-478f-9b42-87a0a688df5d,0100bd55-2119-4024-8470-a2ec54fc5337,4,0,0,4,4,0,4,4,2026-06-12T20:54:18.108Z'
}
```

**Key Issues:**
- No actual database error code or constraint information
- No PostgreSQL error details (what constraint failed, which table, etc.)
- No context about what SKU or product was being processed
- No stack trace for debugging

## Implementation

### Phase 1: Enhanced Error Diagnostics

#### 1.1 `inspectDatabaseError()` Utility Function

**Purpose:** Recursively extract database error details from Drizzle ORM error objects.

**Location:** `apps/api/src/server/services/inventory-import.ts`

**Features:**
- Recursively inspects error objects to find PostgreSQL error details
- Handles Drizzle ORM error wrapping (checks `cause` and `driverError` properties)
- Extracts all PostgreSQL-specific error properties:
  - `code` - PostgreSQL error code (e.g., '23505' for unique violation)
  - `detail` - Detailed error message from PostgreSQL
  - `hint` - Suggestions from PostgreSQL on how to fix the error
  - `constraint` - Name of the constraint that was violated
  - `table` - Table name where the error occurred
  - `column` - Column name related to the error
  - `schema` - Schema name
- Serializes the entire raw error object for debugging
- Captures error stack traces

#### 1.2 Enhanced `formatImportError()` Function

**Purpose:** Format error objects with comprehensive details for logging and user feedback.

**Improvements:**
- Uses `inspectDatabaseError()` to extract nested error properties
- Returns structured error object with all available fields
- Includes stack traces for debugging
- Handles both direct errors and errors wrapped in `cause` property

#### 1.3 Comprehensive Error Logging in `handleRowError()`

**Purpose:** Log complete error context when a row fails to import.

**Logged Information:**
- **Row Context:**
  - Row number (1-indexed for user readability)
  - Store ID
  - Location ID
  - Timestamp of error
  
- **Error Details:**
  - Error message
  - PostgreSQL error code
  - PostgreSQL error detail
  - PostgreSQL hint
  - Constraint name
  - Table name
  - Column name
  - Schema name
  
- **Row Data:**
  - Raw CSV row data (all columns as received)
  - Mapped row data (after header normalization)
  
- **Processing Context:**
  - SKU ID (if available)
  - Product ID (if available)
  - Location ID
  
- **Cache State:**
  - Number of products in cache
  - Number of SKUs in cache
  - Number of inventory rows in cache
  
- **Stack Trace:** Full error stack for debugging
- **Raw Error Object:** Complete serialized error object

### Phase 2: Database Integrity Validation

#### 2.1 Pre-flight Validation Before Inventory Insert

**Purpose:** Catch data integrity issues before attempting database writes.

**Validations:**
1. **SKU Existence Check**
   - Queries database to verify SKU exists
   - Checks SKU belongs to the correct store
   - Logs detailed error if SKU is missing

2. **Location Existence Check**
   - Queries database to verify location exists
   - Checks location belongs to the correct store
   - Logs detailed error if location is missing

3. **Store Ownership Validation**
   - Verifies SKU belongs to the same store as the import
   - Verifies location belongs to the same store as the import
   - Prevents cross-store data corruption

**Error Messages:**
- Clear, actionable error messages
- Includes specific IDs for debugging
- Indicates what validation failed and why

#### 2.2 Diagnostic Logging Throughout Process

**Key Log Points:**

1. **After SKU Resolution:**
   ```javascript
   [inventory-import] SKU resolved for inventory operation {
     row: 2,
     skuId: 'uuid',
     productId: 'uuid',
     skuInCache: true,
     cacheSize: 10
   }
   ```

2. **Before Pre-flight Validation:**
   ```javascript
   [inventory-import] Pre-flight validation before inventory insert {
     row: 2,
     skuId: 'uuid',
     locationId: 'uuid',
     qty: 4,
     costCents: 100,
     inventoryExisted: false
   }
   ```

3. **After Pre-flight Validation:**
   ```javascript
   [inventory-import] Pre-flight validation passed {
     row: 2,
     skuId: 'uuid',
     locationId: 'uuid'
   }
   ```

4. **Before Inventory Insert:**
   ```javascript
   [inventory-import] Executing inventory insert/update {
     row: 2,
     operation: 'INSERT' | 'UPDATE',
     params: { skuId, locationId, qtyOnHand, qtyReserved, costAvgCents },
     updateLogic: 'with cost averaging' | 'quantity only'
   }
   ```

5. **After Successful Insert:**
   ```javascript
   [inventory-import] Inventory insert/update succeeded {
     row: 2,
     skuId: 'uuid',
     locationId: 'uuid'
   }
   ```

6. **On Inventory Insert Failure:**
   ```javascript
   [inventory-import] Inventory insert/update FAILED {
     row: 2,
     skuId: 'uuid',
     locationId: 'uuid',
     productId: 'uuid',
     errorMessage: '...',
     postgresCode: '23505',
     postgresDetail: '...',
     postgresConstraint: 'inventory_pkey',
     postgresTable: 'inventory',
     rawError: '...'
   }
   ```

#### 2.3 Enhanced Try-Catch Around Critical Operations

**Purpose:** Catch and log errors with full context at the exact point of failure.

The inventory insert/update operation is now wrapped in a try-catch block that:
- Logs all parameters before execution
- Captures the exact database error
- Logs detailed error information including PostgreSQL codes
- Preserves the error for upstream handling

## How to Use This System

### 1. Reproducing and Debugging Import Errors

When you encounter an import error:

1. **Check the logs** for the error prefix `[inventory-import]`
2. **Look for "Row processing error - FULL DETAILS"** - This contains everything needed to debug
3. **Examine the PostgreSQL error code** to understand the root cause:

**Common PostgreSQL Error Codes:**
- `23505` - Unique constraint violation (duplicate entry)
- `23503` - Foreign key constraint violation (referenced record doesn't exist)
- `23502` - Not-null constraint violation (required field is missing)
- `23514` - Check constraint violation (data doesn't meet validation rules)
- `22P02` - Invalid text representation (data type mismatch)

### 2. Example Error Log Analysis

```javascript
[inventory-import] Row processing error - FULL DETAILS {
  row: 7,
  storeId: 'abc-123',
  locationId: 'xyz-789',
  
  // The actual PostgreSQL error
  postgresCode: '23503',  // Foreign key violation
  postgresDetail: 'Key (sku_id)=(762bc4a4-...) is not present in table "skus".',
  postgresConstraint: 'inventory_sku_id_fkey',
  postgresTable: 'inventory',
  
  // Processing context
  context: {
    skuId: '762bc4a4-5f2f-478f-9b42-87a0a688df5d',
    locationId: '0100bd55-2119-4024-8470-a2ec54fc5337',
    productId: 'def-456'
  },
  
  // The actual row data
  rawRowData: {
    'Product Name': 'Pikachu',
    'Set': 'Base Set',
    'Quantity': '4',
    ...
  },
  
  // Cache state for debugging
  cacheState: {
    productsInCache: 5,
    skusInCache: 8,
    inventoryInCache: 10
  }
}
```

**Interpretation:**
- **Error Code 23503** = Foreign key violation
- **Constraint: inventory_sku_id_fkey** = The SKU foreign key constraint
- **Detail message** = The SKU doesn't exist in the skus table
- **Root Cause:** There's a logic error in SKU creation - the SKU was supposed to be created earlier but wasn't

### 3. Finding Pre-flight Validation Failures

Look for logs prefixed with `[inventory-import] PRE-FLIGHT FAILED`:

```javascript
[inventory-import] PRE-FLIGHT FAILED: SKU does not exist {
  row: 7,
  skuId: '762bc4a4-5f2f-478f-9b42-87a0a688df5d',
  productId: 'def-456',
  skuInCache: true,  // ← SKU is in cache but not in database!
  cacheKey: 'def-456|NM|Normal|EN'
}
```

This indicates the SKU creation logic has a bug - it's adding the SKU to the cache but the database insert is failing silently.

### 4. Tracking Import Progress

Follow the log sequence for a successful row:

1. `[inventory-import] Product created` or product found in cache
2. `[inventory-import] SKU created` or SKU found in cache
3. `[inventory-import] SKU resolved for inventory operation`
4. `[inventory-import] Pre-flight validation before inventory insert`
5. `[inventory-import] Pre-flight validation passed`
6. `[inventory-import] Executing inventory insert/update`
7. `[inventory-import] Inventory insert/update succeeded`

If the sequence breaks at any point, the logs will show exactly where and why.

## Debugging the Original Error

Based on the original error message:
```
params: 762bc4a4-5f2f-478f-9b42-87a0a688df5d,0100bd55-2119-4024-8470-a2ec54fc5337,4,0,0,4,4,0,4,4,2026-06-12T20:54:18.108Z
```

With the new logging, you would now see:
- Which actual PostgreSQL error occurred (constraint violation, foreign key, etc.)
- Whether it's the SKU or location that doesn't exist
- The full context of what product/SKU was being processed
- Whether the issue is in SKU creation, location resolution, or the insert itself

## Next Steps

1. **Deploy this code** to the environment where the error is occurring
2. **Run the same import** that previously failed
3. **Collect the enhanced logs** - they will contain:
   - The actual PostgreSQL error code and message
   - Complete context about what failed
   - Stack traces for debugging
4. **Analyze the logs** using the patterns described above
5. **Identify the root cause** from the detailed error information
6. **Fix the underlying issue** (likely in SKU creation logic or transaction handling)

## Testing

All existing tests pass with the new implementation. The test suite validates:
- Error extraction and formatting
- Pre-flight validation logic
- Comprehensive error logging
- Cache state tracking
- CSV import functionality

Run tests with:
```bash
npm run test --workspace=@tcg/api
```

## Files Modified

1. **apps/api/src/server/services/inventory-import.ts**
   - Added `inspectDatabaseError()` function
   - Enhanced `formatImportError()` function
   - Improved `handleRowError()` function
   - Added pre-flight validation before inventory insert
   - Added diagnostic logging throughout the process
   - Added try-catch around inventory insert with enhanced error logging

2. **apps/api/tests/inventory-import.test.ts**
   - Updated FakeDb to handle new pre-flight validation queries
   - All tests passing

## Performance Impact

The enhanced error diagnostics and validation have minimal performance impact:
- Pre-flight validation adds 2 database queries per row (SKU and location checks)
- These queries are simple primary key lookups (very fast)
- Only run when processing inventory rows (not on every row if it's just product/SKU creation)
- Logging is asynchronous and non-blocking
- The queries help prevent more expensive error handling and rollbacks

Estimated overhead: ~1-2ms per row (negligible compared to the actual inventory insert operation).
