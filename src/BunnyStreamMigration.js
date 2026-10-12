import "dotenv/config";

class BunnyStreamMigration {
  constructor() {
    this.apiKey = process.env.BUNNY_ACCOUNT_API_KEY;
    this.baseUrl = "https://api.bunny.net";

    this.timeoutMs = Number(
      process.env.BUNNY_REQUEST_TIMEOUT_MS ?? 20000,
    );

    this.maxRetries = Number(
      process.env.BUNNY_MAX_RETRIES ?? 3,
    );

    this.pageSize = 100;

    this.summary = {
      librariesFound: 0,
      librariesProcessed: 0,
      premiumEncoding: { success: 0, failed: 0 },
      drmDisabled: { success: 0, failed: 0 },
      jitEnabled: { success: 0, failed: 0 },
      libraryErrors: 0,
    };

    if (!this.apiKey) {
      throw new Error(
        "Missing BUNNY_ACCOUNT_API_KEY in environment variables.",
      );
    }

    if (
      !Number.isFinite(this.timeoutMs) ||
      this.timeoutMs <= 0
    ) {
      throw new Error(
        "BUNNY_REQUEST_TIMEOUT_MS must be a positive number.",
      );
    }

    if (
      !Number.isInteger(this.maxRetries) ||
      this.maxRetries < 0
    ) {
      throw new Error(
        "BUNNY_MAX_RETRIES must be a non-negative integer.",
      );
    }
  }

  log(message) {
    console.log(
      `[${new Date().toISOString()}] ${message}`,
    );
  }

  logError(message, error) {
    console.error(
      `[${new Date().toISOString()}] ERROR: ${message}`,
      error?.message ?? error,
    );
  }

  /**
   * Performs an authenticated Bunny API request.
   * Retries timeouts, rate limits, and server errors.
   */
  async request(path, options = {}) {
    const url = `${this.baseUrl}${path}`;

    for (
      let attempt = 0;
      attempt <= this.maxRetries;
      attempt++
    ) {
      const controller = new AbortController();

      let timeout;

      try {
        timeout = setTimeout(
          () => controller.abort(),
          this.timeoutMs,
        );

        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
          headers: {
            AccessKey: this.apiKey,
            Accept: "application/json",
            ...(options.body
              ? { "Content-Type": "application/json" }
              : {}),
            ...options.headers,
          },
        });

        const responseText = await response.text();

        if (response.ok) {
          if (!responseText) return null;

          try {
            return JSON.parse(responseText);
          } catch {
            throw new Error(
              `Bunny returned invalid JSON for ${path}`,
            );
          }
        }

        const error = new Error(
          `HTTP ${response.status} ${response.statusText}: ` +
          `${responseText || "No response body"}`,
        );

        // Do not retry authentication, permission, or validation errors.
        const retryable =
          response.status === 429 ||
          response.status >= 500;

        if (!retryable || attempt === this.maxRetries) {
          throw error;
        }

        const retryAfter = Number(
          response.headers.get("retry-after"),
        );

        const delayMs =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : Math.min(1000 * 2 ** attempt, 10000);

        this.log(
          `Request failed with HTTP ${response.status}. ` +
          `Retrying in ${delayMs}ms ` +
          `(${attempt + 1}/${this.maxRetries}).`,
        );

        await new Promise((resolve) =>
          setTimeout(resolve, delayMs),
        );
      } catch (error) {
        const isAbort = error?.name === "AbortError";

        const retryable =
          isAbort ||
          error?.cause?.code === "ECONNRESET" ||
          error?.cause?.code === "ETIMEDOUT" ||
          error?.cause?.code === "ECONNREFUSED" ||
          error?.name === "TypeError";

        if (!retryable || attempt === this.maxRetries) {
          throw error;
        }

        const delayMs = Math.min(
          1000 * 2 ** attempt,
          10000,
        );

        this.log(
          `Request error: ${error.message}. ` +
          `Retrying in ${delayMs}ms ` +
          `(${attempt + 1}/${this.maxRetries}).`,
        );

        await new Promise((resolve) =>
          setTimeout(resolve, delayMs),
        );
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new Error(`Request failed: ${path}`);
  }

