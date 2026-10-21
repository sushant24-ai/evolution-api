# Native Azure Blob Storage

Opt in with:
```dotenv
MEDIA_STORAGE_PROVIDER=azure
AZURE_BLOB_ACCOUNT_NAME=<storage-account-name>
AZURE_BLOB_CONTAINER=evolution-media
AZURE_BLOB_ENDPOINT=https://<storage-account-name>.blob.core.windows.net
AZURE_BLOB_SAVE_VIDEO=true
```

The provider uses `DefaultAzureCredential`; in Azure Container Apps enable a system- or user-assigned managed identity. Grant it `Storage Blob Data Contributor` and `Storage Blob Delegator` on the storage account (or an appropriately scoped pre-provisioned container). Keep anonymous container access disabled.

For private endpoints, configure private DNS and network routing and confirm every consumer of generated media URLs can reach the resulting Blob endpoint. A user-delegation SAS is a bearer credential: this code creates read-only HTTPS links and caps their expiry at the delegation key lifetime (under seven days by default). Store blob names as durable references and generate fresh links when needed.

Run `npm run test:azure-storage-smoke` for mocked adapter tests. This is not a live Azure E2E test. Before production, regenerate the lockfile, run `npm ci`, `npm run build`, `npm run lint:check`, and integration-test actual Blob upload/retrieval, private networking, and S3 regression behavior.
