# Bunny Stream Migration

A Node.js script to automatically update Bunny Stream video library settings.

## Features

- Fetches all video libraries automatically.
- Enables premium encoding.
- Disables DRM.
- Enables JIT (Just-in-Time) encoding.
- Processes libraries sequentially.
- Handles API errors, retries transient failures, and logs a summary.

## Requirements

- Node.js 18 or later.
- A Bunny.net account API key with permission to list and update video libraries.

## Installation

```bash
npm install
```

## Configuration

Create a `.env` file in the project root:

```env
BUNNY_ACCOUNT_API_KEY=your_bunny_account_api_key
BUNNY_REQUEST_TIMEOUT_MS=20000
BUNNY_MAX_RETRIES=3
```

Replace `your_bunny_account_api_key` with your actual API key.

**Never commit your `.env` file to version control.**

## Usage

Run the migration:

```bash
npm run migrate
```

The script automatically fetches all available video libraries and processes each library in the following order:

1. Enable premium encoding.
2. Disable DRM.
3. Enable JIT encoding.
4. Move to the next library.

Each setting is updated independently. If one operation fails, the script logs the error and attempts the remaining operations.

## Migration Summary

After processing all libraries, the script displays a summary of:

- Total libraries found.
- Total libraries processed.
- Successful and failed premium encoding updates.
- Successful and failed DRM updates.
- Successful and failed JIT updates.

The process exits with a non-zero status if any updates fail.

## Important Notes

- Premium encoding and JIT encoding may affect your billing.
- JIT encoding requires premium encoding.
- Disabling DRM removes DRM protection from your content.
- Test the script with a single library before applying changes across all libraries.
- Review the logs and verify the settings in the Bunny dashboard after migration.

## Security

Keep your Bunny API key private. Do not hardcode credentials in the source code or commit them to Git.