  /**
   * Fetches all video libraries, one page at a time.
   */
  async getAllLibraries() {
    const libraries = [];
    let page = 1;

    this.log("Fetching Bunny Stream libraries...");

    while (true) {
      const result = await this.request(
        `/videolibrary?page=${page}&perPage=${this.pageSize}`,
      );

      if (!result || !Array.isArray(result.Items)) {
        throw new Error(
          `Unexpected library response on page ${page}.`,
        );
      }

      libraries.push(...result.Items);

      this.log(
        `Page ${page}: fetched ${result.Items.length} libraries.`,
      );

      if (result.HasMoreItems !== true) {
        break;
      }

      page++;
    }

    // Prevent accidentally processing duplicate IDs.
    const uniqueLibraries = [
      ...new Map(
        libraries.map((library) => [
          String(library.Id),
          library,
        ]),
      ).values(),
    ];

    this.summary.librariesFound = uniqueLibraries.length;

    this.log(
      `Found ${uniqueLibraries.length} unique libraries.`,
    );

    return uniqueLibraries;
  }

  /**
   * Updates one library setting.
   * Every call is independent, so a failure does not block
   * the next setting.
   */
  async updateSetting(library, setting, value, label) {
    const libraryId = library.Id;
    const libraryName = library.Name ?? "Unnamed library";

    this.log(
      `[${libraryId} | ${libraryName}] Starting: ${label}`,
    );

    try {
      await this.request(`/videolibrary/${libraryId}`, {
        method: "POST",
        body: JSON.stringify({
          [setting]: value,
        }),
      });

      this.summary[label].success++;

      this.log(
        `[${libraryId}] SUCCESS: ${label}`,
      );

      return true;
    } catch (error) {
      this.summary[label].failed++;

      this.logError(
        `[${libraryId} | ${libraryName}] ${label} failed`,
        error,
      );

      return false;
    }
  }

  /**
   * Required order:
   * 1. Premium encoding
   * 2. Disable DRM
   * 3. Enable JIT
   */
  async processLibrary(library) {
    const libraryId = library.Id;
    const libraryName = library.Name ?? "Unnamed library";

    this.log(
      `\n========== Processing library ${libraryId}: ` +
      `${libraryName} ==========`,
    );

    try {
      // Step 1: Enable premium encoding.
      await this.updateSetting(
        library,
        "EncodingTier",
        1,
        "premiumEncoding",
      );

      // Step 2: Disable DRM, regardless of step 1's result.
      await this.updateSetting(
        library,
        "EnableDRM",
        false,
        "drmDisabled",
      );

      // Step 3: Enable JIT, regardless of earlier failures.
      // Bunny requires premium encoding for JIT.
      await this.updateSetting(
        library,
        "JitEncodingEnabled",
        true,
        "jitEnabled",
      );
    } finally {
      this.summary.librariesProcessed++;

      this.log(
        `========== Finished library ${libraryId} ==========`,
      );
    }
  }

  printSummary() {
    console.log("\n");
    console.log("========================================");
    console.log(" BUNNY STREAM MIGRATION SUMMARY");
    console.log("========================================");
    console.log(
      `Libraries found: ${this.summary.librariesFound}`,
    );
    console.log(
      `Libraries processed: ${this.summary.librariesProcessed}`,
    );
    console.log(
      `Premium encoding: ${this.summary.premiumEncoding.success} succeeded, ` +
      `${this.summary.premiumEncoding.failed} failed`,
    );
    console.log(
      `DRM disabled: ${this.summary.drmDisabled.success} succeeded, ` +
      `${this.summary.drmDisabled.failed} failed`,
    );
    console.log(
      `JIT enabled: ${this.summary.jitEnabled.success} succeeded, ` +
      `${this.summary.jitEnabled.failed} failed`,
    );
    console.log(
      `Library processing errors: ${this.summary.libraryErrors}`,
    );
    console.log("========================================");
  }

  async run() {
    let libraries;

    try {
      libraries = await this.getAllLibraries();
    } catch (error) {
      this.logError("Unable to fetch libraries", error);
      throw error;
    }

    // Sequential processing is intentional.
    // Do not replace this with Promise.all().
    for (const library of libraries) {
      try {
        await this.processLibrary(library);
      } catch (error) {
        this.summary.libraryErrors++;

        this.logError(
          `Unexpected error processing library ${library.Id}`,
          error,
        );
      }
    }

    this.printSummary();

    const failedUpdates =
      this.summary.premiumEncoding.failed +
      this.summary.drmDisabled.failed +
      this.summary.jitEnabled.failed +
      this.summary.libraryErrors;

    if (failedUpdates > 0) {
      this.log(
        "Migration finished with errors. Review the logs before retrying.",
      );
      process.exitCode = 1;
    } else {
      this.log("Migration completed successfully.");
    }
  }
}

const migration = new BunnyStreamMigration();

migration.run().catch((error) => {
  console.error("Fatal migration error:", error.message);
  process.exitCode = 1;
});